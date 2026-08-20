// ── Screencast Panel ─────────────────────────────────────────────────────────
//
// The 12th dock app. Streams the connected Android device's live screen
// to a <canvas> in the workspace, with pointer / wheel / drag events
// forwarded back to the device via `adb shell input` commands.
//
// Architecture:
//
//   device ─adb shell screenrecord─> stdout chunks
//        ─streamed─> main thread reader
//        ─posted─> Screencast worker (VideoDecoder)
//        ─ImageBitmap─> panel onFrame
//        ─drawImage─> <canvas>
//
//   <canvas> pointer events
//        ─tap / swipe / keyevent─> client.injectInput
//        ─`adb shell input …`─> device
//
// On resize: the panel tears down the pipeline and starts a new one
// with the new dimensions. screenrecord's --size/--bit-rate are not
// live-tweakable, so restart-on-resize is the simplest path. The
// 100-300 ms downtime is barely visible to the user because the
// pipeline is async and the canvas just freezes for that long.

import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import type { AppProps } from "@/lib/app-registry";
import {
  startScreencast,
  injectInput,
  getDeviceScreenSize,
  type PipelineHandle,
} from "@/lib/screencast/pipeline";

/** Keycodes used by the panel. Full table in Android's KeyEvent.java. */
const KEYCODE_HOME = 3;
const KEYCODE_BACK = 4;

/**
 * Estimate the device's PPI from `wm size` + a hardcoded guess about
 * the diagonal. Real Android doesn't expose density via adb without
 * `wm density`, so we approximate. Modern phones are 380-500 ppi, so
 * 440 is a reasonable middle.
 */
function approxPpi(): number {
  return 440;
}

