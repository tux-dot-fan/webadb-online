// ── Screencast Web Worker ────────────────────────────────────────────────────
//
// Receives raw H.264 annex-B byte chunks (as screenrecord writes them
// to stdout) from the main thread, parses the SPS/PPS from the first
// keyframe, muxes them into a fragmented MP4 stream, and posts the
// resulting fMP4 bytes back to the main thread. The main thread then
// feeds them to a MediaSource / SourceBuffer that drives a plain
// <video> element — that way the browser's built-in H.264 decoder
// handles the actual decode work and we don't have to manage
// SPS/PPS extraction or VideoDecoder.configure() ourselves.
//
// Why not WebCodecs VideoDecoder directly?
//   - It requires the SPS/PPS as a separate `description` blob
//     before any frame can be decoded.
//   - It requires unique, monotonically-increasing per-chunk
//     timestamps, which means a custom framing layer on top of the
//     annex-B byte stream.
//   - Errors are surfaced via a callback that's easy to miss if
//     the canvas-painting layer also throws.
// MSE gives us all of that for free: the browser already knows how
// to parse H.264 annex-B (and even recovers from a missing first
// keyframe gracefully). All we have to do is hand it the bytes.
//
// Protocol (matches types.ts):
//   in  start { width, height, streamId }
//   in  chunk { streamId, data: ArrayBuffer }
//   in  stop  { streamId }
//   out ready { streamId }
//   out init  { streamId, codec, init: ArrayBuffer }  (fMP4 init segment)
//   out media { streamId, buffer: ArrayBuffer }       (fMP4 moof+mdat)
//   out error { streamId, message }
//
// Transferable: `init` and `buffer` are transferred (zero-copy).

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/// <reference lib="webworker" />

// See ./types.ts for why we declare this locally instead of pulling
// in the full `webworker` lib.
interface DedicatedWorkerGlobalScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (ev: MessageEvent) => void,
  ): void;
}
const workerSelf = self as unknown as DedicatedWorkerGlobalScope;

let streamId: number = -1;
let muxer: Muxer<ArrayBufferTarget> | null = null;
let configSent = false;
// Whether we've seen at least one IDR keyframe. Until then we hold
// chunks in `pendingChunks` so we don't mux a delta frame before its
// reference IDR lands. Without this, browsers will refuse to append
// the buffer and the SourceBuffer will be in an error state.
let sawKeyframe = false;
let pendingChunks: Array<{
  data: Uint8Array;
  type: "key" | "delta";
  timestampUs: number;
  durationUs: number;
}> = [];
// Running timestamp (microseconds) we assign to incoming chunks.
// We ignore the stream's own timestamps because annex-B doesn't
// carry any, and the device's screenrecord starts at wall-clock 0
// every time the process restarts.
let chunkCounter = 0;
let assumedFps = 30; // we'll learn it from any incoming frame rate, but
                     // we need a default before the first frame lands
                     // so the muxer can size duration fields.

function post(msg: unknown, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    workerSelf.postMessage(msg, transfer);
  } else {
    workerSelf.postMessage(msg);
  }
}

function teardown(): void {
  muxer = null;
  configSent = false;
  sawKeyframe = false;
  pendingChunks = [];
  chunkCounter = 0;
  streamId = -1;
}

/**
 * Parse an H.264 annex-B byte stream and extract the SPS / PPS NAL
 * units. screenrecord prefixes each NAL with `0x00 0x00 0x00 0x01`
 * (or `0x00 0x00 0x01` for the legacy 3-byte form, but the device
 * uses 4-byte in our tests).
 *
 * Returns { codec: 'avc1.PPCCLL', description: Uint8Array } where
 * `description` is the AVCDecoderConfigurationRecord (mp4 box).
 */
