// ── Screencast pipeline (main thread) ────────────────────────────────────────
//
// Glue between `session.adb.subprocess.shellProtocol` (the underlying
// ya-webadb API that panels get via the AppProps.session prop) and
// the Web Worker that muxes the device's H.264 stream into fMP4
// fragments. The main thread owns a MediaSource / SourceBuffer pair
// that drives a plain <video> element — that's how the browser's
// built-in H.264 decoder gets engaged without us having to manage
// SPS/PPS extraction or VideoDecoder.configure() ourselves.
//
// The pipeline is intentionally one-shot: when the user resizes the
// panel, we tear down the current session and start a new one with
// the new dimensions. screenrecord's `--size` and `--bit-rate` flags
// are not changeable at runtime (the process would have to be killed
// and restarted), so this is the simplest way to handle the
// PPI-matching behavior we want.

import type { AdbSession } from "@/lib/adb-client";
import type { WorkerOutbound, ProgressKind } from "./types";

// All console output from the screencast pipeline is prefixed with
// [screencast] so it can be filtered easily in DevTools. We log
// every pipeline transition and every error path so the user can
// see what's happening even when the on-screen UI is stuck.
const TAG = "[screencast]";

/** Bitrate (in bits/second) at the device's native resolution. */
const NATIVE_BITRATE = 4_000_000; // 4 Mbps, the screenrecord default
/** Floor so even a 200-px panel gets a usable stream. */
const MIN_BITRATE = 200_000; // 200 kbps
/** Ceiling so a 4K panel doesn't overflow the USB pipe. */
const MAX_BITRATE = 8_000_000; // 8 Mbps

export interface PipelineHandle {
  /** The current bitrate the device is encoding at, for UI display. */
  bitrate: number;
  /** The current encoded frame dimensions, for UI display. */
  encodedWidth: number;
  encodedHeight: number;
  /** Stop the current session and tear down the worker + MediaSource. */
  stop(): void;
}

