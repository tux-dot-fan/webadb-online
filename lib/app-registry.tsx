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

import type { ComponentType, ReactNode } from "react";
import type { AdbSession } from "@/lib/adb-client";

/**
 * Common props every panel receives. Keeps the registry simple.
 *
 * `onLaunchApp` is a callback so a panel (e.g. Launcher) can open another
 * app window without needing direct access to Workspace's state.
 *
 * `session` is guaranteed non-null by Workspace — apps that don't need
 * ADB (Launcher / Dash / Settings) just ignore the prop.
 */
export interface AppProps {
  session: AdbSession;
  /** Optional callback (used by File Manager to open Terminal Here). */
  onOpenShell?: (cwd: string, initialCommand?: string) => void;
  /** Optional callback used by Launcher / Dash to open another app. */
  onLaunchApp?: (appId: string) => void;
}

/** App descriptor. */
export interface AppDefinition {
  /** Stable string id, used for windows state and as map key. */
  id: string;
  /** Display title shown in the window title bar. */
  title: string;
  /** Emoji or inline JSX icon shown in the Dock and window title bar. */
  icon: ReactNode;
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
  /**
   * Whether this app is always enabled, regardless of the Settings panel.
   * Use this for core navigation/management surfaces (Apps grid, Search,
   * Settings itself) — turning them off would leave the user stranded.
   * Such apps don't get a toggle in the Settings panel.
   */
  alwaysEnabled?: boolean;
  /**
   * Whether this app renders as a special overlay instead of a regular
   * draggable window. Overlays are fullscreen (launcher) or centered
   * modals (dash, settings) and are rendered above all windows. They
   * never appear in the `windows` map — they're managed by separate
   * overlay state in Workspace.
   */
  isOverlay?: boolean;
  /**
   * Whether this app needs an ADB session to function. If false, the window
   * is allowed to render before a device is connected (used by Launcher /
   * Dash / Settings which are local-state-only).
   */
  requiresSession?: boolean;
}

// ── Built-in registration ────────────────────────────────────────────────────

import { ShellPanel }        from "@/components/ShellPanel";
import { FileManagerPanel }  from "@/components/FileManagerPanel";
import { AppManagerPanel }   from "@/components/AppManagerPanel";
import { SystemMonitorPanel } from "@/components/SystemMonitorPanel";
import { LogcatPanel }       from "@/components/LogcatPanel";
import { ScreenshotPanel }   from "@/components/ScreenshotPanel";
import { ApkInstallPanel }   from "@/components/ApkInstallPanel";
import { WiFiAdbPanel }      from "@/components/WiFiAdbPanel";
import { SettingsApp }       from "@/components/SettingsApp";
import { LauncherApp }       from "@/components/LauncherApp";
import { DashApp }           from "@/components/DashApp";
import { TextEditorApp }     from "@/components/TextEditorApp";
import { ScreencastPanel }   from "@/components/ScreencastPanel";
import { ClipboardPanel }    from "@/components/ClipboardPanel";

/**
 * The single source of truth for what apps exist. Workspace reads this list
 * and renders the Dock, initial window(s), and Settings panel from it.
 *
 * Order matters: it's the Dock order (left → right) and Settings order.
 */
