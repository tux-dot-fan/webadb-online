// ── Screencast Panel ─────────────────────────────────────────────────────────
//
// The 12th dock app. Streams the connected Android device's live screen
// to a <video> element inside the workspace, with pointer / wheel / drag
// events forwarded back to the device via `adb shell input` commands.
//
// Two modes:
//
//   - Quick Capture (default): straight screenrecord, captures whatever
//     is currently on screen. One click to start.
//
//   - Pick an app: launcher-style grid with a search box. User types
//     the app name, sees matching installed packages, clicks one, and
//     `am start <pkg>` runs on the device before screenrecord kicks in
//     so the user lands directly inside the chosen app.
//
// Both modes report their progress through a multi-step overlay:
//   1. spawning        adb shell screenrecord --size WxH --bit-rate R
//   2. first-chunk     device is sending H.264 bytes
//   3. config-parsed   SPS/PPS extracted, codec known (e.g. avc1.640028)
//   4. init-sent       ftyp+moov appended to SourceBuffer
//   5. first-frame     first moof+mdat appended
//   6. playing         first frame painted on screen
//
// If anything stalls, the user sees which step it's stuck on.

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
import type { ProgressKind } from "@/lib/screencast/types";
import { listInstalledPackages, launchPackage } from "@/lib/screencast/apps";

/** Keycodes used by the panel. Full table in Android's KeyEvent.java. */
const KEYCODE_HOME = 3;
const KEYCODE_BACK = 4;

function approxPpi(): number {
  return 440;
}