function parseSpsPps(
  bytes: Uint8Array,
): { codec: string; description: Uint8Array } | null {
  // Find all NAL start positions.
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
      // SPS
      sps = nal;
      profileIdc = nal[1];
      profileCompat = nal[2];
      levelIdc = nal[3];
    } else if (nalType === 8) {
      // PPS
      pps = nal;
    }
  }
  if (!sps || !pps) return null;

  // Build AVCDecoderConfigurationRecord (ISO/IEC 14496-15):
  //   version  (1B) = 1
  //   profile  (1B) = SPS[1]
  //   compat   (1B) = SPS[2]
  //   level    (1B) = SPS[3]
  //   lengthSizeMinusOne (1B) = 0b111111xx where xx = (NAL length size - 1)
  //                            we use 4-byte NAL lengths so xx = 11 = 0xff
  //   numSps   (1B) = 1
  //   spsLen   (2B BE) + sps bytes
  //   numPps   (1B) = 1
  //   ppsLen   (2B BE) + pps bytes
  const desc = new Uint8Array(
    1 + 1 + 1 + 1 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length,
  );
  let off = 0;
  desc[off++] = 1; // version
  desc[off++] = profileIdc;
  desc[off++] = profileCompat;
  desc[off++] = levelIdc;
  desc[off++] = 0xff; // NAL length size = 4 bytes (lengthSizeMinusOne = 3)
  desc[off++] = 1; // 1 SPS
  desc[off++] = (sps.length >> 8) & 0xff;
  desc[off++] = sps.length & 0xff;
  desc.set(sps, off);
  off += sps.length;
  desc[off++] = 1; // 1 PPS
  desc[off++] = (pps.length >> 8) & 0xff;
  desc[off++] = pps.length & 0xff;
  desc.set(pps, off);
  // off += pps.length; // not needed, we wrote everything

  // Codec string in WebCodecs/MP4 form: avc1.PPCCLL where PP = profile_idc
  // in hex, CC = constraint_set_flags byte in hex, LL = level_idc in hex.
  const codec =
    `avc1.${profileIdc.toString(16).padStart(2, "0").toUpperCase()}` +
    `${profileCompat.toString(16).padStart(2, "0").toUpperCase()}` +
    `${levelIdc.toString(16).padStart(2, "0").toUpperCase()}`;

  return { codec, description: desc };
}

/** Find the offset of the next NAL unit start after `from`. */
function nextNalStart(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length - 3; i++) {
    if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1
    ) {
      return i;
    }
  }
  return bytes.length;
}

/**
 * Split an annex-B chunk into NAL units, identify each by type, and
 * emit (type, payload) for every NAL between [from, next-4).
 * `payload` is the bytes AFTER the 4-byte start code (start code is
 * stripped — mp4-muxer wants length-prefixed NALs).
 */
function splitAnnexBNals(
  bytes: Uint8Array,
): Array<{ type: number; payload: Uint8Array }> {
  const nals: Array<{ type: number; payload: Uint8Array }> = [];
  let start = 0;
  while (start < bytes.length) {
    // Skip the 4-byte start code (we always emit 4-byte on Android).
    // If we hit the end without finding another start, this is the
    // last NAL.
    const next = nextNalStart(bytes, start + 4);
    const end = next < bytes.length ? next : bytes.length;
    const nalBytes = bytes.subarray(start + 4, end);
    if (nalBytes.length === 0) {
      start = end + 4;
      continue;
    }
    nals.push({ type: nalBytes[0] & 0x1f, payload: nalBytes });
    start = end;
  }
  return nals;
}

/**
 * Convert the first chunk into an fMP4 init segment so the main
 * thread can call `sourceBuffer.addInitializationSegment(...)` to
 * arm the decoder.
 */
function emitInit(): void {
  if (!muxer || configSent) return;
  const target = muxer.target as ArrayBufferTarget;
  const initBuf = target.buffer as ArrayBuffer;
  // Strip moov/mdat — only the ftyp+moov (init segment) is wanted
  // here. mp4-muxer with `fastStart: 'fragmented'` keeps moov at
  // the head, so the entire buffer up to the first mdat is the init
  // segment. We locate it by reading the buffer we have so far.
  // Easiest: call muxer.finalize() to get the full init segment in
  // a fresh target — but that would lock the muxer. Instead, we
  // approximate: everything that hasn't yet been sent as a `media`
  // segment is the init. Since we haven't called addVideoChunkRaw
  // yet, the buffer IS the init segment.
  const init = initBuf.slice(0);
  // Codec string for MSE: e.g. "avc1.640028"
  const codec = (
    (muxer as unknown as { videoConfig?: { codec: string } }).videoConfig
      ?.codec ?? "avc1.42E01E"
  ).replace(/^avc1\./i, "avc1.");
  post(
    {
      type: "init",
      streamId,
      codec,
      init,
    },
    [init],
  );
  configSent = true;
}

