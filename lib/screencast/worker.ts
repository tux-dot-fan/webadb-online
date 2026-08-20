// ── Screencast Web Worker ────────────────────────────────────────────────────
//
// Hosts a WebCodecs `VideoDecoder` off the main thread. Receives H.264
// annex-B chunks from the panel (which is reading them from the ADB
// `screenrecord` stdout), decodes each frame, and posts an
// `ImageBitmap` back to the main thread for the panel to draw.
//
// All bookkeeping (current stream ID, decoder state) lives in module
// scope. The worker is single-stream by design — each panel instance
// gets its own worker.
//
// Browser support:
//   - VideoDecoder: Chrome 94+, Edge 94+, Opera 80+ (all on desktop).
//   - Safari has no VideoDecoder as of 2026; we fail fast with a clear
//     "Browser doesn't support WebCodecs" error so the panel can show
//     a helpful fallback message instead of hanging silently.
//
// We do NOT try to fall back to MSE + fMP4 here — that's a much
// bigger lift and the panel already restricts itself to Chromium-
// based browsers (per app-registry `description` on the Workspace
// chrome). If we ever need to support Firefox/Safari, we'd add a
// "decode via canvas + MSE" path; not for v1.

import type {
  WorkerInbound,
  WorkerOutbound,
} from "./types";

/// <reference lib="webworker" />

// `DedicatedWorkerGlobalScope` is provided by the `webworker` lib. The
// project tsconfig only includes "dom" (not "webworker"), so we declare
// just the bit we use here. next/swc compiles workers separately and
// has the full lib available at build time, so this is purely so
// `tsc` is happy during local type-checking.
interface DedicatedWorkerGlobalScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (ev: MessageEvent) => void,
  ): void;
}

const workerSelf = self as unknown as DedicatedWorkerGlobalScope;

let currentStreamId: number = -1;
let decoder: VideoDecoder | null = null;
/**
 * The chunks screenrecord gives us are annex-B but `VideoDecoder.configure`
 * wants either "annexb" or "avc" (length-prefixed) bytes. We forward
 * "annexb" verbatim and the decoder strips the start codes internally.
 */
let configured = false;

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    workerSelf.postMessage(msg, transfer);
  } else {
    workerSelf.postMessage(msg);
  }
}

function teardown(): void {
  if (decoder && decoder.state !== "closed") {
    try {
      decoder.close();
    } catch {
      /* ignore */
    }
  }
  decoder = null;
  configured = false;
  currentStreamId = -1;
}

workerSelf.addEventListener("message", (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;

  if (msg.type === "start") {
    // If a previous session is in flight, tear it down before starting a new
    // one. The panel is responsible for not double-starting, but we belt-and-
    // brace here because resize-events can fire rapidly during a drag.
    teardown();
    currentStreamId = msg.streamId;

    // Re-check support on every start; if the user upgraded Chrome between
    // sessions, we'd otherwise see a stale boolean.
    if (typeof VideoDecoder === "undefined") {
      post({
        type: "error",
        streamId: currentStreamId,
        message:
          "WebCodecs VideoDecoder is not available in this browser. " +
          "Use Chrome 94+, Edge 94+, or Opera 80+ on desktop.",
      });
      currentStreamId = -1;
      return;
    }

    decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        // Convert VideoFrame → ImageBitmap. The frame's `close()` is called
        // after createImageBitmap resolves; createImageBitmap reads the
        // pixel data synchronously and decouples the bitmap from the
        // underlying GPU buffer.
        const ts = frame.timestamp;
        const w = frame.displayWidth;
        const h = frame.displayHeight;
        createImageBitmap(frame, { resizeWidth: w, resizeHeight: h })
          .then((bitmap) => {
            // The original frame's GPU buffer can be released now.
            frame.close();
            post(
              {
                type: "frame",
                streamId: currentStreamId,
                timestamp: ts,
                width: w,
                height: h,
                bitmap,
              },
              [bitmap],
            );
          })
          .catch((err) => {
            frame.close();
            post({
              type: "error",
              streamId: currentStreamId,
              message: `createImageBitmap failed: ${String(err)}`,
            });
          });
      },
      error: (err: Error) => {
        post({
          type: "error",
          streamId: currentStreamId,
          message: `VideoDecoder error: ${err.message}`,
        });
        // Don't tear down on a single decode error — let the next chunk
        // try to recover. But if the decoder has reached the "closed"
        // state, we have to start over.
        if (decoder && decoder.state === "closed") {
          teardown();
        }
      },
    });

    // H.264 high profile @ level 4.0. The device can also encode
    // baseline/main; configure() will pick whichever the SPS describes.
    // We set "annexb" because screenrecord writes annex-B start codes
    // (0x00 0x00 0x00 0x01).
    try {
      decoder.configure({
        codec: "avc1.640028", // H.264 high @ level 4.0
        codedWidth: msg.width,
        codedHeight: msg.height,
        optimizeForLatency: true,
        description: undefined, // annexb mode: SPS/PPS come in-band
      });
      configured = true;
    } catch (e) {
      post({
        type: "error",
        streamId: currentStreamId,
        message: `VideoDecoder.configure failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
      teardown();
      return;
    }

    post({ type: "ready", streamId: currentStreamId });
    return;
  }

  if (msg.type === "chunk") {
    if (!decoder || !configured || currentStreamId !== msg.streamId) return;
    try {
      // VideoDecoder requires EncodedVideoChunkInit, not raw bytes.
      const chunk = new EncodedVideoChunk({
        type: msg.eos ? "key" : "delta",
        // `delta` is wrong for EOS but harmless: we just don't send a
        // packet after EOS anyway, and the panel won't push more.
        timestamp: 0, // overwritten per-chunk; the worker tracks time itself
        data: new Uint8Array(msg.data),
      });
      decoder.decode(chunk);
    } catch (e) {
      post({
        type: "error",
        streamId: msg.streamId,
        message: `decode() failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
    return;
  }

  if (msg.type === "stop") {
    teardown();
    return;
  }
});
