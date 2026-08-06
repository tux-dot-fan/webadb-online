"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  useAdbSession,
  useAdbState,
  useAdbSupported,
} from "@/lib/use-adb";
import { TopBar } from "@/components/TopBar";
import { LandingHero } from "@/components/LandingHero";
import { LauncherApp } from "@/components/LauncherApp";
import { DashApp } from "@/components/DashApp";
import { SettingsApp } from "@/components/SettingsApp";
import { ShellPanel, type ShellPanelHandle } from "@/components/ShellPanel";
import type { AdbSession } from "@/lib/adb-client";
import {
  REGISTERED_APPS, getApp,
  loadEnabled, loadOverrides,
  onPrefsChanged,
  type AppDefinition,
} from "@/lib/app-registry";

interface AppOverrides { showInDock?: boolean; launchOnStartup?: boolean }

// ── Window state ─────────────────────────────────────────────────────────────

type WindowId = string;

interface WinState {
  id: WindowId;
  appId: string; // registry id (was AppType, now string)
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  _savedW?: number; _savedH?: number; _savedX?: number; _savedY?: number;
  // Shell-only: initial command to run on PTY start
  shellCmd?: string;
}

const MIN_WIN_SIZE = { width: 320, height: 200 };
const WIN_OFFSET = 24;
const DEFAULT_WIN_SIZE = { width: 640, height: 420 };

// ── Workspace ────────────────────────────────────────────────────────────────

interface WorkspaceProps {
  buildVersion: string;
  buildGitHash: string;
  buildTimestamp: string;
}

