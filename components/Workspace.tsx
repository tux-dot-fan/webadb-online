"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { DevicePanel } from "@/components/DevicePanel";
import { ShellPanel } from "@/components/ShellPanel";
import { ApkInstallPanel } from "@/components/ApkInstallPanel";
import { FileManagerPanel } from "@/components/FileManagerPanel";
import { ScreenshotPanel } from "@/components/ScreenshotPanel";
import { AppManagerPanel } from "@/components/AppManagerPanel";
import { LogcatPanel } from "@/components/LogcatPanel";
import { WiFiAdbPanel } from "@/components/WiFiAdbPanel";
import {
  useAdbSession,
  useAdbState,
  useAdbSupported,
} from "@/lib/use-adb";
import { ThemeToggle } from "@/components/ThemeToggle";

// ── App registry ─────────────────────────────────────────────────────────────

type AppType = "shell" | "apps" | "logcat" | "files" | "screenshot" | "apk" | "wifi";

interface AppDef {
  id: AppType;
  title: string;
  icon: string;
}

const APPS: AppDef[] = [
  { id: "shell",       title: "Terminal",     icon: "🐚" },
  { id: "apps",        title: "Apps",          icon: "📱" },
  { id: "logcat",      title: "Logcat",        icon: "📋" },
  { id: "files",       title: "File Manager",  icon: "📁" },
  { id: "screenshot",  title: "Screenshot",    icon: "🖼" },
  { id: "apk",         title: "Install APK",   icon: "📦" },
  { id: "wifi",        title: "Wi-Fi ADB",     icon: "📶" },
];

// ── Window state ─────────────────────────────────────────────────────────────

// Each window instance gets a unique string ID (e.g. "shell-2")
type WindowId = string;

interface WinState {
  id: WindowId;
  appId: AppType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  // Saved geometry for restore after maximize
  _savedW?: number;
  _savedH?: number;
  _savedX?: number;
  _savedY?: number;
  // Shell-only: initial command to run on PTY start
  shellCmd?: string;
}

const DEFAULT_WIN_SIZE = { width: 640, height: 420 };
const MIN_WIN_SIZE = { width: 320, height: 200 };
const WIN_OFFSET = 24; // cascade offset per new window