/**
 * Start a screencast session. The worker is created lazily and torn
 * down on `stop()`. `videoEl` is the <video> element the pipeline
 * drives via a MediaSource. `onError` is called for any failure
 * (worker, MediaSource, decode).
 */
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
  // ── 1. Encode size + bitrate (PPI-aware) ─────────────────────────────────
  const aspect = opts.devicePhysical.height / opts.devicePhysical.width;
  let encodedWidth = Math.max(360, Math.round(opts.panelWidth));
  let encodedHeight = Math.max(Math.round(360 * aspect), Math.round(encodedWidth * aspect));
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

  // ── 2. Set up the <video> element + MediaSource + SourceBuffer ───────────
  const videoEl = opts.videoEl;
  // Make sure the element can play inline without user gesture.
  videoEl.muted = true; // screencast has no audio; muted avoids the
                        // browser autoplay block
  videoEl.autoplay = true;
  videoEl.playsInline = true;

  const mediaSource = new MediaSource();
  console.log(TAG, "MediaSource created, initial state:", mediaSource.readyState);
  // Attach MediaSource to the <video> via createObjectURL so the
  // browser wires the SourceBuffer updates back to the element.
  // We capture the URL but revoke it on stop.
  const objectUrl = URL.createObjectURL(mediaSource);
  videoEl.src = objectUrl;
  console.log(TAG, "video.src set, video dimensions:", videoEl.clientWidth, "x", videoEl.clientHeight);

  let sourceBuffer: SourceBuffer | null = null;
  let mediaSourceOpen = false;
  // Queue any media segments that arrive before the MediaSource is
  // open. MediaSource opens asynchronously (see the 'sourceopen'
  // event handler below).
  let pendingInit: ArrayBuffer | null = null;
  let pendingMedia: ArrayBuffer[] = [];
  // Promise that resolves when sourceopen fires, so the worker can
  // know when it's safe to start feeding the buffer.
  const sourceOpenPromise = new Promise<void>((resolve) => {
    if (mediaSource.readyState === "open") {
      mediaSourceOpen = true;
      resolve();
      return;
    }
    mediaSource.addEventListener("sourceopen", () => {
      mediaSourceOpen = true;
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
      // SourceBuffer is busy. Queue and let it drain via the
      // 'updateend' event.
      sourceBuffer.addEventListener(
        "updateend",
        () => {
          if (pendingMedia.length > 0 && sourceBuffer && !sourceBuffer.updating) {
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

  // ── 3. Start the worker ──────────────────────────────────────────────────
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "screencast-decoder",
  });
  const streamId = Date.now() ^ Math.floor(Math.random() * 0xffff);
  let stopRequested = false;
  let killFn: (() => void) | null = null;

  worker.addEventListener("message", async (ev: MessageEvent<WorkerOutbound>) => {
    const msg = ev.data;
    if (msg.streamId !== streamId) {
      console.warn(TAG, "ignoring stale message", msg.type, msg.streamId, "!=", streamId);
      return;
    }
    console.log(TAG, "← worker message:", msg.type, "streamId:", msg.streamId);
    if (msg.type === "ready") {
      // Worker is initialized. We'll start spawning screenrecord
      // once MediaSource is open.
      opts.onReady?.();
      return;
    }
    if (msg.type === "init") {
      console.log(TAG, "init segment received, codec:", msg.codec, "bytes:", msg.init.byteLength, "hex-prefix:", new Uint8Array(msg.init, 0, Math.min(8, msg.init.byteLength)));
      // Wait for MediaSource to be open before adding the buffer.
      await sourceOpenPromise;
      if (stopRequested) return;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(
          `video/mp4; codecs="${msg.codec}"`,
        );
        console.log(TAG, "addSourceBuffer succeeded, codec:", msg.codec);
      } catch (e) {
        console.error(TAG, "addSourceBuffer FAILED", msg.codec, e);
        opts.onError(
          `addSourceBuffer failed (codec ${msg.codec}): ${
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
        console.log(TAG, "SourceBuffer updateend, buffered:", sourceBuffer?.buffered.length, "timeRanges:", sourceBuffer?.buffered.length ? `${sourceBuffer.buffered.start(0).toFixed(2)} - ${sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1).toFixed(2)}` : "[]");
      });
      // The init segment goes first.
      try {
        sourceBuffer.appendBuffer(msg.init);
        console.log(TAG, "init appendBuffer called,", msg.init.byteLength, "bytes");
        opts.onProgress?.("init-sent", msg.codec);
      } catch (e) {
        console.error(TAG, "init appendBuffer FAILED", e);
        opts.onError(
          `init appendBuffer failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      return;
    }
    if (msg.type === "media") {
      console.log(TAG, "media chunk received,", msg.buffer.byteLength, "bytes, sourceBuffer:", !!sourceBuffer, "pendingMedia.length:", pendingMedia.length);
      // If the SourceBuffer isn't ready yet, queue; otherwise append.
      if (!sourceBuffer) {
        pendingMedia.push(msg.buffer);
        return;
      }
      // First-frame event is fired before play() resolves, since we
      // can't predict when the decoder has decoded enough to produce
      // a video frame. The `playing` event fires once the first frame
      // actually paints.
      appendBuffer(msg.buffer);
      opts.onProgress?.("first-frame", `${msg.buffer.byteLength} bytes`);
      // Try to keep the video element close to live by playing as
      // soon as we have at least one frame buffered. The browser
      // will automatically drop frames if the playback rate can't
      // keep up with the source.
      if (videoEl.paused && videoEl.buffered.length > 0) {
        const targetTime = videoEl.buffered.end(
          videoEl.buffered.length - 1,
        ) - 0.05; // 50 ms behind the head
        if (targetTime > videoEl.currentTime) {
          try {
            videoEl.currentTime = Math.max(0, targetTime);
          } catch {
            /* ignore — first play can throw if not yet seekable */
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
          /* ignore autoplay errors */
        });
      }
      return;
    }
    if (msg.type === "error") {
      console.error(TAG, "worker error:", msg.message);
      opts.onError(msg.message);
      return;
    }
    if (msg.type === "progress") {
      opts.onProgress?.(msg.kind, msg.detail);
      return;
    }
  });
  worker.addEventListener("error", (ev) => {
    console.error(TAG, "worker error event:", ev);
  });
  worker.addEventListener("messageerror", (ev) => {
    console.error(TAG, "worker messageerror event:", ev);
  });

  // ── 4. Spawn screenrecord on the device ──────────────────────────────────
  const shell = session.adb.subprocess.shellProtocol;
  if (!shell || !shell.isSupported) {
    worker.terminate();
    URL.revokeObjectURL(objectUrl);
    throw new Error("Device doesn't support Shell V2 protocol");
  }

  opts.onProgress?.("spawning", `${encodedWidth}×${encodedHeight} @ ${(bitrate / 1_000).toFixed(0)} kbps`);
  console.log(TAG, "spawning screenrecord", { width: encodedWidth, height: encodedHeight, bitrate });

  const timeLimit = 180; // screenrecord max; restart if user keeps it open
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
    try {
      void proc.kill();
    } catch {
      /* ignore */
    }
  };

  // Tell the worker to start.
  worker.postMessage({
    type: "start",
    streamId,
    width: encodedWidth,
    height: encodedHeight,
  });

  // ── 5. Pump stdout → worker chunks ───────────────────────────────────────
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
        if (value && value.byteLength > 0) {
          const buf = value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength,
          );
          chunksPosted++;
          bytesPosted += buf.byteLength;
          worker.postMessage({ type: "chunk", streamId, data: buf }, [buf]);
          if (chunksPosted === 1 || chunksPosted % 30 === 0) {
            console.log(TAG, "→ worker chunk", chunksPosted, "size:", buf.byteLength, "total bytes:", bytesPosted);
          }
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
      try {
        killFn?.();
      } catch {
        /* ignore */
      }
      try {
        worker.postMessage({ type: "stop", streamId });
        worker.terminate();
      } catch {
        /* ignore */
      }
      try {
        if (videoEl && mediaSource.readyState === "open") {
          if (sourceBuffer && !sourceBuffer.updating) {
            try {
              mediaSource.endOfStream();
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      try {
        videoEl.removeAttribute("src");
        videoEl.load();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Read the device's current screen size via `wm size`. Returns null
 * if `wm` isn't available (very old Androids) or the call fails.
 */
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

/**
 * Issue a `input` command on the device. Used by the Screencast panel
 * to forward pointer events from the canvas to the device.
 */
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
    /* ignore — pointer events are best-effort */
  }
}