/** Human-readable label for each progress step. */
const PROGRESS_LABELS: Record<ProgressKind, string> = {
  spawning: "Spawning screenrecord on the device",
  "screenrecord-started": "Device screenrecord started",
  "first-chunk": "Receiving H.264 bytes",
  "config-parsed": "Parsed codec config",
  "init-sent": "Init segment appended to decoder",
  "first-frame": "First frame decoded",
  playing: "Playing",
};

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
  const [progress, setProgress] = useState<{
    step: ProgressKind;
    detail?: string;
    /** ms since the user clicked Start. Lets the user see "stuck
     *  for 4 s" without having to count. */
    elapsedMs: number;
  } | null>(null);
  /** Pre-stream mode: app picker vs. quick capture. */
  const [pickMode, setPickMode] = useState<"none" | "picker">("none");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerResults, setPickerResults] = useState<string[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerLaunching, setPickerLaunching] = useState<string | null>(null);

  // ── Start the pipeline (no app pre-launch) ─────────────────────────────
  const startStreaming = useCallback(async () => {
    if (pipelineRef.current) return;
    if (!session) return;
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    setStatus("starting");
    setErrorMsg("");
    setProgress({ step: "spawning", elapsedMs: 0 });
    const startTime = performance.now();

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
          setProgress(null);
        },
        onReady: () => {
          setStatus("running");
        },
        onProgress: (kind, detail) => {
          setProgress({
            step: kind,
            detail,
            elapsedMs: performance.now() - startTime,
          });
        },
      });
      pipelineRef.current = handle;
      setStats({
        bitrate: handle.bitrate,
        width: handle.encodedWidth,
        height: handle.encodedHeight,
      });
      // Clear progress once we're playing; the stats line in the
      // toolbar takes over as the live readout.
      setProgress(null);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  }, [session]);

  // ── Start the pipeline after launching a specific app ──────────────────
  const startAfterLaunch = useCallback(
    async (packageName: string) => {
      if (!session) return;
      setPickerLaunching(packageName);
      try {
        await launchPackage(session, packageName);
        // Give the app a moment to render its first frame before
        // screenrecord starts. 800 ms is enough for most apps to
        // finish their splash screen; slower apps will just show the
        // splash in the captured video, which is the right behavior.
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) {
        setErrorMsg(
          `Couldn't launch ${packageName}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        setPickerLaunching(null);
        return;
      }
      setPickerLaunching(null);
      setPickMode("none");
      setPickerQuery("");
      void startStreaming();
    },
    [session, startStreaming],
  );

  // ── Open the picker (prefetch installed packages) ──────────────────────
  const openPicker = useCallback(async () => {
    if (!session) return;
    setPickMode("picker");
    setPickerQuery("");
    setPickerLoading(true);
    try {
      const pkgs = await listInstalledPackages(session, { includeSystem: false });
      // Sort alphabetically; the search box will narrow this.
      setPickerResults(pkgs.sort((a, b) => a.localeCompare(b)));
    } catch (e) {
      setErrorMsg(
        `Couldn't list packages: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setPickerLoading(false);
    }
  }, [session]);

  const stop = useCallback(() => {
    pipelineRef.current?.stop();
    pipelineRef.current = null;
    setStatus("stopped");
    setStats(null);
    setProgress(null);
  }, []);

  // ── Fuzzy-filter the picker as the user types ──────────────────────────
  useEffect(() => {
    if (pickMode !== "picker") return;
    if (pickerQuery.trim() === "") {
      // Show first 80 by default to keep the grid cheap.
      setPickerResults((cur) => cur.slice(0, 80));
      return;
    }
    // Already loaded all in openPicker; we filter the cached list.
    // (We don't re-fetch on every keystroke.)
  }, [pickerQuery, pickMode]);

  // ── Pointer / wheel / drag → adb shell input ───────────────────────────
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

  useEffect(() => {
    if (!containerRef.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (status === "running" && pipelineRef.current) {
          stop();
          void startStreaming();
        }
      }, 250);
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [status, startStreaming, stop]);

  useEffect(() => {
    return () => {
      pipelineRef.current?.stop();
      pipelineRef.current = null;
    };
  }, []);

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

  // ── Filtered picker results (lazy fuzzy) ───────────────────────────────
  const filteredPicker = pickerQuery.trim() === ""
    ? pickerResults.slice(0, 80)
    : pickerResults
        .filter((p) =>
          p.toLowerCase().includes(pickerQuery.trim().toLowerCase()),
        )
        .slice(0, 80);

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
          <>
            <button
              type="button"
              className="screencast-btn screencast-btn-start"
              onClick={startStreaming}
              disabled={status === "starting" || pickerLoading !== false}
              title="Capture whatever is currently on the device screen."
            >
              ▶ Quick Capture
            </button>
            <button
              type="button"
              className="screencast-btn screencast-btn-pick"
              onClick={openPicker}
              disabled={status === "starting" || pickMode === "picker"}
              title="Pick an installed app to launch first, then capture."
            >
              🔎 Pick an app
            </button>
          </>
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

        {/* ── Multi-step progress overlay (visible while starting) ── */}
        {status === "starting" && progress && (
          <div className="screencast-overlay screencast-progress">
            <div className="screencast-progress-title">
              Starting…
            </div>
            <ol className="screencast-progress-list">
              {(Object.keys(PROGRESS_LABELS) as ProgressKind[]).map((k) => {
                const order = (Object.keys(PROGRESS_LABELS) as ProgressKind[]).indexOf(k);
                const currentOrder = (Object.keys(PROGRESS_LABELS) as ProgressKind[]).indexOf(progress.step);
                const state =
                  order < currentOrder
                    ? "done"
                    : order === currentOrder
                    ? "active"
                    : "todo";
                return (
                  <li key={k} className={`screencast-progress-step is-${state}`}>
                    <span className="screencast-progress-bullet">
                      {state === "done" ? "✓" : state === "active" ? "•" : " "}
                    </span>
                    <span className="screencast-progress-label">
                      {PROGRESS_LABELS[k]}
                    </span>
                    {state === "active" && progress.detail && (
                      <span className="screencast-progress-detail">
                        {progress.detail}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="screencast-progress-elapsed">
              {(progress.elapsedMs / 1000).toFixed(1)} s
            </div>
          </div>
        )}

        {/* ── Pre-stream app picker ── */}
        {pickMode === "picker" && (
          <div className="screencast-overlay screencast-picker">
            <div className="screencast-picker-header">
              <input
                type="text"
                className="screencast-picker-input"
                placeholder="Search installed apps…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="screencast-btn screencast-btn-cancel"
                onClick={() => {
                  setPickMode("none");
                  setPickerQuery("");
                }}
              >
                Cancel
              </button>
            </div>
            {pickerLoading ? (
              <div className="screencast-picker-loading">
                Listing installed apps…
              </div>
            ) : (
              <>
                <div className="screencast-picker-hint">
                  {filteredPicker.length} apps{pickerQuery && ` matching "${pickerQuery}"`}
                </div>
                <div className="screencast-picker-grid">
                  {filteredPicker.map((pkg) => (
                    <button
                      key={pkg}
                      type="button"
                      className={`screencast-picker-item${
                        pickerLaunching === pkg ? " is-launching" : ""
                      }`}
                      onClick={() => void startAfterLaunch(pkg)}
                      disabled={pickerLaunching !== null}
                      title={pkg}
                    >
                      <span className="screencast-picker-icon" aria-hidden>
                        📦
                      </span>
                      <span className="screencast-picker-name">
                        {pkg.split(".").pop()}
                      </span>
                      <span className="screencast-picker-pkg">{pkg}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Idle / stopped / error overlay ── */}
        {status !== "running" && status !== "starting" && pickMode !== "picker" && (
          <div className="screencast-overlay">
            {status === "idle" && (
              <div className="screencast-overlay-text">
                Press <kbd>▶ Quick Capture</kbd> to stream whatever is on
                the device screen, or <kbd>🔎 Pick an app</kbd> to choose
                an installed app to launch first. Click and drag on the
                stream to control the device.
              </div>
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