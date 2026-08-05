"use client";

// ── SettingsApp ─────────────────────────────────────────────────────────────
//
// Full-page settings window. Reads the entire `REGISTERED_APPS` list and
// lets the user toggle each app:
//   • enabled / disabled
//   • show in Dock
//   • launch on startup
//
// All writes go through the `saveEnabled` / `saveOverrides` helpers in
// `@/lib/app-registry`, which persist to localStorage and dispatch a
// `webadb:prefs-changed` event so the rest of the app re-reads.
//
// Open with: openAppWindow("settings")

import { useEffect, useState } from "react";
import {
  REGISTERED_APPS,
  loadEnabled,
  loadOverrides,
  saveEnabled,
  saveOverrides,
  onPrefsChanged,
  type AppDefinition,
} from "@/lib/app-registry";

interface AppOverride {
  showInDock?: boolean;
  launchOnStartup?: boolean;
}

function useAppPrefs() {
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(REGISTERED_APPS.map((a) => a.id)),
  );
  const [overrides, setOverrides] = useState<Record<string, AppOverride>>({});

  useEffect(() => {
    setEnabled(loadEnabled(REGISTERED_APPS));
    setOverrides(loadOverrides());

    // Re-read whenever any other component writes prefs (including other
    // SettingsApp windows opened simultaneously).
    return onPrefsChanged(() => {
      setEnabled(loadEnabled(REGISTERED_APPS));
      setOverrides(loadOverrides());
    });
  }, []);

  const toggleEnabled = (id: string) => {
    // Always-enabled apps can't be disabled (Settings itself, Apps, Search).
    const app = REGISTERED_APPS.find((a) => a.id === id);
    if (app?.alwaysEnabled) return;
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveEnabled(next);
      return next;
    });
  };

  const toggleOverride = (id: string, key: keyof AppOverride) => {
    const app = REGISTERED_APPS.find((a) => a.id === id);
    if (!app) return;
    setOverrides((prev) => {
      const def = app[key] !== false;
      const current = prev[id]?.[key];
      const next: AppOverride = { ...prev[id] };
      // Default state (e.g. showInDock defaults to true): if currently
      // equal to default OR not set, flipping goes to !default; otherwise
      // flipping the explicit override. When result equals the default,
      // delete the override so registry default is authoritative.
      const effective = current ?? def;
      next[key] = !effective;
      if (next[key] === def) delete next[key];

      const merged = { ...prev, [id]: next };
      if (Object.keys(next).length === 0) delete merged[id];
      saveOverrides(merged);
      return merged;
    });
  };

  /** Effective registry + override field for an app. */
  const effective = (app: AppDefinition, key: keyof AppOverride): boolean => {
    const def = app[key] !== false;
    return overrides[app.id]?.[key] ?? def;
  };

  return { enabled, toggleEnabled, toggleOverride, effective };
}

export function SettingsApp(): React.JSX.Element {
  const { enabled, toggleEnabled, toggleOverride, effective } = useAppPrefs();

  return (
    <div className="settings-app">
      <header className="settings-header">
        <h2>Apps</h2>
        <p className="settings-hint">
          Enable or disable features. Disabled apps are removed from the Dock
          and any open windows are closed. Changes are saved automatically.
        </p>
      </header>

      <ul className="settings-list">
        {REGISTERED_APPS.map((app) => {
          const isEnabled = enabled.has(app.id);
          const showInDock = effective(app, "showInDock");
          const launchOnStartup = effective(app, "launchOnStartup");
          return (
            <li
              key={app.id}
              className={`settings-row${isEnabled ? "" : " is-disabled"}`}
            >
              <div className="settings-row-main">
                <span className="settings-row-icon" aria-hidden>
                  {app.icon}
                </span>
                <div className="settings-row-text">
                  <strong>{app.title}</strong>
                  {app.description && (
                    <span className="settings-row-desc">{app.description}</span>
                  )}
                </div>
                {app.alwaysEnabled ? (
                  // Always-on apps (Apps grid, Search, Settings) don't
                  // expose a toggle — disabling them would lock the user
                  // out of the very panel they need to re-enable things.
                  <span
                    className="settings-always-on"
                    title="This app is always available."
                  >
                    always on
                  </span>
                ) : (
                  <button
                    type="button"
                    className="toggle"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-label={`Enable ${app.title}`}
                    onClick={() => toggleEnabled(app.id)}
                  >
                    <span className="toggle-knob" />
                  </button>
                )}
              </div>

              {isEnabled && (
                <div className="settings-row-overrides">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showInDock}
                      onChange={() => toggleOverride(app.id, "showInDock")}
                    />
                    Show in Dock
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={launchOnStartup}
                      onChange={() => toggleOverride(app.id, "launchOnStartup")}
                    />
                    Launch on startup
                  </label>
                  {!app.allowMultipleWindows && (
                    <span className="settings-row-note">single window only</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}