// ── Screencast pipeline (main thread) ────────────────────────────────────────
//
// Glue between `session.adb.subprocess.shellProtocol` (the underlying
// ya-webadb API that panels get via the AppProps.session prop) and
// the MediaSource / SourceBuffer pair that drives the panel's
// `<video>` element.
//
// Architecture:
//
//   device ─adb shell screenrecord─> stdout chunks
//        ─streamed─> main thread reader
//        ─passed─> muxer.addVideoChunkRaw (mp4-muxer fMP4)
//        ─init segment─> SourceBuffer.addSourceBuffer + appendBuffer
//        ─media fragments─> SourceBuffer.appendBuffer
//        ─decoded H.264─> <video> element
//        ─user clicks <video>─> `adb shell input tap`
//
// The original implementation used a Web Worker for muxing, but the
// Next.js worker bundler doesn't reliably include npm-only ESM
// packages (mp4-muxer) in the worker chunk in `output: "export"`
// mode — the worker emits a useless `error` event with no message
// and never reaches its `start` handler. mp4-muxer is fast enough
// (μs per chunk) that running it on the main thread doesn't impact
// UI responsiveness.

import type { AdbSession } from "@/lib/adb-client";
import type { ProgressKind } from "./types";
import {
  parseSpsPps,
  splitAnnexBNals,
  createMuxer,
  type MuxerHandle,
} from "./muxer";

// All console output is prefixed with [screencast] so it can be
// filtered easily in DevTools.
const TAG = "[screencast]";

/** Bitrate (in bits/second) at the device's native resolution. */
const NATIVE_BITRATE = 4_000_000;
const MIN_BITRATE = 200_000;
const MAX_BITRATE = 8_000_000;

export interface PipelineHandle {
  bitrate: number;
  encodedWidth: number;
  encodedHeight: number;
  stop(): void;
}

const ASSUMED_FPS = 30;

