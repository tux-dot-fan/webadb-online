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
 * `onInit(initBuf)` fires once with the ftyp+moov segment.
 * `onMedia(mediaBuf)` fires once per moof+mdat fragment.
 */
export function createMuxer(
  width: number,
  height: number,
  onInit: (initBuf: ArrayBuffer, codec: string) => void,
  onMedia: (mediaBuf: ArrayBuffer) => void,
): MuxerHandle {
  let cachedCodec = "avc1.42E01E";
  let initSent = false;
  const muxer = new Muxer({
    target: new StreamTarget({
      onData: (data: Uint8Array) => {
        const buf = copyToBuffer(data);
        if (!initSent) {
          initSent = true;
          onInit(buf, cachedCodec);
          return;
        }
        onMedia(buf);
      },
    }),
    video: {
      codec: "avc",
      width,
      height,
      frameRate: 30,
    },
    fastStart: "fragmented",
    firstTimestampBehavior: "offset",
  });
  return {
    addChunk(data, type, timestampUs, durationUs, meta) {
      // Stash the codec from the SPS/PPS description so onInit()
      // can pass it to the main thread.
      if (meta?.decoderConfig?.description) {
        const d = meta.decoderConfig.description;
        // First byte of AVCDecoderConfigurationRecord is the
        // version (1); byte[1] is profile_idc; byte[2] is
        // constraint flags; byte[3] is level_idc. (Same fields we
        // wrote into it from parseSpsPps.)
        if (d.byteLength >= 4) {
          const profileIdc = d[1];
          const profileCompat = d[2];
          const levelIdc = d[3];
          cachedCodec =
            `avc1.${profileIdc.toString(16).padStart(2, "0").toUpperCase()}` +
            `${profileCompat.toString(16).padStart(2, "0").toUpperCase()}` +
            `${levelIdc.toString(16).padStart(2, "0").toUpperCase()}`;
        }
      }
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