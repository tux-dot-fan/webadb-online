"use client";

// ── LauncherApp ─────────────────────────────────────────────────────────────
//
// App grid (macOS Launchpad style). Lists every REGISTERED_APP that's
// currently enabled, plus Settings. Clicking a tile opens its window via
// the `onLaunchApp(appId)` callback that Workspace injects.
//
// Disabled apps are filtered out (so the launcher never offers a tile that
// would no-op). Settings + Launcher themselves are always shown because
// they're the entry points to manage app visibility.
//
// Open with: openAppWindow("launcher")

import { useEffect, useState } from "react";
import { REGISTERED_APPS, loadEnabled } from "@/lib/app-registry";

interface LauncherAppProps {
  /** Called when the user clicks an app tile. Optional for type compat. */
  onLaunchApp?: (appId: string) => void;
}

export function LauncherApp({
  onLaunchApp = () => {},
}: LauncherAppProps): React.JSX.Element {
  // Enabled set is localStorage-backed; read on mount.
  const [enabledIds, setEnabledIds] = useState(
    () => new Set<string>(REGISTERED_APPS.map((a) => a.id)),
  );

  useEffect(() => {
    setEnabledIds(loadEnabled(REGISTERED_APPS));
    // Refresh when storage changes (e.g. user toggles in SettingsApp while
    // Launcher is open in another window).
    const onStorage = (e: StorageEvent) => {
      if (e.key === "webadb.apps.enabled") {
        setEnabledIds(loadEnabled(REGISTERED_APPS));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Launcher + Settings tiles are always available, even if disabled in
  // `enabledIds` — they're the entry points to manage that state.
  const alwaysShow = new Set(["launcher", "settings"]);
  const tiles = REGISTERED_APPS.filter(
    (a) => alwaysShow.has(a.id) || enabledIds.has(a.id),
  );

  return (
    <div className="launcher-app">
      <header className="launcher-header">
        <h2>Apps</h2>
        <p className="launcher-hint">Tap an app to open it.</p>
      </header>
      <div className="launcher-grid">
        {tiles.map((app) => (
          <button
            key={app.id}
            type="button"
            className="launcher-tile"
            onClick={() => onLaunchApp(app.id)}
          >
            <span className="launcher-tile-icon" aria-hidden>
              {app.icon}
            </span>
            <span className="launcher-tile-title">{app.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}