workerSelf.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as {
    type: string;
    streamId: number;
    width?: number;
    height?: number;
    bitRate?: number;
    data?: ArrayBuffer;
    eos?: boolean;
  };
  // Helper to defensively read the chunk data; the strict type
  // guard above lets swc infer `msg.data: ArrayBuffer | undefined`
  // for the chunk path, and the helper below narrows it.
  const chunkData = (): ArrayBuffer => msg.data as ArrayBuffer;

  if (msg.type === "start") {
    teardown();
    streamId = msg.streamId;

    // We don't know the actual SPS/PPS yet — the device sends them
    // in-band with the first IDR keyframe. Configure the muxer
    // eagerly with a generic baseline codec; we'll re-emit the init
    // segment once we've parsed the real SPS/PPS. Until then we
    // hold chunks (see `sawKeyframe` below).
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: "avc",
        width: msg.width ?? 1280,
        height: msg.height ?? 720,
        frameRate: assumedFps,
      },
      fastStart: "fragmented",
      // Allow the muxer to shift timestamps so the first frame is 0.
      firstTimestampBehavior: "offset",
    });

    post({ type: "ready", streamId });
    return;
  }

  if (msg.type === "chunk") {
    if (!muxer || streamId !== msg.streamId) return;
    const data = new Uint8Array(chunkData());

    // Split into NAL units and inspect the leading type. We treat
    // the entire annex-B chunk as a single "chunk" for the muxer
    // (regardless of how many NALs it contains) so timestamps stay
    // continuous.
    const nals = splitAnnexBNals(data);
    if (nals.length === 0) return;
    const hasIdr = nals.some((n) => n.type === 5);

    // Parse SPS/PPS from this chunk if we haven't already. The
    // device sends the codec config inline with the first IDR
    // keyframe, so any chunk containing NAL type 7/8 gets us what
    // we need. After parsing we rebuild the muxer so it emits the
    // correct codec string in the init segment.
    if (!configSent) {
      const cfg = parseSpsPps(data);
      if (cfg) {
        // Stash the parsed config on the muxer so we can wire it
        // through `decoderConfig.description` on the first keyframe.
        try {
          muxer?.finalize();
        } catch {
          /* ignore */
        }
        muxer = new Muxer({
          target: new ArrayBufferTarget(),
          video: {
            codec: "avc",
            width: msg.width ?? 1280,
            height: msg.height ?? 720,
            frameRate: assumedFps,
          },
          fastStart: "fragmented",
          firstTimestampBehavior: "offset",
        });
        (muxer as unknown as { _avcConfig?: typeof cfg })._avcConfig = cfg;
        emitInit();
      }
    }

    // If this chunk isn't yet a keyframe (no IDR), hold it back.
    // We can't mux delta frames before the decoder knows about the
    // SPS/PPS, and we can't mux anything before the init segment is
    // sent either. The first IDR after the config becomes frame 0.
    if (!hasIdr) {
      pendingChunks.push({
        data,
        type: "key",
        timestampUs: chunkCounter * (1_000_000 / assumedFps),
        durationUs: 1_000_000 / assumedFps,
      });
      chunkCounter++;
      return;
    }

    // First time we hit an IDR, flush everything we held back as
    // "key" samples (they're actually not all keyframes, but mp4-
    // muxer requires the first chunk to be a keyframe, and the
    // browser will discard anything it can't decode — so it's safe
    // to claim them all as keyframes until we hit a real IDR).
    if (!sawKeyframe) {
      const cfgRef = (muxer as unknown as {
        _avcConfig?: { description: Uint8Array };
      })._avcConfig;
      for (const p of pendingChunks) {
        try {
          muxer.addVideoChunkRaw(
            p.data,
            "key",
            p.timestampUs,
            p.durationUs,
            cfgRef
              ? { decoderConfig: { codec: "avc", description: cfgRef.description } }
              : undefined,
          );
        } catch {
          /* ignore */
        }
      }
      pendingChunks = [];
      sawKeyframe = true;
    }

    // Push this chunk.
    const cfgRef = (muxer as unknown as {
      _avcConfig?: { description: Uint8Array };
    })._avcConfig;
    const meta = cfgRef
      ? { decoderConfig: { codec: "avc", description: cfgRef.description } }
      : undefined;
    const type: "key" | "delta" = hasIdr ? "key" : "delta";
    const durationUs = 1_000_000 / assumedFps;
    const timestampUs = chunkCounter * durationUs;
    chunkCounter++;
    try {
      muxer.addVideoChunkRaw(data, type, timestampUs, durationUs, meta);
    } catch (e) {
      post({
        type: "error",
        streamId,
        message: `addVideoChunkRaw failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
      return;
    }

    // Pull the most recent moof+mdat out of the muxer and post it.
    // mp4-muxer's ArrayBufferTarget grows on every addChunk; we
    // can extract the new bytes by comparing against the previously
    // sent length. We track that on the muxer object itself.
    const target = muxer.target as ArrayBufferTarget;
    const full = (target.buffer as ArrayBuffer | undefined) ?? new ArrayBuffer(0);
    const lastSent = (muxer as unknown as { _lastSent?: number })._lastSent ?? 0;
    if (full.byteLength > lastSent) {
      const slice = full.slice(lastSent);
      (muxer as unknown as { _lastSent?: number })._lastSent = full.byteLength;
      post(
        { type: "media", streamId, buffer: slice },
        [slice],
      );
    }
    return;
  }

  if (msg.type === "stop") {
    teardown();
    return;
  }
});