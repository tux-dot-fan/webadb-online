"use client";

import type { AdbSession } from "@/lib/adb-client";
import { REGISTERED_APPS, type AppDefinition } from "@/lib/app-registry";

interface Props {
  session: AdbSession;
  /** Set of enabled app ids. The Settings panel mutates this directly. */
  enabled: Set<string>;
  /** Toggle a single app enabled/disabled. */
  onToggle: (id: string, enabled: boolean) => void;
  /** Toggle Dock visibility for an app. */
  onToggleDock: (id: string, showInDock: boolean) => void;
  /** Toggle "launch on startup" for an app. */
  onToggleStartup: (id: string, launchOnStartup: boolean) => void;
}

/**
 * Settings panel — lets the user enable / disable each app and control
 * whether it shows in the Dock or launches on startup. Reads from the
 * registry so adding a new app automatically appears here.
 */
export function SettingsPanel({
  enabled, onToggle, onToggleDock, onToggleStartup,
}: Props) {
  return (
    <div className="settings-list">
      <p className="settings-help">
        Enable or disable individual apps. Disabled apps are hidden from the
        Dock and won't open via the registry. Changes persist in
        localStorage.
      </p>
      {REGISTERED_APPS.map((app) => (
        <SettingsRow
          key={app.id}
          app={app}
          enabled={enabled.has(app.id)}
          onToggle={onToggle}
          onToggleDock={onToggleDock}
          onToggleStartup={onToggleStartup}
        />
      ))}
    </div>
  );
}

interface RowProps {
  app: AppDefinition;
  enabled: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onToggleDock: (id: string, showInDock: boolean) => void;
  onToggleStartup: (id: string, launchOnStartup: boolean) => void;
}

function SettingsRow({
  app, enabled, onToggle, onToggleDock, onToggleStartup,
}: RowProps) {
  // Read the current flag from the registry's static value (settings don't
  // override the registry itself — we use a CSS variable / data attribute
  // pattern if we ever need to mutate these without a remount).
  const inDock = app.showInDock !== false;
  const onStartup = app.launchOnStartup === true;

  return (
    <div className={`settings-row${enabled ? "" : " disabled"}`}>
      <div className="settings-row-head">
        <span className="settings-icon">{app.icon}</span>
        <div className="settings-row-text">
          <div className="settings-title">{app.title}</div>
          {app.description && (
            <div className="settings-desc">{app.description}</div>
          )}
        </div>
        <label className="settings-switch" title={enabled ? "Disable" : "Enable"}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(app.id, e.target.checked)}
            aria-label={`Enable ${app.title}`}
          />
          <span className="settings-switch-slider" />
        </label>
      </div>
      {enabled && (
        <div className="settings-row-options">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={inDock}
              onChange={(e) => onToggleDock(app.id, e.target.checked)}
            />
            <span>Show in Dock</span>
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={onStartup}
              onChange={(e) => onToggleStartup(app.id, e.target.checked)}
            />
            <span>Launch on startup</span>
          </label>
          {!app.allowMultipleWindows && (
            <span className="settings-hint">single window only</span>
          )}
        </div>
      )}
    </div>
  );
}