"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { DevicePanel } from "@/components/DevicePanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import {
  useAdbSession,
  useAdbState,
  useAdbSupported,
} from "@/lib/use-adb";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  REGISTERED_APPS, getApp, loadEnabled, saveEnabled,
  type AppDefinition,
} from "@/lib/app-registry";

// ── Per-app UI overrides (localStorage) ────────────────────────────────────
//
// The registry has static defaults (showInDock / launchOnStartup), but the
// Settings panel can override them per-user. We persist those overrides
// under this single key as a record.

const APP_OVERRIDES_KEY = "webadb.apps.overrides";
interface AppOverrides { showInDock?: boolean; launchOnStartup?: boolean }

function loadAppOverrides(): AppOverrides {
  try {
    return JSON.parse(localStorage.getItem(APP_OVERRIDES_KEY) ?? "{}");
  } catch { return {}; }
}

function saveAppOverrides(o: AppOverrides): void {
  try { localStorage.setItem(APP_OVERRIDES_KEY, JSON.stringify(o)); }
  catch { /* ignore */ }
}

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

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Workspace ────────────────────────────────────────────────────────────────

interface WorkspaceProps {
  buildVersion: string;
  buildGitHash: string;
  buildTimestamp: string;
}

export function Workspace({ buildVersion, buildGitHash, buildTimestamp }: WorkspaceProps) {
  const state = useAdbState();
  const session = useAdbSession();
  const supported = useAdbSupported();

  // ── Enabled apps + per-app overrides (Settings → localStorage) ─────────
  const [enabledApps, setEnabledApps] = useState<Set<string>>(() =>
    typeof window === "undefined"
      ? new Set(REGISTERED_APPS.map((a) => a.id))
      : loadEnabled(REGISTERED_APPS)
  );
  useEffect(() => {
    saveEnabled(enabledApps);
  }, [enabledApps]);

  const [appOverrides, setAppOverrides] = useState<AppOverrides>(() =>
    typeof window === "undefined" ? {} : loadAppOverrides()
  );
  useEffect(() => {
    saveAppOverrides(appOverrides);
  }, [appOverrides]);

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

  const openWindow = useCallback((appId: string, opts?: { shellCmd?: string }) => {
    const app = getApp(appId);
    if (!app) return;
    if (!enabledApps.has(appId)) return;

    // Single-window apps: focus the existing window instead of opening a new one.
    if (app.allowMultipleWindows === false) {
      const existing = [...windows.entries()].find(([, w]) => w.appId === appId);
      if (existing) {
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

  // ── Sidebar collapse state ──────────────────────────────────────────────

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("webadb.sidebar.collapsed") === "1";
  });
  useEffect(() => {
    try { localStorage.setItem("webadb.sidebar.collapsed", sidebarCollapsed ? "1" : "0"); }
    catch { /* ignore */ }
  }, [sidebarCollapsed]);

  // ── Shell initial command state ──────────────────────────────────────────

  const [shellInitialCmd, setShellInitialCmd] = useState<string | null>(null);

  const openShellWindow = useCallback((cwd?: string, command?: string) => {
    if (cwd) {
      const cmd = command ? `cd "${cwd}" && ${command}` : `cd "${cwd}" && pwd`;
      setShellInitialCmd(cmd);
      openWindow("shell", { shellCmd: cmd });
    } else {
      openWindow("shell");
    }
  }, [openWindow]);

  // ── Settings toggles ─────────────────────────────────────────────────────

  const toggleEnabled = useCallback((id: string, en: boolean) => {
    setEnabledApps((prev) => {
      const next = new Set(prev);
      if (en) next.add(id); else next.delete(id);
      return next;
    });
    // If disabling, close any open windows of this app
    if (!en) {
      setWindows((prev) => {
        const next = new Map(prev);
        for (const [wid, w] of next) {
          if (w.appId === id) next.delete(wid);
        }
        return next;
      });
      setActiveApps((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const toggleShowInDock = useCallback((id: string, val: boolean) => {
    setAppOverrides((o) => ({ ...o, showInDock: val }));
  }, []);

  const toggleLaunchOnStartup = useCallback((id: string, val: boolean) => {
    setAppOverrides((o) => ({ ...o, launchOnStartup: val }));
  }, []);

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
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      {/* ── Left sidebar ─────────────────────────────────────────────── */}
      <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <div className="sidebar-brand">
          <span className="brand-icon">🧊</span>
          <span className="brand-name">WebADB</span>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </div>
        {!sidebarCollapsed && (
          <div className="sidebar-section">
            <p className="sidebar-label">Device</p>
            <DevicePanel state={state} session={session} supported={supported} />
            <p className="sidebar-label" style={{ marginTop: 12 }}>Settings</p>
            <SettingsPanel
              session={session!}
              enabled={enabledApps}
              onToggle={toggleEnabled}
              onToggleDock={toggleShowInDock}
              onToggleStartup={toggleLaunchOnStartup}
            />
          </div>
        )}
        <div className="sidebar-footer">
          {!sidebarCollapsed && <ThemeToggle />}
          <div className="sidebar-build-info" title={`Git: ${buildGitHash}\nBuilt: ${buildTimestamp}`}>
            <span className="ver-ver">{buildVersion}</span>
            <span className="ver-hash">{buildGitHash !== "dev" ? buildGitHash.slice(0, 7) : "dev"}</span>
            <span className="ver-time">{buildTimestamp !== "dev" ? formatTimestamp(buildTimestamp) : "—"}</span>
          </div>
        </div>
      </aside>

      {/* ── Desktop area ────────────────────────────────────────────── */}
      <div className="desktop-area">
        {windows.size === 0 && (
          <div className="hero">
            <div className="hero-icon">🧊</div>
            <h1 className="hero-title">WebADB</h1>
            <p className="hero-desc">
              Connect an Android device via USB and manage it directly from your browser.
            </p>
            <p className="hero-hint">
              Pick an app from the Dock below ↓
            </p>
          </div>
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
              />
            );
          })}
        </div>
      </div>

      {/* ── Dock ─────────────────────────────────────────────────────── */}
      <nav className="dock" role="navigation" aria-label="Applications">
        {dockAppsList.map((app) => {
          const isActive = activeApps.has(app.id);
          const isTopApp = topWin?.appId === app.id;
          return (
            <DockItem
              key={app.id}
              app={app}
              active={isActive}
              focused={isTopApp}
              onClick={() => {
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
}

function DesktopWindow({
  win, def, Panel, focused, dragging, resizing,
  onFocus, onClose, onMinimize, onMaximize,
  onTitlebarMouseDown, onResizeMouseDown, session,
  shellInitialCmd, onShellOpen,
}: DesktopWindowProps) {
  if (!session) return null;
  if (win.minimized) return null;

  const isMaximized = win.maximized;

  const style: React.CSSProperties = isMaximized
    ? { top: 0, left: 0, width: "100%", height: "100%", zIndex: win.zIndex }
    : { top: win.y, left: win.x, width: win.width, height: win.height, zIndex: win.zIndex };

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
        <Panel
          session={session}
          onOpenShell={onShellOpen ? (cwd) => onShellOpen(cwd) : undefined}
        />
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