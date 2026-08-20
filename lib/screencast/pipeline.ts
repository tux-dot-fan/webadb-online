// ── Screencast pipeline (main thread) ────────────────────────────────────────
//
// Glue between `session.adb.subprocess.shellProtocol` (the underlying
// ya-webadb API that panels get via the AppProps.session prop) and
// the Web Worker that hosts the VideoDecoder. Reads chunks from the
// screenrecord stdout, forwards them to the worker, and routes the
// worker's `frame` messages to a callback (which paints them onto
// the panel's <canvas>).
//
// The pipeline is intentionally one-shot: when the user resizes the
// panel, we tear down the current session and start a new one with
// the new dimensions. screenrecord's `--size` and `--bit-rate` flags
// are not changeable at runtime (the process would have to be killed
// and restarted), so this is the simplest way to handle the
// PPI-matching behavior we want.

import type { AdbSession } from "@/lib/adb-client";
import type { WorkerOutbound } from "./types";

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
  /** Stop the current session and tear down the worker. */
  stop(): void;
}

/**
 * Start a screencast session. The worker is created lazily and torn
 * down on `stop()`. The `onFrame` callback is invoked from the
 * worker message handler; it should be cheap (a single
 * `drawImage(bitmap, 0, 0)` is typical).
 */
export async function startScreencast(
  session: AdbSession,
  opts: {
    /** Panel width in CSS pixels (not encoded dimensions). */
    panelWidth: number;
    /** Panel height in CSS pixels. */
    panelHeight: number;
    /** Device pixel ratio of the panel's window, for matching PPI. */
    devicePixelRatio: number;
    /** Device's physical screen size in pixels (from `wm size`). */
    devicePhysical: { width: number; height: number };
    /** Approximate device PPI, for the bitrate formula. */
    devicePpi: number;
    onFrame: (bitmap: ImageBitmap) => void;
    onError: (message: string) => void;
    onReady?: () => void;
  },
): Promise<PipelineHandle> {
  // Map CSS-pixel panel size to encoded frame dimensions. We don't
  // multiply by DPR — the panel size is what the user sees, so
  // encoding more pixels than that would waste bandwidth. We do
  // ensure the encoded height is at least 360 (so the device
  // doesn't reject with a "too small" error) and the aspect ratio
  // matches the device.
  const aspect = opts.devicePhysical.height / opts.devicePhysical.width;
  let encodedWidth = Math.max(360, Math.round(opts.panelWidth));
  let encodedHeight = Math.max(Math.round(360 * aspect), Math.round(encodedWidth * aspect));
  // screenrecord rejects odd dimensions — round down to even.
  encodedWidth = encodedWidth & ~1;
  encodedHeight = encodedHeight & ~1;

  // Bitrate: PPI-aware, scaled to the panel. We treat the device's
  // native resolution as the "1.0×" reference and the panel's
  // encoded area as the multiplier.
  const nativeArea = opts.devicePhysical.width * opts.devicePhysical.height;
  const panelArea = encodedWidth * encodedHeight;
  // PPI reduction: 1.0 at 440 ppi, lower PPI on the panel side = lower
  // bitrate. A 200-ppi display in the panel gets ~half the bitrate
  // of a 440-ppi one at the same panel size.
  const ppiFactor = Math.max(0.4, Math.min(1.0, opts.devicePpi / 440));
  const bitrate = Math.max(
    MIN_BITRATE,
    Math.min(
      MAX_BITRATE,
      Math.round((NATIVE_BITRATE * (panelArea / nativeArea)) * ppiFactor),
    ),
  );

  // Spawn the worker via the `new Worker(new URL(...), { type: 'module' })`
  // pattern. next/swc recognizes this and bundles the worker as a
  // separate chunk automatically.
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "screencast-decoder",
  });

  const streamId = Date.now() ^ Math.floor(Math.random() * 0xffff);

  let stopRequested = false;
  let killFn: (() => void) | null = null;

  worker.addEventListener("message", (ev: MessageEvent<WorkerOutbound>) => {
    const msg = ev.data;
    if (msg.streamId !== streamId) return; // stale from a previous session
    if (msg.type === "frame") {
      opts.onFrame(msg.bitmap);
    } else if (msg.type === "error") {
      opts.onError(msg.message);
    } else if (msg.type === "ready") {
      opts.onReady?.();
    }
  });

  // Tell the worker to start.
  worker.postMessage({
    type: "start",
    streamId,
    width: encodedWidth,
    height: encodedHeight,
    bitRate: bitrate,
  });

  // Spawn screenrecord on the device via the same Shell V2 API the
  // logcat panel uses. The `shell.spawn()` call is the same call
  // that powers every other panel that needs a long-running process.
  const shell = session.adb.subprocess.shellProtocol;
  if (!shell || !shell.isSupported) {
    worker.postMessage({ type: "stop", streamId });
    worker.terminate();
    throw new Error("Device doesn't support Shell V2 protocol");
  }

  const timeLimit = 180; // screenrecord max; restart if user keeps it open
  const proc = await shell.spawn([
    "screenrecord",
    "--output-format=h264",
    "--size", `${encodedWidth}x${encodedHeight}`,
    "--bit-rate", String(Math.max(200_000, bitrate | 0)),
    "--time-limit", String(timeLimit),
    "-",
  ]);
  killFn = () => {
    try {
      void proc.kill();
    } catch {
      /* ignore */
    }
  };

  // Pump stdout chunks into the worker.
  const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
  (async () => {
    try {
      while (!stopRequested) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const buf = value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength,
          );
          worker.postMessage(
            { type: "chunk", streamId, data: buf, eos: false },
            [buf],
          );
        }
      }
    } catch (e) {
      if (!stopRequested) {
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
      worker.postMessage({ type: "stop", streamId });
      // Give the worker a tick to flush its in-flight frame, then
      // terminate. We can't await here because stop() is sync.
      setTimeout(() => {
        try {
          worker.terminate();
        } catch {
          /* ignore */
        }
      }, 100);
    },
  };
}

/**
 * Read the device's current screen size via `wm size`. Returns null
 * if `wm` isn't available (very old Androids) or the call fails.
 *
 * `wm size` reports the natural display size in pixels regardless of
 * orientation. We use this to map pointer events from the screencast
 * panel's normalized coordinates to device-pixel coordinates.
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
 * Issue a `input` command on the device. Used by the Screencast
 * panel to forward pointer events from the canvas to the device.
 *
 * `input` is the Android shell command that synthesizes events on
 * `/dev/input/event*`. We support `tap`, `swipe`, `keyevent`.
 *
 * Errors are swallowed; pointer events are best-effort.
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
    // Drain stdout/stderr so the process can exit cleanly.
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