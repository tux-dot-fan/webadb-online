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

type AppId = "shell" | "apps" | "logcat" | "files" | "screenshot" | "apk" | "wifi";

interface WindowDef {
  id: AppId;
  title: string;
  icon: string;
}

const APPS: WindowDef[] = [
  { id: "shell",       title: "Terminal",     icon: "🐚" },
  { id: "apps",        title: "Apps",          icon: "📱" },
  { id: "logcat",      title: "Logcat",        icon: "📋" },
  { id: "files",       title: "File Manager",  icon: "📁" },
  { id: "screenshot",  title: "Screenshot",    icon: "🖼" },
  { id: "apk",         title: "Install APK",   icon: "📦" },
  { id: "wifi",        title: "Wi-Fi ADB",     icon: "📶" },
];

// ── Window state stored in Workspace ───────────────────────────────────────

interface WinState {
  id: AppId;
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
}

const DEFAULT_WIN_SIZE = { width: 640, height: 420 };
const MIN_WIN_SIZE = { width: 320, height: 200 };

interface WorkspaceProps {
  buildVersion: string;
  buildGitHash: string;
  buildTimestamp: string;
}

export function Workspace({ buildVersion, buildGitHash }: WorkspaceProps) {
  const state = useAdbState();
  const session = useAdbSession();
  const supported = useAdbSupported();

  // open window ids
  const [open, setOpen] = useState<Set<AppId>>(new Set(["shell"]));
  // per-window state
  const [windows, setWindows] = useState<Map<AppId, WinState>>(() => {
    const m = new Map<AppId, WinState>();
    m.set("shell", { id: "shell", x: 30,  y: 30,  width: 640, height: 420, zIndex: 1, minimized: false, maximized: false });
    return m;
  });
  // topmost zIndex counter
  const [topZ, setTopZ] = useState(1);

  // ── Window lifecycle ─────────────────────────────────────────────────────

  const openWindow = useCallback((id: AppId) => {
    setOpen((prev) => new Set(prev).add(id));
    setTopZ((z) => {
      const next = z + 1;
      setWindows((prev) => {
        if (prev.has(id)) return prev;
        const count = prev.size + 1;
        const x = 30 + (count % 6) * 24;
        const y = 30 + (count % 6) * 24;
        const w: WinState = {
          id, x, y,
          width: DEFAULT_WIN_SIZE.width,
          height: DEFAULT_WIN_SIZE.height,
          zIndex: next,
          minimized: false,
          maximized: false,
        };
        return new Map(prev).set(id, w);
      });
      return next;
    });
  }, []);

  const closeWindow = useCallback((id: AppId) => {
    setOpen((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setWindows((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleMinimize = useCallback((id: AppId) => {
    setWindows((prev) => {
      const win = prev.get(id);
      if (!win) return prev;
      const next = new Map(prev);
      next.set(id, { ...win, minimized: !win.minimized });
      return next;
    });
  }, []);

  // ── Layering ────────────────────────────────────────────────────────────

  const bringToFront = useCallback((id: AppId) => {
    setTopZ((z) => {
      const next = z + 1;
      setWindows((prev) => {
        const win = prev.get(id);
        if (!win) return prev;
        const nextMap = new Map(prev);
        nextMap.set(id, { ...win, zIndex: next });
        return nextMap;
      });
      return next;
    });
  }, []);

  // ── Drag (titlebar) ─────────────────────────────────────────────────────

  const [drag, setDrag] = useState<{ id: AppId; startX: number; startY: number; startWinX: number; startWinY: number } | null>(null);
  const [resize, setResize] = useState<{ id: AppId; startX: number; startY: number; startW: number; startH: number; startWinX: number; startWinY: number } | null>(null);

  // Attach document-level listeners when dragging/resizing
  useEffect(() => {
    if (!drag && !resize) return;

    const onMove = (e: MouseEvent) => {
      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        setWindows((prev) => {
          const win = prev.get(drag.id);
          if (!win) return prev;
          const next = new Map(prev);
          next.set(drag.id, {
            ...win,
            x: Math.max(0, drag.startWinX + dx),
            y: Math.max(0, drag.startWinY + dy),
          });
          return next;
        });
      }
      if (resize) {
        const dw = e.clientX - resize.startX;
        const dh = e.clientY - resize.startY;
        setWindows((prev) => {
          const win = prev.get(resize.id);
          if (!win) return prev;
          const next = new Map(prev);
          next.set(resize.id, {
            ...win,
            width: Math.max(MIN_WIN_SIZE.width, resize.startW + dw),
            height: Math.max(MIN_WIN_SIZE.height, resize.startH + dh),
            x: Math.max(0, resize.startWinX + (e.shiftKey ? dw : 0)),
            y: Math.max(0, resize.startWinY + (e.shiftKey ? dh : 0)),
          });
          return next;
        });
      }
    };

    const onUp = () => {
      setDrag(null);
      setResize(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [drag, resize]);

  // ── Maximize / restore ──────────────────────────────────────────────────

  const toggleMaximize = useCallback((id: AppId) => {
    setWindows((prev) => {
      const win = prev.get(id);
      if (!win) return prev;
      const next = new Map(prev);
      next.set(id, {
        ...win,
        maximized: !win.maximized,
        // Restore saved size when un-maximizing
        width: win.maximized ? win._savedW ?? DEFAULT_WIN_SIZE.width : win.width,
        height: win.maximized ? win._savedH ?? DEFAULT_WIN_SIZE.height : win.height,
        x: win.maximized ? win._savedX ?? 30 : win.x,
        y: win.maximized ? win._savedY ?? 30 : win.y,
      });
      return next;
    });
  }, []);

  // Maximize stores current dimensions so restore can come back
  const toggleMaximizeWithSave = useCallback((id: AppId) => {
    setWindows((prev) => {
      const win = prev.get(id);
      if (!win) return prev;
      const next = new Map(prev);
      if (win.maximized) {
        // Restore
        next.set(id, {
          ...win,
          maximized: false,
          width: win._savedW ?? DEFAULT_WIN_SIZE.width,
          height: win._savedH ?? DEFAULT_WIN_SIZE.height,
          x: win._savedX ?? 30,
          y: win._savedY ?? 30,
        });
      } else {
        // Maximize — save current geometry first
        next.set(id, {
          ...win,
          maximized: true,
          _savedW: win.width,
          _savedH: win.height,
          _savedX: win.x,
          _savedY: win.y,
        });
      }
      return next;
    });
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────

  const focusedId = (() => {
    let top = 0;
    let topId: AppId | null = null;
    windows.forEach((w, id) => {
      if (open.has(id) && !w.minimized && w.zIndex >= top) {
        top = w.zIndex;
        topId = id;
      }
    });
    return topId;
  })();

  // Reset shellInitialCmd once consumed (after the window is added with the command)
  const [shellInitialCmd, setShellInitialCmd] = useState<string | null>(null);
  const [consumedCmd, setConsumedCmd] = useState(false);

  // Open a shell window; optionally pre-run a command
  const openShellWindow = useCallback((cmd?: string) => {
    if (cmd) {
      setShellInitialCmd(cmd);
      setConsumedCmd(false);
    }
    openWindow("shell");
  }, [openWindow]);

  return (
    <div className="app-shell">
      {/* ── Left sidebar ─────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="24" height="24" fill="currentColor" stroke="currentColor">
              <line x1="22" y1="18" x2="18" y2="12" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="42" y1="18" x2="46" y2="12" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M 16 30 A 16 14 0 0 1 48 30 L 48 36 L 16 36 Z" />
              <rect x="16" y="38" width="32" height="9" rx="2" />
            </svg>
          </span>
          <span className="brand-name">WebADB</span>
          <ThemeToggle />
        </div>

        <DevicePanel state={state} session={session} supported={supported} />

        <div className="sidebar-footer">
          <span title={`Git: ${buildGitHash}`}>v{buildVersion}</span>
        </div>
      </aside>

      {/* ── Desktop ──────────────────────────────────────────────────── */}
      <div className="desktop-area">
        {!session ? (
          <DesktopNotConnected />
        ) : (
          <>
            <div className="windows-layer">
              {APPS.filter((a) => open.has(a.id)).map((app) => {
                const win = windows.get(app.id);
                if (!win) return null;
                return (
                  <DesktopWindow
                    key={app.id}
                    app={app}
                    win={win}
                    focused={focusedId === app.id}
                    dragging={drag?.id === app.id}
                    resizing={resize?.id === app.id}
                    onFocus={() => bringToFront(app.id)}
                    onClose={() => closeWindow(app.id)}
                    onMinimize={() => toggleMinimize(app.id)}
                    onMaximize={() => toggleMaximizeWithSave(app.id)}
                    onTitlebarMouseDown={(e) => {
                      if (win.maximized) return;
                      e.preventDefault();
                      bringToFront(app.id);
                      setDrag({
                        id: app.id,
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
                      bringToFront(app.id);
                      setResize({
                        id: app.id,
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
                    onOpenShell={openShellWindow}
                  />
                );
              })}
            </div>

            <div className="dock" role="toolbar" aria-label="Applications">
              {APPS.map((app) => (
                <DockItem
                  key={app.id}
                  app={app}
                  open={open.has(app.id)}
                  minimized={windows.get(app.id)?.minimized ?? false}
                  onClick={() => {
                    if (!open.has(app.id)) {
                      openWindow(app.id);
                    } else {
                      const w = windows.get(app.id);
                      if (w?.minimized) {
                        // Restore minimized window and bring to front
                        toggleMinimize(app.id);
                        bringToFront(app.id);
                      } else if (focusedId !== app.id) {
                        bringToFront(app.id);
                      } else {
                        // Already open and focused — minimize
                        toggleMinimize(app.id);
                      }
                    }
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── DesktopWindow ───────────────────────────────────────────────────────────

interface DesktopWindowProps {
  app: WindowDef;
  win: WinState & { _savedW?: number; _savedH?: number; _savedX?: number; _savedY?: number };
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
  onOpenShell?: (path: string) => void;
}

function DesktopWindow({
  app, win, focused, dragging, resizing,
  onFocus, onClose, onMinimize, onMaximize,
  onTitlebarMouseDown, onResizeMouseDown, session, shellInitialCmd, onOpenShell,
}: DesktopWindowProps) {
  if (!session) return null;
  if (win.minimized) return null;

  const isMaximized = win.maximized;

  const winStyle: React.CSSProperties = isMaximized
    ? {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100%",
        height: "100%",
        zIndex: win.zIndex,
        borderRadius: 0,
      }
    : {
        position: "absolute",
        top: win.y,
        left: win.x,
        width: win.width,
        height: win.height,
        zIndex: win.zIndex,
      };

  return (
    <div
      className={`desktop-window ${focused ? "focused" : ""} ${isMaximized ? "maximized" : ""} ${dragging ? "dragging" : ""} ${resizing ? "resizing" : ""}`}
      style={winStyle}
      onMouseDown={onFocus}
    >
      {/* Title bar */}
      <div
        className="window-titlebar"
        onMouseDown={onTitlebarMouseDown}
        onDoubleClick={onMaximize}
        title={isMaximized ? undefined : "Drag to move · Double-click to maximize"}
      >
        <span className="window-title-icon" aria-hidden="true">{app.icon}</span>
        <span className="window-title-text">{app.title}</span>
        <div className="window-controls" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="window-ctrl"
            onClick={onMinimize}
            title="Minimize"
            aria-label={`Minimize ${app.title}`}
          >
            <span aria-hidden="true">─</span>
          </button>
          <button
            className="window-ctrl"
            onClick={onMaximize}
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? `Restore ${app.title}` : `Maximize ${app.title}`}
          >
            <span aria-hidden="true">{isMaximized ? "❐" : "□"}</span>
          </button>
          <button
            className="window-ctrl window-ctrl-close"
            onClick={onClose}
            title="Close"
            aria-label={`Close ${app.title}`}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="window-content">
        {app.id === "shell"       && <ShellPanel session={session} initialCommand={shellInitialCmd ?? undefined} />}
        {app.id === "apps"        && <AppManagerPanel session={session} />}
        {app.id === "logcat"      && <LogcatPanel session={session} />}
        {app.id === "files"       && <FileManagerPanel session={session} onOpenShell={onOpenShell} />}
        {app.id === "screenshot"  && <ScreenshotPanel session={session} />}
        {app.id === "apk"         && <ApkInstallPanel session={session} />}
        {app.id === "wifi"        && <WiFiAdbPanel session={session} />}
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

// ── Dock ────────────────────────────────────────────────────────────────────

interface DockItemProps {
  app: WindowDef;
  open: boolean;
  minimized: boolean;
  onClick: () => void;
}

function DockItem({ app, open, minimized, onClick }: DockItemProps) {
  return (
    <button
      className={`dock-item ${open ? "open" : ""} ${minimized ? "minimized" : ""}`}
      onClick={onClick}
      title={app.title}
      aria-label={app.title}
      aria-pressed={open}
    >
      <span className="dock-icon" aria-hidden="true">{app.icon}</span>
      <span className="dock-label">{app.title}</span>
      {open && <span className="dock-dot" aria-hidden="true" />}
    </button>
  );
}

// ── Not-connected ────────────────────────────────────────────────────────────

function DesktopNotConnected() {
  return (
    <div className="desktop-notconnected">
      <div className="hero">
        <h1>Run ADB fully in your browser</h1>
        <p>
          Connect your Android device over USB, then run shell commands, install APKs,
          browse files, and take screenshots — without installing anything on your computer.
        </p>
      </div>
      <div className="feature-grid">
        <div className="card">
          <h3>🔌 WebUSB</h3>
          <p>Direct USB from your browser. No drivers, no adb-server. Just Chrome, Edge, or Opera.</p>
        </div>
        <div className="card">
          <h3>🐚 Terminal</h3>
          <p>Full PTY terminal with arrow keys, Ctrl+C, and Tab completion.</p>
        </div>
        <div className="card">
          <h3>📁 File Manager</h3>
          <p>Browse <code>/sdcard</code>, preview text/images/audio/video, download files.</p>
        </div>
        <div className="card">
          <h3>📸 Screenshot</h3>
          <p>One-click <code>screencap</code> — no scrcpy server needed.</p>
        </div>
        <div className="card">
          <h3>🔒 Private</h3>
          <p>Everything runs in your browser. No data leaves your computer.</p>
        </div>
      </div>
    </div>
  );
}