export function Workspace({ buildVersion, buildGitHash, buildTimestamp }: WorkspaceProps) {
  const session = useAdbSession();

  // ── Enabled apps + per-app overrides (Settings → localStorage) ─────────
  // Workspace keeps a reactive copy of these settings so it can:
  //   • filter the Dock
  //   • close windows of apps that just got disabled
  //   • re-seed launchOnStartup windows
  // Writes happen in SettingsApp; this view re-reads via onPrefsChanged().
  const [enabledApps, setEnabledApps] = useState<Set<string>>(() =>
    typeof window === "undefined"
      ? new Set(REGISTERED_APPS.map((a) => a.id))
      : loadEnabled(REGISTERED_APPS)
  );
  const [appOverrides, setAppOverrides] = useState<AppOverrides>(() =>
    typeof window === "undefined" ? {} : loadOverrides()
  );

  useEffect(() => {
    return onPrefsChanged(() => {
      const next = loadEnabled(REGISTERED_APPS);
      setEnabledApps((prev) => {
        // Close any windows of apps that just got disabled.
        const newlyDisabled = [...prev].filter((id) => !next.has(id));
        if (newlyDisabled.length > 0) {
          setWindows((wins) => {
            const m = new Map(wins);
            for (const [wid, w] of m) {
              if (newlyDisabled.includes(w.appId)) m.delete(wid);
            }
            return m;
          });
          setActiveApps((active) => {
            const s = new Set(active);
            for (const id of newlyDisabled) s.delete(id);
            return s;
          });
        }
        return next;
      });
      setAppOverrides(loadOverrides());
    });
  }, []);

  /** Effective showInDock: registry default overridden by user setting. */
  function isInDock(app: AppDefinition): boolean {
    if (appOverrides.showInDock !== undefined) return appOverrides.showInDock;
    return app.showInDock !== false;
  }
  function isOnStartup(app: AppDefinition): boolean {
    if (appOverrides.launchOnStartup !== undefined) return appOverrides.launchOnStartup;
    return app.launchOnStartup === true;
  }

  // ── Windows state ────────────────────────────────────────────────────────
  const [windows, setWindows] = useState<Map<WindowId, WinState>>(() => {
    const m = new Map<WindowId, WinState>();
    // Seed with apps that should launch on startup. Cascade offset by index.
    const startups = REGISTERED_APPS.filter(isOnStartup);
    startups.forEach((app, i) => {
      const id = `${app.id}-1`;
      const w = app.defaultSize ?? DEFAULT_WIN_SIZE;
      m.set(id, {
        id,
        appId: app.id,
        x: 30 + i * WIN_OFFSET,
        y: 30 + i * WIN_OFFSET,
        width: w.width,
        height: w.height,
        zIndex: i + 1,
        minimized: false,
        maximized: false,
      });
    });
    return m;
  });

  const idCounterRef = useRef<Record<string, number>>({});
  // Initialize counters to 1 for each registered app (seeded window already uses 1)
  useEffect(() => {
    REGISTERED_APPS.forEach((a) => {
      if (idCounterRef.current[a.id] === undefined) idCounterRef.current[a.id] = 1;
    });
  }, []);

  const [topZ, setTopZ] = useState(() => {
    // topZ must be ≥ initial window zIndex count
    const startups = REGISTERED_APPS.filter(isOnStartup);
    return Math.max(1, startups.length);
  });

  // ── Overlay state (Apps / Search / Settings) ─────────────────────────
  // These three apps render as floating overlays above all windows rather
  // than as draggable windows with a title bar. Each is a single boolean:
  // when true, the overlay is visible; clicking an item inside the
  // overlay (e.g. a launcher tile) closes it and opens / focuses the
  // target app.

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * "Landing mode" is the in-between state where the user hasn't connected
   * yet and no app windows are open. In this mode the page behaves like a
   * regular web page — `document` scrolls naturally and the dock is hidden.
   * The moment the user connects a device or opens any window/overlay, we
   * flip into "desktop mode": `document.body` is locked at the viewport
   * height and the macOS-style chrome (dock, draggable windows, etc.) takes
   * over. This keeps the marketing page pleasant to read while preserving
   * the desktop metaphor once the user starts working.
   */
  const isLandingMode =
    session === null &&
    windows.size === 0 &&
    !launcherOpen &&
    !dashOpen &&
    !settingsOpen;

  // Mirror landing/desktop mode into <body>'s dataset so the CSS can decide
  // whether to lock `document` scrolling. Done via an effect (not a JSX
  // prop) so the rest of the page tree doesn't re-render on toggle.
  useEffect(() => {
    if (isLandingMode) {
      document.body.dataset.mode = "landing";
    } else {
      document.body.dataset.mode = "desktop";
    }
    return () => {
      // Reset on unmount so we don't leave the body class dangling if the
      // component is ever torn down (e.g. hot-reload during dev).
      delete document.body.dataset.mode;
    };
  }, [isLandingMode]);

  /**
   * Open or focus one of the overlay apps. If the overlay is already
   * visible this is a no-op (the overlay manages its own dismissal). If
   * it's hidden, we show it and bring it to the front of the overlay
   * stack by closing the others — only one overlay is visible at a time.
   */
  const toggleOverlay = useCallback((id: "launcher" | "dash" | "settings") => {
    if (id === "launcher") {
      setLauncherOpen((v) => {
        const next = !v;
        if (next) { setDashOpen(false); setSettingsOpen(false); }
        return next;
      });
    } else if (id === "dash") {
      setDashOpen((v) => {
        const next = !v;
        if (next) { setLauncherOpen(false); setSettingsOpen(false); }
        return next;
      });
    } else {
      setSettingsOpen((v) => {
        const next = !v;
        if (next) { setLauncherOpen(false); setDashOpen(false); }
        return next;
      });
    }
  }, []);

  const closeOverlay = useCallback((id: "launcher" | "dash" | "settings") => {
    if (id === "launcher") setLauncherOpen(false);
    else if (id === "dash") setDashOpen(false);
    else setSettingsOpen(false);
  }, []);

  // Track which apps have at least one open window (for Dock dot indicator)
  const [activeApps, setActiveApps] = useState<Set<string>>(() => {
    const s = new Set<string>();
    REGISTERED_APPS.filter(isOnStartup).forEach((a) => s.add(a.id));
    return s;
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function nextId(appId: string): WindowId {
    const cur = idCounterRef.current;
    cur[appId] = (cur[appId] ?? 0) + 1;
    return `${appId}-${cur[appId]}`;
  }

  // ── Window lifecycle ─────────────────────────────────────────────────────

  const openWindow = useCallback((
    appId: string,
    opts?: { shellCmd?: string; minimizeIfOpen?: boolean },
  ) => {
    const app = getApp(appId);
    if (!app) return;
    if (!enabledApps.has(appId)) return;

    // Overlay apps (Apps / Search / Settings) don't use the windows map —
    // they're floating fullscreen / modal layers rendered above windows.
    if (app.isOverlay) {
      toggleOverlay(appId as "launcher" | "dash" | "settings");
      return;
    }

    // Single-window apps: focus the existing window instead of opening a new one.
    if (app.allowMultipleWindows === false) {
      const existing = [...windows.entries()].find(([, w]) => w.appId === appId);
      if (existing) {
        // When invoked from the launcher (minimizeIfOpen), minimize the
        // existing window instead of bringing it forward. The launcher
        // contract is "click an already-running app → minimize it".
        if (opts?.minimizeIfOpen) {
          setWindows((prev) => {
            const next = new Map(prev);
            next.set(existing[0], { ...existing[1], minimized: true });
            return next;
          });
          return;
        }
        setWindows((prev) => {
          const next = new Map(prev);
          const w = { ...existing[1], minimized: false };
          next.set(existing[0], w);
          return next;
        });
        bringToFrontRef.current?.(existing[0]);
        return;
      }
    }

    setActiveApps((prev) => new Set(prev).add(appId));

    setTopZ((z) => {
      const next = z + 1;
      const newId = nextId(appId);

      setWindows((prev) => {
        if (prev.has(newId)) return prev;
        const count = prev.size;
        const def = app.defaultSize ?? DEFAULT_WIN_SIZE;
        const w: WinState = {
          id: newId,
          appId,
          x: 30 + (count % 6) * WIN_OFFSET,
          y: 30 + (count % 6) * WIN_OFFSET,
          width: def.width,
          height: def.height,
          zIndex: next,
          minimized: false,
          maximized: false,
          shellCmd: opts?.shellCmd,
        };
        return new Map(prev).set(newId, w);
      });

      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledApps, windows]);

  // bringToFront needs to be referenced inside openWindow. We use a ref
  // so we can update it without making openWindow's deps circular.
  const bringToFrontRef = useRef<((id: WindowId) => void) | null>(null);

  const closeWindow = useCallback((id: WindowId) => {
    setWindows((prev) => {
      const next = new Map(prev);
      const win = next.get(id);
      next.delete(id);
      if (win && ![...next.values()].some((w) => w.appId === win.appId)) {
        setActiveApps((active) => {
          const next2 = new Set(active);
          next2.delete(win.appId);
          return next2;
        });
      }
      return next;
    });
  }, []);

  const toggleMinimize = useCallback((id: WindowId) => {
    setWindows((prev) => {
      const win = prev.get(id);
      if (!win) return prev;
      return new Map(prev).set(id, { ...win, minimized: !win.minimized });
    });
  }, []);

  const toggleMaximizeWithSave = useCallback((id: WindowId) => {
    setWindows((prev) => {
      const win = prev.get(id);
      if (!win) return prev;
      if (win.maximized) {
        const w: WinState = {
          ...win,
          maximized: false,
          x: win._savedX ?? win.x,
          y: win._savedY ?? win.y,
          width: win._savedW ?? win.width,
          height: win._savedH ?? win.height,
        };
        return new Map(prev).set(id, w);
      } else {
        const w: WinState = {
          ...win,
          maximized: true,
          _savedW: win.width,
          _savedH: win.height,
          _savedX: win.x,
          _savedY: win.y,
          x: 0, y: 0,
          width: 100, height: 100,
        };
        return new Map(prev).set(id, w);
      }
    });
  }, []);

  const bringToFront = useCallback((id: WindowId) => {
    setTopZ((z) => {
      const next = z + 1;
      setWindows((prev) => {
        const win = prev.get(id);
        if (!win) return prev;
        return new Map(prev).set(id, { ...win, zIndex: next });
      });
      return next;
    });
  }, []);
  bringToFrontRef.current = bringToFront;

  // ── Drag state ───────────────────────────────────────────────────────────

  const [drag, setDrag] = useState<{
    id: WindowId; startX: number; startY: number;
    startWinX: number; startWinY: number;
  } | null>(null);

  const [resize, setResize] = useState<{
    id: WindowId; startX: number; startY: number;
    startW: number; startH: number;
    startWinX: number; startWinY: number;
  } | null>(null);

  useEffect(() => {
    if (!drag && !resize) return;

    const onMove = (e: MouseEvent) => {
      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        setWindows((prev) => {
          const win = prev.get(drag.id);
          if (!win) return prev;
          return new Map(prev).set(drag.id, {
            ...win,
            x: drag.startWinX + dx,
            y: drag.startWinY + dy,
          });
        });
      }
      if (resize) {
        const dx = e.clientX - resize.startX;
        const dy = e.clientY - resize.startY;
        setWindows((prev) => {
          const win = prev.get(resize.id);
          if (!win) return prev;
          return new Map(prev).set(resize.id, {
            ...win,
            width: Math.max(MIN_WIN_SIZE.width, resize.startW + dx),
            height: Math.max(MIN_WIN_SIZE.height, resize.startH + dy),
            x: resize.startWinX,
            y: resize.startWinY,
          });
        });
      }
    };

    const onUp = () => { setDrag(null); setResize(null); };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, resize]);

  // ── Shell initial command state ──────────────────────────────────────────

  const [shellInitialCmd, setShellInitialCmd] = useState<string | null>(null);

  // Refs to live ShellPanel instances, keyed by window id. Used so
  // `openShellWindow` (below) can call `runCommand` after the new
  // window mounts and the PTY has actually started.
  const shellHandlesRef = useRef<Map<WindowId, ShellPanelHandle>>(new Map());

  const openShellWindow = useCallback((cwd?: string, command?: string) => {
    if (cwd) {
      const cmd = command ? `cd "${cwd}" && ${command}` : `cd "${cwd}" && pwd`;
      setShellInitialCmd(cmd);
      openWindow("shell", { shellCmd: cmd });
    } else {
      openWindow("shell");
    }
  }, [openWindow]);

  /**
   * Re-inject the pending initial command into a freshly-mounted shell
   * window. Called by DesktopWindow once the ShellPanel reports its
   * imperative handle (so the PTY writer is ready).
   */
  const registerShellHandle = useCallback((id: WindowId, handle: ShellPanelHandle | null) => {
    if (handle) {
      shellHandlesRef.current.set(id, handle);
      // If this window was opened with a pending initial command, run it
      // now — the first PTY handshake is complete by the time the handle
      // is exposed. `shellInitialCmd` is read once and cleared so a
      // future window (opened with no command) doesn't get a stale one.
      const pending = shellInitialCmd;
      if (pending && windows.get(id)?.shellCmd === pending) {
        handle.runCommand(pending);
        setShellInitialCmd(null);
      } else {
        handle.focus();
      }
    } else {
      shellHandlesRef.current.delete(id);
    }
  }, [shellInitialCmd, windows]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  //
  // Cmd+K / Ctrl+K → open the Search app (Dash). Re-focuses if already open
  // since Dash is `allowMultipleWindows: false`.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in an input/textarea/contenteditable — otherwise
      // every keystroke in the terminal or file input would summon Dash.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
          target.isContentEditable
        ) return;
      }
      // Cmd+K on macOS, Ctrl+K elsewhere.
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        openWindow("dash");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openWindow]);

  // ── Derived state for render ─────────────────────────────────────────────

  const enabledAppsList = REGISTERED_APPS.filter((a) => enabledApps.has(a.id));
  const dockAppsList = enabledAppsList.filter(isInDock);

  const topWinId = (() => {
    let top = 0;
    let topId: WindowId | null = null;
    windows.forEach((w, id) => {
      if (!w.minimized && w.zIndex >= top) {
        top = w.zIndex;
        topId = id;
      }
    });
    return topId;
  })();
  const topWin = topWinId ? windows.get(topWinId) : null;

  return (
    <div className="app-shell">
      {/* ── Top menu bar (macOS-style) ─────────────────────────────── */}
      <TopBar
        focusedTitle={topWin ? getApp(topWin.appId)?.title : undefined}
        focusedIcon={topWin ? getApp(topWin.appId)?.icon : undefined}
        // When the focused window is maximized we mirror its titlebar's
        // three control buttons (min / max / close) into the topbar so
        // the window's own titlebar can disappear and the window content
        // flows directly under the global topbar. The button group is
        // rendered only when there's a focused window — without one,
        // there's nothing to control.
        windowControls={
          topWin
            ? {
                isMaximized: topWin.maximized,
                onMinimize: () => toggleMinimize(topWin.id),
                onMaximize: () => toggleMaximizeWithSave(topWin.id),
                onClose: () => closeWindow(topWin.id),
              }
            : undefined
        }
        buildVersion={buildVersion}
        buildGitHash={buildGitHash}
        onOpenApps={() => setLauncherOpen(true)}
        onOpenSearch={() => setDashOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* ── Desktop area ────────────────────────────────────────────── */}
      <div className="desktop-area">
        {/* LandingHero is shown only in true landing mode — i.e. before
            the user has connected a device AND no app windows are open
            AND no overlay is active. Once connected, even with zero
            windows open, the user is in "desktop mode" and sees the
            dock against a clean desktop rather than the marketing
            page. The `isLandingMode` derivation already factors in
            `session === null`, so we just reuse it. */}
        {isLandingMode && (
          <LandingHero />
        )}

        <div className="windows-layer">
          {[...windows.values()].map((win) => {
            const def = getApp(win.appId);
            if (!def) return null; // app was unregistered — skip
            const isTop = topWinId === win.id;
            const isDragging = drag?.id === win.id;
            const isResizing = resize?.id === win.id;
            const Panel = def.Component;

            return (
              <DesktopWindow
                key={win.id}
                win={win}
                def={def}
                Panel={Panel}
                session={session}
                focused={isTop}
                dragging={isDragging}
                resizing={isResizing}
                onFocus={() => bringToFront(win.id)}
                onClose={() => closeWindow(win.id)}
                onMinimize={() => toggleMinimize(win.id)}
                onMaximize={() => toggleMaximizeWithSave(win.id)}
                onTitlebarMouseDown={(e) => {
                  if (win.maximized) return;
                  e.preventDefault();
                  bringToFront(win.id);
                  setDrag({
                    id: win.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    startWinX: win.x,
                    startWinY: win.y,
                  });
                }}
                onResizeMouseDown={(e) => {
                  if (win.maximized) return;
                  e.preventDefault();
                  e.stopPropagation();
                  bringToFront(win.id);
                  setResize({
                    id: win.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    startW: win.width,
                    startH: win.height,
                    startWinX: win.x,
                    startWinY: win.y,
                  });
                }}
                shellInitialCmd={shellInitialCmd}
                onShellOpen={openShellWindow}
                onLaunchApp={openWindow}
                onShellHandle={(handle) => registerShellHandle(win.id, handle)}
              />
            );
          })}
        </div>

        {/* ── Overlays (Apps / Search / Settings) ────────────────────────
            Rendered above all windows. launcher = fullscreen, dash +
            settings = centered modals. They each get a "minimize on
            outside click" or "click tile to open" handler. */}
        {launcherOpen && (
          <LauncherOverlay
            onClose={() => setLauncherOpen(false)}
            onLaunch={(id) => {
              // Hide the launcher and open the target app. minimizeIfOpen
              // ensures that clicking an already-running app minimizes
              // its window instead of bringing it back to focus.
              setLauncherOpen(false);
              openWindow(id, { minimizeIfOpen: true });
            }}
          />
        )}
        {dashOpen && (
          <DashOverlay
            onClose={() => setDashOpen(false)}
            onLaunch={(id) => {
              setDashOpen(false);
              openWindow(id);
            }}
          />
        )}
        {settingsOpen && (
          <SettingsOverlay onClose={() => setSettingsOpen(false)} />
        )}

        {/* ── Dock (anchored to bottom of desktop area, above content) ─
            Hidden in landing mode — the marketing page doesn't need it and
            the user should be reading top-to-bottom without chrome in the
            way. As soon as a device is connected or any window/overlay is
            open, the dock fades in. */}
        {!isLandingMode && (
        <nav className="dock" role="navigation" aria-label="Applications">
        {dockAppsList.map((app) => {
          // For overlay apps (Apps / Search / Settings), "active" means
          // the overlay is currently visible. For regular apps it means
          // a window is open. Either way, the dot on the dock icon tells
          // the user the app is "running".
          const isActive = app.isOverlay
            ? (app.id === "launcher" ? launcherOpen
              : app.id === "dash" ? dashOpen
              : settingsOpen)
            : activeApps.has(app.id);
          const isTopApp = topWin?.appId === app.id;
          return (
            <DockItem
              key={app.id}
              app={app}
              active={isActive}
              focused={isTopApp}
              onClick={() => {
                if (app.isOverlay) {
                  // Overlay apps toggle their floating layer.
                  toggleOverlay(app.id as "launcher" | "dash" | "settings");
                  return;
                }
                if (isActive && app.allowMultipleWindows !== false) {
                  // Focus existing window of this type
                  const existing = [...windows.entries()].find(([, w]) => w.appId === app.id);
                  if (existing) bringToFront(existing[0]);
                  else openWindow(app.id);
                } else {
                  openWindow(app.id);
                }
              }}
              onRightClick={(e) => {
                e.preventDefault();
                if (app.isOverlay) {
                  toggleOverlay(app.id as "launcher" | "dash" | "settings");
                  return;
                }
                if (app.allowMultipleWindows === false) {
                  openWindow(app.id);
                } else {
                  openWindow(app.id);
                }
              }}
            />
          );
        })}
      </nav>
        )}
      </div>
    </div>
  );
}

