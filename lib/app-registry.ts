// ── App registry ─────────────────────────────────────────────────────────────
//
// Every "app" in WebADB (Terminal, File Manager, Logcat, etc.) is a self-
// contained component that lives in its own file under `components/`. The
// registry decouples Workspace (and any future launcher / settings panel)
// from the concrete components — to add a new app, just:
//   1. Write the component (e.g. components/MyApp.tsx)
//   2. Register it in `registerApps()` below.
// Workspace will pick it up automatically — no edits to Workspace required.
//
// Each app can be:
//   • enabled or disabled from the Settings panel (persists in localStorage)
//   • shown in the Dock or not (showInDock)
//   • launched on startup or not (launchOnStartup)

import type { ComponentType } from "react";
import type { AdbSession } from "@/lib/adb-client";

/** Common props every panel receives. Keeps the registry simple. */
export interface AppProps {
  session: AdbSession;
  /** Optional callback (used by File Manager to open Terminal Here). */
  onOpenShell?: (cwd: string, initialCommand?: string) => void;
}

/** App descriptor. */
export interface AppDefinition {
  /** Stable string id, used for windows state and as map key. */
  id: string;
  /** Display title shown in the window title bar. */
  title: string;
  /** Emoji icon shown in the Dock and sidebar. */
  icon: string;
  /** The actual React component. Receives AppProps. */
  Component: ComponentType<AppProps>;
  /** Default window size when launched. */
  defaultSize?: { width: number; height: number };
  /** Show this app in the Dock. Default true. */
  showInDock?: boolean;
  /** Open a window automatically on first paint. Default false. */
  launchOnStartup?: boolean;
  /** Whether multiple windows of this app can be open simultaneously. Default true. */
  allowMultipleWindows?: boolean;
  /** Short description shown in Settings panel. */
  description?: string;
}

// ── Built-in registration ────────────────────────────────────────────────────

import { ShellPanel }        from "@/components/ShellPanel";
import { FileManagerPanel }  from "@/components/FileManagerPanel";
import { AppManagerPanel }   from "@/components/AppManagerPanel";
import { LogcatPanel }       from "@/components/LogcatPanel";
import { ScreenshotPanel }   from "@/components/ScreenshotPanel";
import { ApkInstallPanel }   from "@/components/ApkInstallPanel";
import { WiFiAdbPanel }      from "@/components/WiFiAdbPanel";

/**
 * The single source of truth for what apps exist. Workspace reads this list
 * and renders the Dock, initial window(s), and Settings panel from it.
 *
 * Order matters: it's the Dock order (left → right) and Settings order.
 */
export const REGISTERED_APPS: AppDefinition[] = [
  {
    id: "shell",
    title: "Terminal",
    icon: "🐚",
    Component: ShellPanel,
    defaultSize: { width: 640, height: 420 },
    showInDock: true,
    launchOnStartup: true,
    allowMultipleWindows: true,
    description: "Interactive shell with PTY (arrow keys, Ctrl+C, resize).",
  },
  {
    id: "files",
    title: "File Manager",
    icon: "📁",
    Component: FileManagerPanel,
    defaultSize: { width: 720, height: 480 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: true,
    description: "Browse / upload / preview / pin folders on the device.",
  },
  {
    id: "apps",
    title: "Apps",
    icon: "📱",
    Component: AppManagerPanel,
    defaultSize: { width: 720, height: 480 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    description: "List, launch, and uninstall installed apps.",
  },
  {
    id: "logcat",
    title: "Logcat",
    icon: "📋",
    Component: LogcatPanel,
    defaultSize: { width: 720, height: 480 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: true,
    description: "Live system logcat stream with ANSI colors.",
  },
  {
    id: "screenshot",
    title: "Screenshot",
    icon: "🖼",
    Component: ScreenshotPanel,
    defaultSize: { width: 520, height: 380 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    description: "Capture and download a screenshot.",
  },
  {
    id: "apk",
    title: "Install APK",
    icon: "📦",
    Component: ApkInstallPanel,
    defaultSize: { width: 520, height: 320 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    description: "Push and install an APK file to the device.",
  },
  {
    id: "wifi",
    title: "Wi-Fi ADB",
    icon: "📶",
    Component: WiFiAdbPanel,
    defaultSize: { width: 520, height: 320 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    description: "Enable wireless ADB on the connected device.",
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────────────

/** O(1) id → AppDefinition lookup. */
const APP_MAP: Map<string, AppDefinition> = new Map(
  REGISTERED_APPS.map((a) => [a.id, a])
);

/** Get an app definition by id, or undefined if not registered. */
export function getApp(id: string): AppDefinition | undefined {
  return APP_MAP.get(id);
}

/** Apps shown in the Dock (filtered by showInDock). */
export function dockApps(): AppDefinition[] {
  return REGISTERED_APPS.filter((a) => a.showInDock !== false);
}

/** Apps that should open automatically on page load. */
export function startupApps(): AppDefinition[] {
  return REGISTERED_APPS.filter((a) => a.launchOnStartup === true);
}

// ── Enabled state (Settings → localStorage) ─────────────────────────────────

const ENABLED_STORAGE_KEY = "webadb.apps.enabled";

/**
 * Load enabled-set from localStorage. Missing key → all apps enabled.
 * Stale ids (apps removed since last save) are dropped from the set so the
 * Settings panel never shows orphaned entries.
 */
export function loadEnabled(defaults: readonly AppDefinition[]): Set<string> {
  try {
    const raw = localStorage.getItem(ENABLED_STORAGE_KEY);
    if (raw === null) return new Set(defaults.map((a) => a.id));
    const arr = JSON.parse(raw) as string[];
    const validIds = new Set(defaults.map((a) => a.id));
    return new Set(arr.filter((id) => validIds.has(id)));
  } catch {
    return new Set(defaults.map((a) => a.id));
  }
}

export function saveEnabled(enabled: Set<string>): void {
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, JSON.stringify([...enabled]));
  } catch { /* ignore */ }
}