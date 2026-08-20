// ── Screencast Panel ─────────────────────────────────────────────────────────
//
// The 12th dock app. Streams the connected Android device's live screen
// to a <video> element inside the workspace, with pointer / wheel / drag
// events forwarded back to the device via `adb shell input` commands.
//
// Architecture:
//
//   device ─adb shell screenrecord─> stdout chunks
//        ─streamed─> main thread reader
//        ─posted─> Screencast worker (mp4-muxer fMP4 muxer)
//        ─fMP4 fragments─> SourceBuffer
//        ─decoded H.264─> <video>
//        ─user clicks <video>─> `adb shell input tap`
//
// On resize: tear down the pipeline and start a new one with the
// new dimensions. screenrecord's --size/--bit-rate are not
// live-tweakable, so restart-on-resize is the simplest path.

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

function approxPpi(): number {
  return 440;
}

export function ScreencastPanel({ session }: AppProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pipelineRef = useRef<PipelineHandle | null>(null);
  const screenSizeRef = useRef<{ width: number; height: number } | null>(null);
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

  const start = useCallback(async () => {
    if (pipelineRef.current) return;
    if (!session) return;
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    setStatus("starting");
    setErrorMsg("");

    if (!screenSizeRef.current) {
      try {
        const sz = await getDeviceScreenSize(session);
        if (sz) screenSizeRef.current = sz;
      } catch {
        /* non-fatal */
      }
    }
    const deviceSize = screenSizeRef.current ?? { width: 1080, height: 2400 };

    const rect = container.getBoundingClientRect();
    const cssWidth = Math.max(360, Math.round(rect.width));
    const cssHeight = Math.max(240, Math.round(rect.height));

    try {
      const handle = await startScreencast(session, {
        videoEl: video,
        panelWidth: cssWidth,
        panelHeight: cssHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        devicePhysical: deviceSize,
        devicePpi: approxPpi(),
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
  }, []);

  // ── Pointer / wheel / drag → adb shell input ──────────────────────────────
  const sendTap = useCallback(
    (x: number, y: number) => {
      const deviceSize = screenSizeRef.current;
      if (!deviceSize) return;
      const video = videoRef.current;
      if (!video) return;
      const dx = Math.round((x / video.clientWidth) * deviceSize.width);
      const dy = Math.round((y / video.clientHeight) * deviceSize.height);
      void injectInput(session, { kind: "tap", x: dx, y: dy });
    },
    [session],
  );

  const sendSwipe = useCallback(
    (x1: number, y1: number, x2: number, y2: number, durationMs = 200) => {
      const deviceSize = screenSizeRef.current;
      if (!deviceSize) return;
      const video = videoRef.current;
      if (!video) return;
      const dx1 = Math.round((x1 / video.clientWidth) * deviceSize.width);
      const dy1 = Math.round((y1 / video.clientHeight) * deviceSize.height);
      const dx2 = Math.round((x2 / video.clientWidth) * deviceSize.width);
      const dy2 = Math.round((y2 / video.clientHeight) * deviceSize.height);
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

  // ResizeObserver: restart the pipeline if running and the user
  // resizes the panel.
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

  useEffect(() => {
    return () => {
      pipelineRef.current?.stop();
      pipelineRef.current = null;
    };
  }, []);

  // ── Pointer event handlers ────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    e.preventDefault();
    (e.target as HTMLVideoElement).setPointerCapture(e.pointerId);
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

  const onPointerMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!dragRef.current?.active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current.currentX = e.clientX - rect.left;
    dragRef.current.currentY = e.clientY - rect.top;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLVideoElement>) => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    dragRef.current = null;
    try {
      (e.target as HTMLVideoElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (e.button === 1) {
      void injectInput(session, { kind: "keyevent", code: KEYCODE_HOME });
      return;
    }
    if (e.button === 2) {
      void injectInput(session, { kind: "keyevent", code: KEYCODE_BACK });
      return;
    }

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

  const onWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 1 : -1;
    for (let i = 0; i < 2; i++) {
      sendSwipe(x, y, x, y + delta * 50, 100);
    }
  };

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
        <video
          ref={videoRef}
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