// ── DesktopWindow ─────────────────────────────────────────────────────────────

interface DesktopWindowProps {
  win: WinState;
  def: AppDefinition;
  Panel: AppDefinition["Component"];
  focused: boolean;
  dragging: boolean;
  resizing: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onTitlebarMouseDown: (e: React.MouseEvent) => void;
  onResizeMouseDown: (e: React.MouseEvent) => void;
  session: ReturnType<typeof useAdbSession>;
  shellInitialCmd?: string | null;
  onShellOpen?: (cwd?: string, command?: string) => void;
  onLaunchApp?: (appId: string) => void;
  /**
   * Called once with the live ShellPanel handle when this window is a
   * shell and once more with `null` on unmount. Non-shell windows never
   * call this. Lets Workspace inject a pending initial command into the
   * PTY after the handshake completes.
   */
  onShellHandle?: (handle: ShellPanelHandle | null) => void;
}

function DesktopWindow({
  win, def, Panel, focused, dragging, resizing,
  onFocus, onClose, onMinimize, onMaximize,
  onTitlebarMouseDown, onResizeMouseDown, session,
  shellInitialCmd, onShellOpen, onLaunchApp, onShellHandle,
}: DesktopWindowProps) {
  // Apps that don't need an ADB session (Launcher / Dash / Settings) render
  // even before a device is connected. Everything else gates on session.
  if (def.requiresSession !== false && !session) return null;
  if (win.minimized) return null;

  // From here on, every panel receives `session` in its prop types — even
  // apps that don't need ADB. For those we pass a sentinel object; the
  // panel must ignore it (Launcher / Dash / Settings do).
  const safeSession: ReturnType<typeof useAdbSession> = session ?? ({} as ReturnType<typeof useAdbSession>);

  const isMaximized = win.maximized;

  const style: React.CSSProperties = isMaximized
    ? { top: 0, left: 0, width: "100%", height: "100%", zIndex: win.zIndex }
    : { top: win.y, left: win.x, width: win.width, height: win.height, zIndex: win.zIndex };

  // The Shell panel is the only app that uses forwardRef +
  // useImperativeHandle — Workspace needs to call runCommand() once the
  // PTY is ready (so commands from File Manager's "Open shell here" or
  // the sidebar don't race the first handshake). We branch here on
  // the app id rather than passing the ref via the generic Panel
  // component, because every other registered app ignores refs.
  //
  // Tech debt note: the "right" registry-native fix is to lift the
  // imperative-handle contract into AppDefinition (e.g. a
  // `imperativeHandle?: boolean` flag plus an `AppProps.ref` field), so
  // DesktopWindow can render all apps through the same branch. Skipped
  // here to keep this commit small — any new component that wants
  // ref-forwarding will need the same wrapper until the registry grows
  // that flag.
  const isShell = win.appId === "shell";

  const panelNode = isShell ? (
    <ShellPanel
      ref={(h) => onShellHandle?.(h)}
      session={safeSession as AdbSession}
      initialCommand={shellInitialCmd ?? win.shellCmd ?? undefined}
    />
  ) : (
    <Panel
      session={safeSession as never}
      onOpenShell={onShellOpen ? (cwd) => onShellOpen(cwd) : undefined}
      onLaunchApp={onLaunchApp}
    />
  );

  return (
    <div
      className={[
        "desktop-window",
        focused ? "focused" : "",
        dragging ? "dragging" : "",
        resizing ? "resizing" : "",
        isMaximized ? "maximized" : "",
      ].join(" ")}
      style={style}
      onMouseDown={onFocus}
    >
      <div
        className="window-titlebar"
        onMouseDown={onTitlebarMouseDown}
        onDoubleClick={onMaximize}
      >
        <span className="window-title-icon">{def.icon}</span>
        <span className="window-title-text">{def.title}</span>
        <div className="window-controls">
          <button
            className="window-ctrl window-ctrl-minimize"
            onClick={(e) => { e.stopPropagation(); onMinimize(); }}
            title="Minimize"
            aria-label="Minimize window"
          >
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button
            className="window-ctrl window-ctrl-maximize"
            onClick={(e) => { e.stopPropagation(); onMaximize(); }}
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
          >
            {isMaximized
              ? <svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1"/><rect x="0" y="2" width="8" height="8" fill="var(--bg-elev)" stroke="currentColor" strokeWidth="1"/></svg>
              : <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
            }
          </button>
          <button
            className="window-ctrl window-ctrl-close"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Close"
            aria-label="Close window"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="window-content">
        {panelNode}
      </div>

      {!isMaximized && (
        <div
          className="window-resize-handle"
          onMouseDown={onResizeMouseDown}
          title="Drag to resize"
          aria-label="Resize window"
        />
      )}
    </div>
  );
}