export const REGISTERED_APPS: AppDefinition[] = [
  {
    id: "launcher",
    title: "Apps",
    icon: "🚀",
    Component: LauncherApp,
    defaultSize: { width: 520, height: 460 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    requiresSession: false,
    alwaysEnabled: true,
    /** Apps, Search, and Settings are special overlays — not regular windows. */
    isOverlay: true,
    description: "Browse all available apps (Launchpad-style).",
  },
  {
    id: "dash",
    title: "Search",
    icon: "🔎",
    Component: DashApp,
    defaultSize: { width: 560, height: 420 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    requiresSession: false,
    alwaysEnabled: true,
    isOverlay: true,
    description: "Search across apps, files, and shell commands (⌘K).",
  },
  {
    id: "shell",
    title: "Terminal",
    // gnome-terminal-style: dark rounded square with `>_` glyph.
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <rect
          x="1.5"
          y="1.5"
          width="21"
          height="21"
          rx="4"
          fill="#2c2c2c"
          stroke="#1a1a1a"
          strokeWidth="0.5"
        />
        <text
          x="12"
          y="17"
          textAnchor="middle"
          fontFamily="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
          fontSize="13"
          fontWeight="700"
          fill="#e6e6e6"
        >
          {">_"}
        </text>
      </svg>
    ),
    Component: ShellPanel,
    defaultSize: { width: 820, height: 460 },
    showInDock: true,
    launchOnStartup: false,
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
    title: "Apps Manager",
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
    id: "monitor",
    title: "System Monitor",
    icon: "📊",
    Component: SystemMonitorPanel,
    defaultSize: { width: 760, height: 540 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    description: "Per-core CPU usage, memory water level, and process list.",
  },
  {
    id: "editor",
    title: "Text Editor",
    icon: "📝",
    Component: TextEditorApp,
    defaultSize: { width: 760, height: 520 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: true,
    description: "Edit text files on the device or in localStorage.",
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
    id: "screencast",
    title: "Screencast",
    // TV-style: rounded-rect display with a small "play" triangle.
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <rect
          x="2"
          y="4"
          width="20"
          height="14"
          rx="2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <polygon
          points="10,8 16,12 10,16"
          fill="currentColor"
        />
        <line
          x1="9"
          y1="20"
          x2="15"
          y2="20"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
    Component: ScreencastPanel,
    defaultSize: { width: 480, height: 800 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: true,
    description:
      "Live screen stream of the device, with mouse + scroll + drag control.",
  },
  {
    id: "clipboard",
    title: "Clipboard",
    // Two overlapping rectangles — classic copy/paste visual.
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <rect
          x="8"
          y="3"
          width="11"
          height="15"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <rect
          x="5"
          y="6"
          width="11"
          height="15"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    ),
    Component: ClipboardPanel,
    defaultSize: { width: 480, height: 480 },
    showInDock: true,
    launchOnStartup: false,
    allowMultipleWindows: false,
    description:
      "Read and write the device clipboard. Two-way bridge with the browser's clipboard.",
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
  {
    id: "settings",
    title: "Settings",
    icon: "⚙",
    Component: SettingsApp,
    defaultSize: { width: 560, height: 480 },
    showInDock: false,
    launchOnStartup: false,
    allowMultipleWindows: false,
    requiresSession: false,
    alwaysEnabled: true,
    isOverlay: true,
    description: "Configure which apps appear and launch on startup.",
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

/**
 * Apps that can't be disabled via the Settings panel — they're core
 * navigation/management surfaces (Apps grid, Search, Settings itself)
 * so the user always has access regardless of their config.
 */
export function alwaysEnabledApps(): AppDefinition[] {
  return REGISTERED_APPS.filter((a) => a.alwaysEnabled === true);
}

// ── Enabled state (Settings → localStorage) ─────────────────────────────────

const ENABLED_STORAGE_KEY = "webadb.apps.enabled";
const OVERRIDES_STORAGE_KEY = "webadb.apps.overrides";

/**
 * Custom event fired after a SettingsApp toggle writes localStorage. Storage
 * events don't fire in the same window that performed the write, so we
 * dispatch our own to keep Workspace's Dock / window list in sync.
 */
const PREF_CHANGE_EVENT = "webadb:prefs-changed";

/** Dispatch after any prefs write so other components can re-read localStorage. */
export function notifyPrefsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PREF_CHANGE_EVENT));
  }
}

/**
 * Load enabled-set from localStorage. Missing key → all apps enabled.
 * Stale ids (apps removed since last save) are dropped from the set so the
 * Settings panel never shows orphaned entries.
 *
 * Apps flagged `alwaysEnabled` are always included regardless of what's
 * in localStorage — they're core navigation/management surfaces the
 * user can't disable.
 */
export function loadEnabled(defaults: readonly AppDefinition[]): Set<string> {
  // Always-enabled apps are unconditionally in the set.
  const alwaysIds = new Set(
    defaults.filter((a) => a.alwaysEnabled === true).map((a) => a.id),
  );
  // Defaults: everything currently registered is in the set. Apps the
  // user has explicitly disabled are subtracted below.
  const defaultsIds = new Set(defaults.map((a) => a.id));
  try {
    const raw = localStorage.getItem(ENABLED_STORAGE_KEY);
    if (raw === null) {
      // First-ever load → enable everything, but alwaysIds is already in.
      return new Set([...alwaysIds, ...defaults.map((a) => a.id)]);
    }
    const arr = JSON.parse(raw) as string[];
    const validIds = new Set(defaults.map((a) => a.id));
    const fromStorage = new Set(arr.filter((id) => validIds.has(id)));
    // Merge logic:
    //   - alwaysEnabled: unconditional
    //   - everything in defaults that the user hasn't explicitly
    //     disabled (default = enabled; user can disable via Settings).
    //   - apps in storage that are still valid (older sessions may
    //     have explicitly enabled something we no longer ship — we
    //     drop those to avoid orphans).
    //
    // The "absent in storage ⇒ enabled" rule is the important one:
    // when we ship a new app (e.g. Screencast), users with existing
    // settings should see it in the Dock by default, not have to
    // re-enable it from the Settings panel.
    const result = new Set<string>([...alwaysIds]);
    for (const id of defaultsIds) {
      if (fromStorage.has(id)) result.add(id);
    }
    return result;
  } catch {
    return new Set([...alwaysIds, ...defaults.map((a) => a.id)]);
  }
}

export function saveEnabled(enabled: Set<string>): void {
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, JSON.stringify([...enabled]));
    notifyPrefsChanged();
  } catch { /* ignore */ }
}

/** Load the per-app overrides record (showInDock / launchOnStartup). */
export function loadOverrides(): Record<string, { showInDock?: boolean; launchOnStartup?: boolean }> {
  try {
    const raw = localStorage.getItem(OVERRIDES_STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Record<string, { showInDock?: boolean; launchOnStartup?: boolean }>;
    // Drop overrides for apps that no longer exist (id drift).
    const validIds = new Set(REGISTERED_APPS.map((a) => a.id));
    return Object.fromEntries(
      Object.entries(parsed).filter(([id]) => validIds.has(id)),
    );
  } catch {
    return {};
  }
}

export function saveOverrides(
  o: Record<string, { showInDock?: boolean; launchOnStartup?: boolean }>,
): void {
  try {
    localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(o));
    notifyPrefsChanged();
  } catch { /* ignore */ }
}

/** Subscribe to localStorage changes from this app. Returns unsubscribe. */
export function onPrefsChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PREF_CHANGE_EVENT, handler);
  // Also listen for cross-tab changes via native storage event.
  const onStorage = (e: StorageEvent) => {
    if (e.key === ENABLED_STORAGE_KEY || e.key === OVERRIDES_STORAGE_KEY) handler();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREF_CHANGE_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}