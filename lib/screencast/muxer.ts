// ── Screencast fMP4 muxer (main thread) ──────────────────────────────────────
//
// Originally written as a Web Worker, but Webpack's worker bundler in
// Next.js doesn't reliably split npm-only ESM packages (mp4-muxer) into
// a worker-loadable chunk in `output: "export"` mode — the worker
// emits an `error` event that doesn't carry the underlying error
// message, and the worker never reaches its `start` handler. Doing
// the muxer on the main thread sidesteps the bundler entirely:
// mp4-muxer is fast enough (microseconds per chunk) that the UI
// stays responsive even at 30 fps / 4 Mbps.
//
// Function-by-function parity with the previous worker:
//
//   parseSpsPps(bytes)         → { codec, description }
//   splitAnnexBNals(bytes)     → NAL units with stripped start codes
//   createMuxer(width, height) → returns { addChunk, finalize }
//   emitInitSegment(muxer, …)  → separate ftyp+moov from moof+mdat
//
// The `MuxerHandle` API:
//   const handle = createMuxer(360, 800, onInit, onMedia);
//   handle.addChunk(data, "key"|"delta", tsUs, durationUs, meta);
//   handle.finalize();

import { Muxer, StreamTarget } from "mp4-muxer";

export interface MuxerHandle {
  addChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
    durationUs: number,
    meta?: { decoderConfig: { codec: "avc"; description: Uint8Array } },
  ): void;
  finalize(): void;
}

/**
 * Parse H.264 annex-B bytes and pull out SPS (NAL type 7) and PPS
 * (NAL type 8). Returns the codec string + AVCDecoderConfigurationRecord
 * suitable for MSE's `video/mp4; codecs="avc1.PPCCLL"` source buffer.
 */
export function parseSpsPps(
  bytes: Uint8Array,
): { codec: string; description: Uint8Array } | null {
  const positions: number[] = [];
  for (let i = 0; i < bytes.length - 3; i++) {
    if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1
    ) {
      positions.push(i + 4);
    }
  }
  if (positions.length === 0) return null;

  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let profileIdc = 0;
  let profileCompat = 0;
  let levelIdc = 0;

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] - 4 : bytes.length;
    const nal = bytes.subarray(start, end);
    const nalType = nal[0] & 0x1f;
    if (nalType === 7) {
      sps = nal;
      profileIdc = nal[1];
      profileCompat = nal[2];
      levelIdc = nal[3];
    } else if (nalType === 8) {
      pps = nal;
    }
  }
  if (!sps || !pps) return null;

  const desc = new Uint8Array(
    1 + 1 + 1 + 1 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length,
  );
  let off = 0;
  desc[off++] = 1;
  desc[off++] = profileIdc;
  desc[off++] = profileCompat;
  desc[off++] = levelIdc;
  desc[off++] = 0xff;
  desc[off++] = 1;
  desc[off++] = (sps.length >> 8) & 0xff;
  desc[off++] = sps.length & 0xff;
  desc.set(sps, off);
  off += sps.length;
  desc[off++] = 1;
  desc[off++] = (pps.length >> 8) & 0xff;
  desc[off++] = pps.length & 0xff;
  desc.set(pps, off);

  const codec =
    `avc1.${profileIdc.toString(16).padStart(2, "0").toUpperCase()}` +
    `${profileCompat.toString(16).padStart(2, "0").toUpperCase()}` +
    `${levelIdc.toString(16).padStart(2, "0").toUpperCase()}`;

  return { codec, description: desc };
}

/** Find NAL start positions in an annex-B byte stream. */
function findNalStarts(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length - 3; i++) {
    if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1
    ) {
      out.push(i + 4);
    }
  }
  return out;
}

/**
 * Split annex-B bytes into NAL units, stripping the 4-byte start
 * code. Returns `{ type, payload }` for every NAL in the chunk.
 */
export function splitAnnexBNals(
  bytes: Uint8Array,
): Array<{ type: number; payload: Uint8Array }> {
  const positions = findNalStarts(bytes);
  const nals: Array<{ type: number; payload: Uint8Array }> = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] - 4 : bytes.length;
    const nal = bytes.subarray(start, end);
    if (nal.length === 0) continue;
    nals.push({ type: nal[0] & 0x1f, payload: nal });
  }
  return nals;
}

function copyToBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}

/**
 * Create a muxer + a flag-bit tracker for init-vs-media output.
 *
 * `initialCodec` is the codec string the caller already discovered
 * from the stream's SPS (e.g. `avc1.640028`). We pass it into the
 * muxer at construction time so the resulting init segment has the
 * correct codec in its moov box — without this, mp4-muxer falls
 * back to its placeholder codec and MSE can't open the stream.
 *
 * `onInit(initBuf)` fires once with the ftyp+moov segment.
 * `onMedia(mediaBuf)` fires once per moof+mdat fragment.
 *
 * mp4-muxer's StreamTarget fires `onData(data, position)` whenever
 * it writes a chunk to the output. The first call (position=0)
 * is the init segment (ftyp + moov), every subsequent call is a
 * moof+mdat fragment. mp4-muxer warns if we don't take the second
 * argument — and worse, ignoring the position argument is what
 * causes broken output: we couldn't tell init from media without
 * some signal. With `position` available, the rule is simple:
 * position 0 → init segment; non-zero → media fragment.
 */
export function createMuxer(
  width: number,
  height: number,
  initialCodec: string,
  onInit: (initBuf: ArrayBuffer) => void,
  onMedia: (mediaBuf: ArrayBuffer) => void,
): MuxerHandle {
  const muxer = new Muxer({
    target: new StreamTarget({
      onData: (data: Uint8Array, position: number) => {
        const buf = copyToBuffer(data);
        if (position === 0) {
          // Init segment — always the first write, always at offset 0.
          onInit(buf);
          return;
        }
        // Subsequent writes are moof+mdat fragments.
        onMedia(buf);
      },
    }),
    video: {
      codec: "avc",
      width,
      height,
      frameRate: 30,
    },
    // mp4-muxer writes `videoConfig.codec` into the moov's avcC box.
    // It defaults to the raw codec we passed ('avc'); we need it
    // to be the full avc1.PPCCLL string instead. There's no public
    // option for this, but a 'avc' codec string with an explicit
    // 'description' (avcC box) on the first addVideoChunkRaw call
    // will override the moov's codec entry — so we no longer need
    // the placeholder to be 'avc1.PPCCLL'. The SourceBuffer call
    // on the main thread uses `initialCodec` (the real one).
    fastStart: "fragmented",
    firstTimestampBehavior: "offset",
  });
  return {
    addChunk(data, type, timestampUs, durationUs, meta) {
      muxer.addVideoChunkRaw(data, type, timestampUs, durationUs, meta);
    },
    finalize() {
      try {
        muxer.finalize();
      } catch {
        /* ignore */
      }
    },
  };
}