// ── Dock item ────────────────────────────────────────────────────────────────

interface DockItemProps {
  app: AppDefinition;
  active: boolean;
  focused: boolean;
  onClick: () => void;
  onRightClick: (e: React.MouseEvent) => void;
}

function DockItem({ app, active, focused, onClick, onRightClick }: DockItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const rect = btnRef.current?.getBoundingClientRect();
    setMenuPos({ x: rect ? rect.left : e.clientX, y: rect ? rect.top - 8 : e.clientY - 48 });
    setMenuOpen(true);
  }

  return (
    <div className="dock-item-wrap" ref={menuRef}>
      <button
        className={[
          "dock-item",
          active ? "active" : "",
          focused ? "focused" : "",
        ].join(" ")}
        ref={btnRef}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        title={`${app.title}\nRight-click for New Window`}
        aria-label={`Open ${app.title}`}
      >
        <span className="dock-icon">{app.icon}</span>
        {active && <span className="dock-dot" />}
      </button>

      {menuOpen && (
        <div
          className="dock-ctx-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          role="menu"
        >
          <button
            className="dock-ctx-item"
            onClick={() => {
              onRightClick({ preventDefault: () => {} } as React.MouseEvent);
              setMenuOpen(false);
            }}
            role="menuitem"
          >
            🪟 New Window
          </button>
        </div>
      )}
    </div>
  );
}