// Format ISO timestamp → compact "YYYY-MM-DD HH:MM" local time
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

  // All open window instances (key = unique WindowId)
  const [windows, setWindows] = useState<Map<WindowId, WinState>>(() => {
    const m = new Map<WindowId, WinState>();
    m.set("shell-1", {
      id: "shell-1", appId: "shell",
      x: 30, y: 30, width: 640, height: 420,
      zIndex: 1, minimized: false, maximized: false,
    });
    return m;
  });

  // Counter for generating unique window IDs (e.g. "shell-2", "shell-3")
  const idCounterRef = useRef({ shell: 1 });

  // Topmost zIndex counter
  const [topZ, setTopZ] = useState(1);

  // Which app types are visible in the Dock "active" indicator
  const [activeApps, setActiveApps] = useState<Set<AppType>>(new Set(["shell"]));

  // Sidebar collapse state — persisted to localStorage
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("webadb.sidebar.collapsed") === "1";
  });
  useEffect(() => {
    try { localStorage.setItem("webadb.sidebar.collapsed", sidebarCollapsed ? "1" : "0"); }
    catch { /* ignore */ }
  }, [sidebarCollapsed]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function nextId(appId: AppType): WindowId {
    const n = ++idCounterRef.current[appId as keyof typeof idCounterRef.current];
    return `${appId}-${n}`;
  }

  // ── Window lifecycle ─────────────────────────────────────────────────────

  const openWindow = useCallback((
    appId: AppType,
    opts?: { shellCmd?: string }
  ) => {
    setActiveApps((prev) => new Set(prev).add(appId));

    setTopZ((z) => {
      const next = z + 1;
      const newId = nextId(appId);

      setWindows((prev) => {
        if (prev.has(newId)) return prev;
        const count = prev.size;
        const x = 30 + (count % 6) * WIN_OFFSET;
        const y = 30 + (count % 6) * WIN_OFFSET;
        const w: WinState = {
          id: newId,
          appId,
          x, y,
          width: DEFAULT_WIN_SIZE.width,
          height: DEFAULT_WIN_SIZE.height,
          zIndex: next,
          minimized: false,
          maximized: false,
          shellCmd: opts?.shellCmd,
        };
        return new Map(prev).set(newId, w);
      });

      return next;
    });
  }, []);

  const closeWindow = useCallback((id: WindowId) => {
    setWindows((prev) => {
      const next = new Map(prev);
      const win = next.get(id);
      next.delete(id);
      // If no more windows of this app type remain, remove from activeApps
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
        // Restore saved geometry
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
        // Save current geometry, then maximize to full desktop area
        const w: WinState = {
          ...win,
          maximized: true,
          _savedW: win.width,
          _savedH: win.height,
          _savedX: win.x,
          _savedY: win.y,
          // Fill the windows-layer (calc(100vh - header - dock))
          x: 0, y: 0,
          width: 100,
          height: 100,
        };
        return new Map(prev).set(id, w);
      }
    });
  }, []);

  // ── Layer / focus ─────────────────────────────────────────────────────────

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

  // ── Drag state ───────────────────────────────────────────────────────────

  const [drag, setDrag] = useState<{
    id: WindowId;
    startX: number;
    startY: number;
    startWinX: number;
    startWinY: number;
  } | null>(null);

  // ── Resize state ─────────────────────────────────────────────────────────

  const [resize, setResize] = useState<{
    id: WindowId;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startWinX: number;
    startWinY: number;
  } | null>(null);

  // ── Global mouse handlers ─────────────────────────────────────────────────

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
            width: Math.max(MIN_WIN_SIZE.width,  resize.startW + dx),
            height: Math.max(MIN_WIN_SIZE.height, resize.startH + dy),
            x: resize.startWinX,
            y: resize.startWinY,
          });
        });
      }
    };

    const onUp = () => {
      setDrag(null);
      setResize(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, resize]);

  // ── Shell initial command state ───────────────────────────────────────────

  const [shellInitialCmd, setShellInitialCmd] = useState<string | null>(null);

  const openShellWindow = useCallback((cmd?: string) => {
    if (cmd) setShellInitialCmd(cmd);
    openWindow("shell", { shellCmd: cmd });
  }, [openWindow]);

  // ── Render ───────────────────────────────────────────────────────────────

  // Topmost non-minimized window (for active dock indicator)
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
          <>
            <div className="sidebar-section">
              <p className="sidebar-label">Device</p>
              <DevicePanel state={state} session={session} supported={supported} />
            </div>
          </>
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
        {/* Hero when nothing is open */}
        {windows.size === 0 && (
          <div className="hero">
            <div className="hero-icon">🧊</div>
            <h1 className="hero-title">WebADB</h1>
            <p className="hero-desc">
              Connect an Android device via USB and manage it directly from your browser.
            </p>
          </div>
        )}

        {/* Windows layer */}
        <div className="windows-layer">
          {[...windows.values()].map((win) => {
            const def = APPS.find((a) => a.id === win.appId)!;
            const isTop = topWinId === win.id;
            const isDragging = drag?.id === win.id;
            const isResizing = resize?.id === win.id;

            return (
              <DesktopWindow
                key={win.id}
                win={win}
                def={def}
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
                session={session}
                shellInitialCmd={shellInitialCmd}
                onShellOpen={openShellWindow}
              />
            );
          })}
        </div>
      </div>

      {/* ── Dock ─────────────────────────────────────────────────────── */}
      <nav className="dock" role="navigation" aria-label="Applications">
        {APPS.map((app) => {
          const isActive = activeApps.has(app.id);
          const isTopApp = topWin?.appId === app.id;
          return (
            <DockItem
              key={app.id}
              app={app}
              active={isActive}
              focused={isTopApp}
              onClick={() => {
                if (isActive) {
                  // Already open — just bring all windows of this type to front
                  bringToFront([...windows.entries()].find(([, w]) => w.appId === app.id)?.[0] ?? "");
                } else {
                  openWindow(app.id);
                }
              }}
              onRightClick={(e) => {
                e.preventDefault();
                // Right click always opens a new window (even if already open)
                openWindow(app.id);
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
  def: AppDef;
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
  onShellOpen?: (cmd?: string) => void;
}

function DesktopWindow({
  win, def, focused, dragging, resizing,
  onFocus, onClose, onMinimize, onMaximize,
  onTitlebarMouseDown, onResizeMouseDown, session,
  shellInitialCmd, onShellOpen,
}: DesktopWindowProps) {
  if (!session) return null;
  if (win.minimized) return null;

  const isMaximized = win.maximized;

  // Determine % or px sizing
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
      {/* ── Title bar ─────────────────────────────────────────────── */}
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

      {/* Content */}
      <div className="window-content">
        {win.appId === "shell"       && <ShellPanel session={session} initialCommand={win.shellCmd ?? shellInitialCmd ?? undefined} />}
        {win.appId === "apps"        && <AppManagerPanel session={session} />}
        {win.appId === "logcat"      && <LogcatPanel session={session} />}
        {win.appId === "files"       && <FileManagerPanel session={session} onOpenShell={onShellOpen} />}
        {win.appId === "screenshot"  && <ScreenshotPanel session={session} />}
        {win.appId === "apk"         && <ApkInstallPanel session={session} />}
        {win.appId === "wifi"        && <WiFiAdbPanel session={session} />}
      </div>

      {/* Resize handle (bottom-right corner) */}
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

// ── Dock ─────────────────────────────────────────────────────────────────────

interface DockItemProps {
  app: AppDef;
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

  // Close menu on outside click
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
    // Position menu just above the dock item
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

      {/* Right-click menu */}
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