export function ScreencastPanel({ session }: AppProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipelineRef = useRef<PipelineHandle | null>(null);
  const screenSizeRef = useRef<{ width: number; height: number } | null>(null);
  // Drag state. We use refs (not state) because the value changes
  // many times per second and re-rendering on every move would tear
  // the canvas.
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    button: number;
  } | null>(null);

  const [status, setStatus] = useState<
    "idle" | "starting" | "running" | "stopped" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [stats, setStats] = useState<{
    bitrate: number;
    width: number;
    height: number;
  } | null>(null);

  // ── Start / stop the pipeline ────────────────────────────────────────────
  const start = useCallback(async () => {
    if (pipelineRef.current) return; // already running
    if (!session) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    setStatus("starting");
    setErrorMsg("");

    // Fetch the device's physical screen size for coord mapping. We
    // do this lazily (not in pipeline.ts) because the panel can
    // re-use the result across resizes.
    if (!screenSizeRef.current) {
      try {
        const sz = await getDeviceScreenSize(session);
        if (sz) screenSizeRef.current = sz;
      } catch {
        /* non-fatal */
      }
    }
    const deviceSize = screenSizeRef.current ?? { width: 1080, height: 2400 };

    // Measure the canvas element (it has a sized parent via flex).
    const rect = container.getBoundingClientRect();
    const cssWidth = Math.max(360, Math.round(rect.width));
    const cssHeight = Math.max(240, Math.round(rect.height));

    // Internal canvas resolution matches the device aspect ratio so
    // we don't letterbox in the canvas itself; the panel's <div>
    // sizes the canvas via CSS to fill its allocated window.
    const dpr = window.devicePixelRatio || 1;

    try {
      const handle = await startScreencast(session, {
        panelWidth: cssWidth,
        panelHeight: cssHeight,
        devicePixelRatio: dpr,
        devicePhysical: deviceSize,
        devicePpi: approxPpi(),
        onFrame: (bitmap) => {
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          // Resize the canvas backing store to the decoded frame
          // size the first time we see a frame. Subsequent frames
          // assume the size doesn't change unless the panel
          // resizes (which restarts the pipeline anyway).
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.style.width = `${cssWidth}px`;
            canvas.style.height = `${cssHeight}px`;
          }
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
        },
        onError: (msg) => {
          setStatus("error");
          setErrorMsg(msg);
        },
        onReady: () => {
          setStatus("running");
        },
      });
      pipelineRef.current = handle;
      setStats({
        bitrate: handle.bitrate,
        width: handle.encodedWidth,
        height: handle.encodedHeight,
      });
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }, [session]);

  const stop = useCallback(() => {
    pipelineRef.current?.stop();
    pipelineRef.current = null;
    setStatus("stopped");
    setStats(null);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) {
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  }, []);

  // ── Pointer / wheel / drag input → adb shell input ───────────────────────
  const sendTap = useCallback(
    (x: number, y: number) => {
      const deviceSize = screenSizeRef.current;
      if (!deviceSize) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Convert canvas-relative px to device px.
      const dx = Math.round((x / canvas.clientWidth) * deviceSize.width);
      const dy = Math.round((y / canvas.clientHeight) * deviceSize.height);
      void injectInput(session, { kind: "tap", x: dx, y: dy });
    },
    [session],
  );

  const sendSwipe = useCallback(
    (x1: number, y1: number, x2: number, y2: number, durationMs = 200) => {
      const deviceSize = screenSizeRef.current;
      if (!deviceSize) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dx1 = Math.round((x1 / canvas.clientWidth) * deviceSize.width);
      const dy1 = Math.round((y1 / canvas.clientHeight) * deviceSize.height);
      const dx2 = Math.round((x2 / canvas.clientWidth) * deviceSize.width);
      const dy2 = Math.round((y2 / canvas.clientHeight) * deviceSize.height);
      void injectInput(session, {
        kind: "swipe",
        x1: dx1,
        y1: dy1,
        x2: dx2,
        y2: dy2,
        durationMs,
      });
    },
    [session],
  );

  // ResizeObserver: re-evaluate the panel size on container resize and
  // restart the pipeline if running. screenrecord can't be resized
  // mid-stream, so restart is the only option. We debounce slightly
  // because resize events fire continuously during a drag.
  useEffect(() => {
    if (!containerRef.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (status === "running" && pipelineRef.current) {
          stop();
          void start();
        }
      }, 250);
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [status, start, stop]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      pipelineRef.current?.stop();
      pipelineRef.current = null;
    };
  }, []);

  // ── Pointer event handlers ───────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    dragRef.current = {
      active: true,
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      button: e.button,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current?.active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current.currentX = e.clientX - rect.left;
    dragRef.current.currentY = e.clientY - rect.top;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    dragRef.current = null;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    // Right or middle click → keyevent (HOME / BACK).
    if (e.button === 1) {
      void injectInput(session, { kind: "keyevent", code: KEYCODE_HOME });
      return;
    }
    if (e.button === 2) {
      void injectInput(session, { kind: "keyevent", code: KEYCODE_BACK });
      return;
    }

    // Left click → tap or drag-as-swipe.
    const dx = Math.abs(drag.currentX - drag.startX);
    const dy = Math.abs(drag.currentY - drag.startY);
    if (dx < 4 && dy < 4) {
      sendTap(drag.startX, drag.startY);
    } else {
      sendSwipe(
        drag.startX,
        drag.startY,
        drag.currentX,
        drag.currentY,
        200,
      );
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 1 : -1;
    // Synthesize a 100-px swipe in the scroll direction. Two swipes
    // per notch gives a similar feel to native touch scroll.
    for (let i = 0; i < 2; i++) {
      sendSwipe(x, y, x, y + delta * 50, 100);
    }
  };

  // Suppress the browser context menu on right-click so the right
  // button can be used as BACK.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div className="screencast-panel">
      <div className="screencast-toolbar">
        {status === "running" ? (
          <button
            type="button"
            className="screencast-btn screencast-btn-stop"
            onClick={stop}
          >
            ⏹ Stop
          </button>
        ) : (
          <button
            type="button"
            className="screencast-btn screencast-btn-start"
            onClick={start}
            disabled={status === "starting"}
          >
            ▶ Start
          </button>
        )}
        {stats && (
          <span className="screencast-stats">
            {stats.width}×{stats.height} · {(stats.bitrate / 1_000).toFixed(0)} kbps
          </span>
        )}
        {status === "error" && (
          <span className="screencast-error">⚠ {errorMsg}</span>
        )}
      </div>
      <div ref={containerRef} className="screencast-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="screencast-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onContextMenu={onContextMenu}
        />
        {status !== "running" && (
          <div className="screencast-overlay">
            {status === "idle" && (
              <div className="screencast-overlay-text">
                Press <kbd>Start</kbd> to begin streaming the device's
                screen. Click and drag to interact.
              </div>
            )}
            {status === "starting" && (
              <div className="screencast-overlay-text">Starting…</div>
            )}
            {status === "stopped" && (
              <div className="screencast-overlay-text">Stopped.</div>
            )}
            {status === "error" && (
              <div className="screencast-overlay-text screencast-overlay-error">
                {errorMsg}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
