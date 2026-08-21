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

/**
 * Create a muxer that demuxes its own output into init segments
 * (ftyp + moov) and per-fragment media segments (moof + mdat).
 *
 * Background: with `fastStart: "fragmented"`, mp4-muxer fires
 * `onData` three different ways across a stream's lifetime:
 *
 *   1. From the constructor's _writeHeader: just the ftyp box.
 *   2. From the first fragment's finalization: moov + moof + mdat
 *      written as one contiguous block.
 *   3. From every subsequent fragment's finalization: just moof + mdat.
 *
 * The naive `position === 0` heuristic fails because ftyp is also
 * at position 0 — so we'd send the 28-byte ftyp as the init segment
 * and treat the moov that arrives at position 28 as a media chunk.
 * MSE then chokes on a half-baked init.
 *
 * What we actually want: deliver everything BEFORE the first moof
 * as one init segment, then everything else as media segments.
 * We detect the first moof by scanning for the 'moof' fourcc at
 * every onData payload's start — that's how we know the boundary.
 */
export function createMuxer(
  width: number,
  height: number,
  initialCodec: string,
  onInit: (initBuf: ArrayBuffer) => void,
  onMedia: (mediaBuf: ArrayBuffer) => void,
): MuxerHandle {
  // Concatenate all init-segment chunks (ftyp then moov) into one
  // ArrayBuffer we hand off once the first moof arrives.
  const initChunks: Uint8Array[] = [];
  let initByteLength = 0;
  let initSent = false;
  // We have to hold init chunks in their own buffers because mp4-
  // muxer reuses its underlying ArrayBuffer across onData calls.

  const flushInit = (): void => {
    if (initSent || initChunks.length === 0) return;
    initSent = true;
    const out = new ArrayBuffer(initByteLength);
    const view = new Uint8Array(out);
    let off = 0;
    for (const chunk of initChunks) {
      view.set(chunk, off);
      off += chunk.byteLength;
    }
    initChunks.length = 0;
    onInit(out);
  };

  const muxer = new Muxer({
    target: new StreamTarget({
      onData: (data: Uint8Array, _position: number) => {
        // Detect the first moof — start-of-payload is the 'moof'
        // fourcc (0x6d 0x6f 0x6f 0x66) inside a box header. We
        // check positions 4..7 because bytes 0..3 are the box
        // size (32-bit big-endian) and the fourcc lives at 4..7.
        // (ftyp and moov are not moof.)
        const startsWithMoof =
          data.byteLength >= 8 &&
          data[4] === 0x6d /* m */ &&
          data[5] === 0x6f /* o */ &&
          data[6] === 0x6f /* o */ &&
          data[7] === 0x66 /* f */;

        if (!initSent && !startsWithMoof) {
          // Still part of the init segment. Buffer until we see
          // the first moof.
          const copy = new Uint8Array(data.byteLength);
          copy.set(data);
          initByteLength += copy.byteLength;
          initChunks.push(copy);
          return;
        }

        if (!initSent && startsWithMoof) {
          // The moof is starting now. Any previously-buffered init
          // bytes (ftyp + moov) become the init segment; this
          // payload is the first media fragment.
          flushInit();
          const copy = new Uint8Array(data.byteLength);
          copy.set(data);
          onMedia(copyToBuffer(copy));
          return;
        }

        // Past the init segment — every subsequent onData is a
        // moof+mdat media fragment.
        onMedia(copyToBuffer(data));
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
      muxer.addVideoChunkRaw(data, type, timestampUs, durationUs, meta);
      // mp4-muxer only emits onData when it finalizes a fragment,
      // which by default waits for ≥1 second of samples to accu-
      // mulate. For live streaming we want each chunk's ftyp+moov
      // +moof+mdat to land on the main thread within a few ms of
      // being muxed. Force-flush the streaming writer after every
      // chunk by reaching into mp4-muxer's private state. There's
      // no public API for "flush now" in mp4-muxer 5.x; the only
      // public way to emit is to call finalize() which locks the
      // muxer. Hack: call _finalizeFragment(false) + _writer.flush()
      // via the private symbol keys.
      const internal = muxer as unknown as {
        _finalizeFragment?: (arg: boolean) => void;
        _writer?: { flush: () => void };
      };
      try {
        internal._finalizeFragment?.(false);
      } catch {
        /* _finalizeFragment throws if no currentChunk yet — fine */
      }
      try {
        internal._writer?.flush();
      } catch {
        /* ignore */
      }
    },
    finalize() {
      try {
        muxer.finalize();
        flushInit();
      } catch {
        /* ignore */
      }
    },
  };
}

function copyToBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}