"use client";

import { useState, useCallback } from "react";
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

interface Window {
  id: AppId;
  title: string;
  icon: string;
  minimized: boolean;
}

const APPS: Window[] = [
  { id: "shell",       title: "Terminal",     icon: "🐚", minimized: false },
  { id: "apps",        title: "Apps",          icon: "📱", minimized: false },
  { id: "logcat",      title: "Logcat",        icon: "📋", minimized: false },
  { id: "files",       title: "File Manager",  icon: "📁", minimized: false },
  { id: "screenshot",  title: "Screenshot",    icon: "🖼", minimized: false },
  { id: "apk",         title: "Install APK",   icon: "📦", minimized: false },
  { id: "wifi",        title: "Wi-Fi ADB",     icon: "📶", minimized: false },
];

interface WorkspaceProps {
  buildVersion: string;
  buildGitHash: string;
  buildTimestamp: string;
}

export function Workspace({ buildVersion, buildGitHash, buildTimestamp }: WorkspaceProps) {
  const state = useAdbState();
  const session = useAdbSession();
  const supported = useAdbSupported();

  // Set of open window IDs
  const [open, setOpen] = useState<Set<AppId>>(new Set(["shell"]));
  // Set of minimized window IDs
  const [minimized, setMinimized] = useState<Set<AppId>>(new Set());
  // Currently focused (top) window id
  const [focused, setFocused] = useState<AppId>("shell");

  const toggleWindow = useCallback((id: AppId) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        setFocused(id);
      }
      return next;
    });
    setMinimized((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const closeWindow = useCallback((id: AppId) => {
    setOpen((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setMinimized((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const minimizeWindow = useCallback((id: AppId) => {
    setMinimized((prev) => new Set(prev).add(id));
  }, []);

  const focusWindow = useCallback((id: AppId) => {
    setFocused(id);
    setMinimized((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return (
    <div className="app-shell">
      {/* ── Left sidebar (Device Panel) ──────────────────────────────── */}
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
          <span className="version-info" title={`Git: ${buildGitHash}`}>
            v{buildVersion}
          </span>
        </div>
      </aside>

      {/* ── Desktop area ─────────────────────────────────────────────── */}
      <div className="desktop-area">
        {!session ? (
          <DesktopNotConnected />
        ) : (
          <>
            {/* Windows layer */}
            <div className="windows-layer">
              {APPS.filter((app) => open.has(app.id) && !minimized.has(app.id)).map((app) => (
                <DesktopWindow
                  key={app.id}
                  id={app.id}
                  title={app.title}
                  icon={app.icon}
                  focused={focused === app.id}
                  onFocus={() => focusWindow(app.id)}
                  onMinimize={() => minimizeWindow(app.id)}
                  onClose={() => closeWindow(app.id)}
                  session={session}
                />
              ))}
            </div>

            {/* Dock */}
            <div className="dock" role="toolbar" aria-label="Applications">
              {APPS.map((app) => (
                <DockItem
                  key={app.id}
                  app={app}
                  open={open.has(app.id)}
                  minimized={minimized.has(app.id)}
                  onClick={() => {
                    if (open.has(app.id) && !minimized.has(app.id)) {
                      // Already open and not minimized — bring to front
                      focusWindow(app.id);
                    } else {
                      toggleWindow(app.id);
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

// ── Desktop Window ────────────────────────────────────────────────────────

interface DesktopWindowProps {
  id: AppId;
  title: string;
  icon: string;
  focused: boolean;
  onFocus: () => void;
  onMinimize: () => void;
  onClose: () => void;
  session: ReturnType<typeof useAdbSession>;
}

function DesktopWindow({ id, title, icon, focused, onFocus, onMinimize, onClose, session }: DesktopWindowProps) {
  // Guard: should never fire since this component is only rendered when session is set,
  // but satisfies TypeScript's AdbSession | null
  if (!session) return null;

  return (
    <div
      className={`desktop-window ${focused ? "focused" : ""}`}
      onMouseDown={onFocus}
    >
      {/* Title bar */}
      <div className="window-titlebar">
        <span className="window-title-icon" aria-hidden="true">{icon}</span>
        <span className="window-title-text">{title}</span>
        <div className="window-controls">
          <button
            className="window-ctrl window-ctrl-minimize"
            onClick={(e) => { e.stopPropagation(); onMinimize(); }}
            title="Minimize"
            aria-label={`Minimize ${title}`}
          >
            ─
          </button>
          <button
            className="window-ctrl window-ctrl-close"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Close"
            aria-label={`Close ${title}`}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="window-content">
        {id === "shell"       && <ShellPanel session={session} />}
        {id === "apps"        && <AppManagerPanel session={session} />}
        {id === "logcat"      && <LogcatPanel session={session} />}
        {id === "files"       && <FileManagerPanel session={session} />}
        {id === "screenshot"  && <ScreenshotPanel session={session} />}
        {id === "apk"         && <ApkInstallPanel session={session} />}
        {id === "wifi"        && <WiFiAdbPanel session={session} />}
      </div>
    </div>
  );
}

// ── Dock Item ─────────────────────────────────────────────────────────────

interface DockItemProps {
  app: Window;
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

// ── Not-connected state ────────────────────────────────────────────────────

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
          <p>
            Direct USB connection from your browser. No drivers, no adb-server, no
            extensions. Just Chrome, Edge, or Opera.
          </p>
        </div>
        <div className="card">
          <h3>🐚 Terminal</h3>
          <p>
            Run any command on the device. <code>getprop</code>, <code>pm list</code>,
            <code>dumpsys</code>, <code>ls</code> — everything in a real PTY terminal.
          </p>
        </div>
        <div className="card">
          <h3>📁 File Manager</h3>
          <p>
            Browse <code>/sdcard</code> and the rest of the device filesystem.
            Preview and download files.
          </p>
        </div>
        <div className="card">
          <h3>📸 Screenshot</h3>
          <p>
            One-click <code>screencap</code> via the framebuffer protocol. No scrcpy
            server needed.
          </p>
        </div>
        <div className="card">
          <h3>🔒 Private</h3>
          <p>
            Everything runs in your browser. No files leave your computer, no data is
            sent to a server. <code>webadb.online</code> is a static site.
          </p>
        </div>
      </div>
    </div>
  );
}