export async function startScreencast(
  session: AdbSession,
  opts: {
    videoEl: HTMLVideoElement;
    panelWidth: number;
    panelHeight: number;
    devicePixelRatio: number;
    devicePhysical: { width: number; height: number };
    devicePpi: number;
    onError: (message: string) => void;
    onReady?: () => void;
    onProgress?: (kind: ProgressKind, detail?: string) => void;
  },
): Promise<PipelineHandle> {
  const aspect = opts.devicePhysical.height / opts.devicePhysical.width;
  let encodedWidth = Math.max(360, Math.round(opts.panelWidth));
  let encodedHeight = Math.max(
    Math.round(360 * aspect),
    Math.round(encodedWidth * aspect),
  );
  encodedWidth = encodedWidth & ~1;
  encodedHeight = encodedHeight & ~1;

  const nativeArea = opts.devicePhysical.width * opts.devicePhysical.height;
  const panelArea = encodedWidth * encodedHeight;
  const ppiFactor = Math.max(0.4, Math.min(1.0, opts.devicePpi / 440));
  const bitrate = Math.max(
    MIN_BITRATE,
    Math.min(
      MAX_BITRATE,
      Math.round((NATIVE_BITRATE * (panelArea / nativeArea)) * ppiFactor),
    ),
  );

  // ── 1. <video> + MediaSource + SourceBuffer setup ────────────────────────
  const videoEl = opts.videoEl;
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;

  const mediaSource = new MediaSource();
  console.log(TAG, "MediaSource created, initial state:", mediaSource.readyState);
  const objectUrl = URL.createObjectURL(mediaSource);
  videoEl.src = objectUrl;
  console.log(TAG, "video.src set, video dimensions:", videoEl.clientWidth, "x", videoEl.clientHeight);

  let sourceBuffer: SourceBuffer | null = null;
  const pendingMedia: ArrayBuffer[] = [];
  const sourceOpenPromise = new Promise<void>((resolve) => {
    if (mediaSource.readyState === "open") {
      resolve();
      return;
    }
    mediaSource.addEventListener("sourceopen", () => {
      console.log(TAG, "MediaSource sourceopen event fired, readyState:", mediaSource.readyState);
      resolve();
    });
    mediaSource.addEventListener("sourceended", () => {
      console.log(TAG, "MediaSource sourceended");
    });
    mediaSource.addEventListener("sourceclose", () => {
      console.log(TAG, "MediaSource sourceclose");
    });
    mediaSource.addEventListener("error", (ev) => {
      console.error(TAG, "MediaSource error event", ev, "readyState:", mediaSource.readyState);
      opts.onError(`MediaSource error: ${mediaSource.readyState}`);
    });
  });

  const appendBuffer = (buf: ArrayBuffer): void => {
    if (!sourceBuffer) return;
    if (sourceBuffer.updating) {
      sourceBuffer.addEventListener(
        "updateend",
        () => {
          if (
            pendingMedia.length > 0 &&
            sourceBuffer &&
            !sourceBuffer.updating
          ) {
            const next = pendingMedia.shift()!;
            try {
              sourceBuffer.appendBuffer(next);
            } catch (e) {
              opts.onError(
                `SourceBuffer.appendBuffer failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          }
        },
        { once: true },
      );
    } else {
      try {
        sourceBuffer.appendBuffer(buf);
      } catch (e) {
        opts.onError(
          `SourceBuffer.appendBuffer failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  };

  // ── 2. Muxer setup ───────────────────────────────────────────────────────
  let muxer: MuxerHandle | null = null;
  let pendingChunks: Array<{
    data: Uint8Array;
    type: "key" | "delta";
    timestampUs: number;
    durationUs: number;
    meta?: { decoderConfig: { codec: "avc"; description: Uint8Array } };
  }> = [];
  let configSent = false;
  let sawKeyframe = false;
  let chunkCounter = 0;
  let avcConfig: { description: Uint8Array } | null = null;
  let codec = "avc1.42E01E";

  const createMuxerInstance = (initialCodec: string): MuxerHandle => {
    return createMuxer(
      encodedWidth,
      encodedHeight,
      initialCodec,
      (initBuf) => {
        console.log(TAG, "init segment received, codec:", initialCodec, "bytes:", initBuf.byteLength, "hex-prefix:", new Uint8Array(initBuf, 0, Math.min(8, initBuf.byteLength)));
        sourceOpenPromise.then(() => {
          if (stopRequested) return;
          try {
            sourceBuffer = mediaSource.addSourceBuffer(
              `video/mp4; codecs="${initialCodec}"`,
            );
            console.log(TAG, "addSourceBuffer succeeded, codec:", initialCodec);
          } catch (e) {
            console.error(TAG, "addSourceBuffer FAILED", initialCodec, e);
            opts.onError(
              `addSourceBuffer failed (codec ${initialCodec}): ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
            return;
          }
          sourceBuffer.addEventListener("error", (ev) => {
            console.error(TAG, "SourceBuffer error event", ev);
            opts.onError(
              `SourceBuffer error (updating=${sourceBuffer?.updating})`,
            );
          });
          sourceBuffer.addEventListener("updateend", () => {
            if (sourceBuffer && sourceBuffer.buffered.length > 0) {
              console.log(
                TAG,
                "SourceBuffer updateend, buffered:",
                sourceBuffer.buffered.length,
                "timeRanges:",
                `${sourceBuffer.buffered.start(0).toFixed(2)} - ${sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1).toFixed(2)}`,
              );
            }
          });
          try {
            sourceBuffer.appendBuffer(initBuf);
            console.log(TAG, "init appendBuffer called,", initBuf.byteLength, "bytes");
            opts.onProgress?.("init-sent", initialCodec);
          } catch (e) {
            console.error(TAG, "init appendBuffer FAILED", e);
            opts.onError(
              `init appendBuffer failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
          // Flush any media fragments that arrived while we were
          // waiting for addSourceBuffer to complete.
          while (
            pendingMedia.length > 0 &&
            sourceBuffer &&
            !sourceBuffer.updating
          ) {
            const next = pendingMedia.shift()!;
            try {
              sourceBuffer.appendBuffer(next);
            } catch (e) {
              opts.onError(
                `SourceBuffer.appendBuffer failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          }
        });
      },
      (mediaBuf) => {
        console.log(TAG, "media chunk received,", mediaBuf.byteLength, "bytes, sourceBuffer:", !!sourceBuffer, "pendingMedia.length:", pendingMedia.length);
        if (!sourceBuffer) {
          pendingMedia.push(mediaBuf);
          return;
        }
        appendBuffer(mediaBuf);
        opts.onProgress?.("first-frame", `${mediaBuf.byteLength} bytes`);
        if (videoEl.paused && videoEl.buffered.length > 0) {
          const targetTime =
            videoEl.buffered.end(videoEl.buffered.length - 1) - 0.05;
          if (targetTime > videoEl.currentTime) {
            try {
              videoEl.currentTime = Math.max(0, targetTime);
            } catch {
              /* ignore */
            }
          }
          videoEl.addEventListener(
            "playing",
            () => {
              console.log(TAG, "video.playing event fired");
              opts.onProgress?.("playing");
            },
            { once: true },
          );
          void videoEl.play().catch((e) => {
            console.warn(TAG, "videoEl.play() rejected:", e);
          });
        }
      },
    );
  };

  // ── 3. Spawn screenrecord on the device ──────────────────────────────────
  const shell = session.adb.subprocess.shellProtocol;
  if (!shell || !shell.isSupported) {
    URL.revokeObjectURL(objectUrl);
    throw new Error("Device doesn't support Shell V2 protocol");
  }

  opts.onProgress?.(
    "spawning",
    `${encodedWidth}×${encodedHeight} @ ${(bitrate / 1_000).toFixed(0)} kbps`,
  );
  console.log(TAG, "spawning screenrecord", { width: encodedWidth, height: encodedHeight, bitrate });

  let stopRequested = false;
  let killFn: (() => void) | null = null;

  const timeLimit = 180;
  const proc = await shell.spawn([
    "screenrecord",
    "--output-format=h264",
    "--size", `${encodedWidth}x${encodedHeight}`,
    "--bit-rate", String(Math.max(200_000, bitrate | 0)),
    "--time-limit", String(timeLimit),
    "-",
  ]);
  console.log(TAG, "screenrecord spawned, getting stdout reader");
  opts.onProgress?.("screenrecord-started");
  killFn = () => {
    try { void proc.kill(); } catch { /* ignore */ }
  };

  muxer = createMuxerInstance("avc1.42E01E");

  // Worker-equivalent "ready" event — let the panel switch to
  // "running" once we know the pipeline is set up (muxer ready,
  // first chunk may still be a few seconds away).
  opts.onReady?.();

  // ── 4. Pump stdout → muxer chunks ───────────────────────────────────────
  const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
  console.log(TAG, "stdout reader acquired, starting read loop");
  let chunksPosted = 0;
  let bytesPosted = 0;
  (async () => {
    try {
      while (!stopRequested) {
        const { value, done } = await reader.read();
        if (done) {
          console.log(TAG, "stdout done, chunks posted:", chunksPosted, "bytes:", bytesPosted);
          break;
        }
        if (!value || value.byteLength === 0) continue;
        // Copy bytes into a fresh ArrayBuffer — ReadableStream chunk
        // backing buffers can be reused between reads, so slicing
        // `value.buffer` at `value.byteOffset`/`byteLength` can race
        // the stream and yield an empty buffer for any chunk after
        // the first.
        const buf = new ArrayBuffer(value.byteLength);
        new Uint8Array(buf).set(value);
        const data = new Uint8Array(buf);
        chunksPosted++;
        bytesPosted += buf.byteLength;
        if (chunksPosted === 1 || chunksPosted % 30 === 0) {
          console.log(
            TAG,
            "→ chunk",
            chunksPosted,
            "size:",
            buf.byteLength,
            "total bytes:",
            bytesPosted,
            "hex-prefix:",
            data.subarray(0, Math.min(8, data.byteLength)),
          );
        }
        if (chunksPosted === 1) {
          console.log(
            TAG,
            "first chunk,",
            data.length,
            "bytes, hex-prefix:",
            data.subarray(0, Math.min(8, data.length)),
          );
          opts.onProgress?.("first-chunk", `${data.length} bytes`);
        }

        // Split into NAL units and decide what to do.
        const nals = splitAnnexBNals(data);
        if (nals.length === 0) continue;
        const hasIdr = nals.some((n) => n.type === 5);
        if (chunksPosted === 1 || chunksPosted % 30 === 0) {
          console.log(
            TAG,
            "chunk",
            chunksPosted,
            "size:",
            data.length,
            "nal-count:",
            nals.length,
            "nal-types:",
            nals.map((n) => n.type).slice(0, 12).join(","),
            "hasIdr:",
            hasIdr,
          );
        }

        // Parse SPS/PPS if we haven't already.
        if (!configSent) {
          const cfg = parseSpsPps(data);
          if (cfg) {
            console.log(TAG, "parsed SPS/PPS, codec:", cfg.codec, "description-bytes:", cfg.description.byteLength);
            avcConfig = { description: cfg.description };
            codec = cfg.codec;
            // Tear down + recreate the muxer so the next addChunk
            // (the IDR) writes the ftyp+moov with the discovered
            // codec. The muxer can't have its codec changed
            // in-place.
            try {
              muxer?.finalize();
            } catch { /* ignore */ }
            muxer = createMuxerInstance(codec);
            configSent = true;
          }
        }

        // Hold back non-IDR chunks until we have the codec config.
        if (!hasIdr) {
          pendingChunks.push({
            data,
            type: "key",
            timestampUs: chunkCounter * (1_000_000 / ASSUMED_FPS),
            durationUs: 1_000_000 / ASSUMED_FPS,
            meta: avcConfig
              ? { decoderConfig: { codec: "avc", description: avcConfig.description } }
              : undefined,
          });
          chunkCounter++;
          continue;
        }

        // First IDR: flush pending, then push this one.
        if (!sawKeyframe) {
          for (const p of pendingChunks) {
            try {
              muxer!.addChunk(
                p.data,
                "key",
                p.timestampUs,
                p.durationUs,
                p.meta,
              );
            } catch (e) {
              opts.onError(
                `addVideoChunkRaw (pending) failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
              return;
            }
          }
          pendingChunks = [];
          sawKeyframe = true;
          console.log(TAG, "first IDR, flushed", pendingChunks.length, "pending chunks");
        }

        const durationUs = 1_000_000 / ASSUMED_FPS;
        const timestampUs = chunkCounter * durationUs;
        chunkCounter++;
        try {
          muxer!.addChunk(
            data,
            hasIdr ? "key" : "delta",
            timestampUs,
            durationUs,
            avcConfig
              ? { decoderConfig: { codec: "avc", description: avcConfig.description } }
              : undefined,
          );
        } catch (e) {
          opts.onError(
            `addVideoChunkRaw failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
    } catch (e) {
      if (!stopRequested) {
        console.error(TAG, "stdout read loop failed:", e);
        opts.onError(
          `screencast read loop failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  })();

  return {
    bitrate,
    encodedWidth,
    encodedHeight,
    stop: () => {
      if (stopRequested) return;
      stopRequested = true;
      try { killFn?.(); } catch { /* ignore */ }
      try { muxer?.finalize(); } catch { /* ignore */ }
      try {
        if (mediaSource.readyState === "open") {
          try {
            mediaSource.endOfStream();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
      try {
        videoEl.removeAttribute("src");
        videoEl.load();
      } catch {
        /* ignore */
      }
    },
  };
}

export async function getDeviceScreenSize(
  session: AdbSession,
): Promise<{ width: number; height: number } | null> {
  try {
    const shell = session.adb.subprocess.shellProtocol;
    if (!shell || !shell.isSupported) return null;
    const proc = await shell.spawn(["wm", "size"]);
    const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let out = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      out += decoder.decode();
    } finally {
      reader.releaseLock();
      try { void proc.kill(); } catch { /* ignore */ }
    }
    const match = /Physical size:\s*(\d+)x(\d+)/.exec(out);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return null;
  }
}

export async function injectInput(
  session: AdbSession,
  cmd:
    | { kind: "tap"; x: number; y: number }
    | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs: number }
    | { kind: "keyevent"; code: number },
): Promise<void> {
  let args: string[];
  switch (cmd.kind) {
    case "tap":
      args = ["input", "tap", String(cmd.x | 0), String(cmd.y | 0)];
      break;
    case "swipe":
      args = [
        "input",
        "swipe",
        String(cmd.x1 | 0),
        String(cmd.y1 | 0),
        String(cmd.x2 | 0),
        String(cmd.y2 | 0),
        String(Math.max(50, cmd.durationMs | 0)),
      ];
      break;
    case "keyevent":
      args = ["input", "keyevent", String(cmd.code | 0)];
      break;
  }
  try {
    const shell = session.adb.subprocess.shellProtocol;
    if (!shell || !shell.isSupported) return;
    const proc = await shell.spawn(args);
    try {
      const r = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done } = await r.read();
        if (done) break;
      }
      r.releaseLock();
    } catch { /* ignore */ }
    try { void proc.kill(); } catch { /* ignore */ }
  } catch {
    /* ignore */
  }
}