"use client";

/**
 * macOS-style top menu bar. Replaces the previous left-hand sidebar.
 *
 * Layout:
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │  🧊 WebADB ▼   current app title (focused window)         🔋 🔌 ⚙ │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 *   • Left: app menu (WebADB ▼). Drops down a list with Connect,
 *     Switch, Disconnect, Open Settings, About. Mirrors the macOS
 *     application menu: one menu, always the active app's name.
 *   • Middle: focused app title (e.g. "Terminal"). Hidden when no
 *     window is focused, or when the desktop is empty.
 *   • Right: status indicators — connection pill, device serial, theme
 *     toggle, settings button.
 *
 * The bar is fixed at the top of the viewport with a subtle bottom
 * border so it acts as a visual anchor without dominating the page.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAdbState, useAdbSession, useAdbSupported } from "@/lib/use-adb";
import { useConnectActions } from "@/lib/use-connect-actions";

interface TopBarProps {
  /** When non-null, shown as the middle title (focused app). */
  focusedTitle?: string;
  /** When non-null, shown as the focused app icon next to the title. */
  focusedIcon?: ReactNode;
  /**
   * When the focused window is maximized, the topbar mirrors its titlebar
   * controls so the window's own titlebar can collapse and the window
   * content can flow directly under the topbar. When undefined (no
   * focused window, or the focused window is *not* maximized), no
   * controls are rendered. The topbar still always shows the focused
   * title text, but for non-maximized windows the titlebar of the
   * window itself is what hosts the close/max buttons.
   */
  windowControls?: {
    isMaximized: boolean;
    onMinimize: () => void;
    onMaximize: () => void;
    onClose: () => void;
  };
  /** Called when the user picks "Open Settings" from the menu. */
  onOpenSettings: () => void;
  /** Called when the user picks "Show Apps launcher" from the menu. */
  onOpenApps: () => void;
  /** Called when the user picks "Show Search" from the menu. */
  onOpenSearch: () => void;
  /**
   * Build metadata for the "About" menu item. We accept it via prop so
   * the topbar stays decoupled from app/build-info (which is generated
   * at build time).
   */
  buildVersion: string;
  buildGitHash: string;
}

export function TopBar({
  focusedTitle,
  focusedIcon,
  windowControls,
  onOpenSettings,
  onOpenApps,
  onOpenSearch,
  buildVersion,
  buildGitHash,
}: TopBarProps) {
  const state = useAdbState();
  const session = useAdbSession();
  const supported = useAdbSupported();
  const { busy, connect, disconnect, switchDevice } = useConnectActions();

  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const menuRootRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside-click or Escape. We do this at the topbar
  // level (not in a sub-component) because both the app menu and the
  // about dialog need it.
  useEffect(() => {
    if (!menuOpen && !aboutOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRootRef.current) return;
      if (menuRootRef.current.contains(e.target as Node)) return;
      setMenuOpen(false);
      setAboutOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setAboutOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, aboutOpen]);

  const connected = state.kind === "connected" && !!session;

  return (
    <>
      <header className="topbar" ref={menuRootRef}>
        {/* ── Left: app menu ───────────────────────────────────────── */}
        <div className="topbar-left">
          <button
            type="button"
            className={`topbar-appmenu${menuOpen ? " active" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="topbar-appmenu-icon">🧊</span>
            <span className="topbar-appmenu-name">WebADB</span>
            <span className="topbar-appmenu-caret" aria-hidden="true">▾</span>
          </button>

          {menuOpen && (
            <div className="topbar-menu" role="menu">
              <MenuItem
                icon="🚀"
                label="Apps"
                hint="Show all apps"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenApps();
                }}
              />
              <MenuItem
                icon="🔎"
                label="Search"
                hint="Find apps, files, commands"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSearch();
                }}
              />
              <MenuSep />
              <MenuItem
                icon={connected ? "🔌" : "🔗"}
                label={connected ? "Disconnect" : "Connect device"}
                disabled={busy || (!connected && !supported)}
                onClick={() => {
                  setMenuOpen(false);
                  if (connected) void disconnect();
                  else void connect();
                }}
              />
              <MenuItem
                icon="🔁"
                label="Switch device"
                disabled={busy || !connected}
                onClick={() => {
                  setMenuOpen(false);
                  void switchDevice();
                }}
              />
              <MenuSep />
              <MenuItem
                icon="⚙"
                label="Settings…"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              />
              <MenuItem
                icon="ℹ"
                label="About WebADB"
                onClick={() => {
                  setMenuOpen(false);
                  setAboutOpen(true);
                }}
              />
            </div>
          )}
        </div>

        {/* ── Middle: focused app title (macOS convention) ─────────── */}
        <div className="topbar-center">
          {focusedTitle ? (
            <span className="topbar-title">
              {focusedIcon && (
                <span className="topbar-title-icon" aria-hidden="true">
                  {focusedIcon}
                </span>
              )}
              {focusedTitle}
            </span>
          ) : null}
        </div>

        {/* ── Right: window controls when maximized (flush right) ─────── */}
        <div className="topbar-right">
          {windowControls?.isMaximized && (
            <div className="topbar-window-controls" aria-label="Window controls">
              <button
                type="button"
                className="topbar-ctrl topbar-ctrl-minimize"
                onClick={windowControls.onMinimize}
                title="Minimize"
                aria-label="Minimize window"
              >
                <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
              </button>
              <button
                type="button"
                className="topbar-ctrl topbar-ctrl-maximize"
                onClick={windowControls.onMaximize}
                title="Restore"
                aria-label="Restore window"
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
                  <rect x="0" y="2" width="8" height="8" fill="var(--bg-elev)" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
              <button
                type="button"
                className="topbar-ctrl topbar-ctrl-close"
                onClick={windowControls.onClose}
                title="Close"
                aria-label="Close window"
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
                  <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* AboutDialog is rendered outside <header> so its `position: fixed`
          backdrop isn't clipped by the topbar's stacking context
          (backdrop-filter creates a new one). */}
      {aboutOpen && (
        <AboutDialog
          onClose={() => setAboutOpen(false)}
          version={buildVersion}
          gitHash={buildGitHash}
        />
      )}
    </>
  );
}

function MenuItem(props: {
  icon: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="topbar-menu-item"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="topbar-menu-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span className="topbar-menu-label">{props.label}</span>
      {props.hint && <span className="topbar-menu-hint">{props.hint}</span>}
    </button>
  );
}

function MenuSep() {
  return <div className="topbar-menu-sep" role="separator" />;
}

function AboutDialog({
  onClose,
  version,
  gitHash,
}: {
  onClose: () => void;
  version: string;
  gitHash: string;
}) {
  return (
    <div
      className="topbar-about-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="topbar-about" role="dialog" aria-label="About WebADB">
        <div className="topbar-about-icon">🧊</div>
        <h2 className="topbar-about-name">WebADB</h2>
        <div className="topbar-about-ver">
          Version {version}
          {gitHash !== "dev" && (
            <>
              {" "}
              <span className="topbar-about-hash">
                {gitHash.slice(0, 7)}
              </span>
            </>
          )}
        </div>
        <p className="topbar-about-blurb">
          Run ADB on your Android device entirely from your browser.
        </p>
        <button
          type="button"
          className="topbar-about-ok"
          onClick={onClose}
          autoFocus
        >
          OK
        </button>
      </div>
    </div>
  );
}