// ── Overlay apps (Apps / Search / Settings) ────────────────────────────────
//
// These three apps render as floating overlays above all windows rather
// than as regular draggable windows. Each overlay is independent of the
// `windows` map and renders inside `.desktop-area` so it stays clear of
// the sidebar and dock.

interface LauncherOverlayProps {
  onClose: () => void;
  onLaunch: (appId: string) => void;
}

function LauncherOverlay({ onClose, onLaunch }: LauncherOverlayProps) {
  // Esc closes the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Click on the dim background (but not on the launcher itself) closes.
  return (
    <div className="overlay overlay-fullscreen" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <LauncherApp onLaunchApp={onLaunch} />
    </div>
  );
}

interface DashOverlayProps {
  onClose: () => void;
  onLaunch: (appId: string) => void;
}

function DashOverlay({ onClose, onLaunch }: DashOverlayProps) {
  // Esc closes the overlay (Dash handles its own input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay overlay-modal" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="overlay-dash">
        <DashApp onLaunchApp={onLaunch} />
      </div>
    </div>
  );
}

interface SettingsOverlayProps {
  onClose: () => void;
}

function SettingsOverlay({ onClose }: SettingsOverlayProps) {
  // Esc closes the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay overlay-modal" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="overlay-settings">
        <SettingsApp />
      </div>
    </div>
  );
}