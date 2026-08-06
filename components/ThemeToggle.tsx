"use client";

/**
 * Theme toggle for webadb.online.
 *
 * Behavior:
 *   - First load: read the user's previously-chosen theme from localStorage.
 *     If absent, follow the OS preference (`prefers-color-scheme: dark`).
 *     If neither, fall back to light (the documented default for this app).
 *   - Subsequent loads: restore the stored choice, regardless of the OS
 *     preference — the OS theme can flip on time-of-day and we don't want
 *     the site to silently switch on a user mid-session.
 *   - On toggle: write the choice to localStorage AND flip the
 *     `data-theme` attribute on `<html>`. CSS uses `:root[data-theme="dark"]`
 *     to override the light defaults.
 *
 * Why an inline script in layout.tsx sets the attribute BEFORE React
 * hydrates: without it, the page renders in light theme for ~100 ms and
 * then snaps to dark on mount, producing a visible "flash". The inline
 * script reads the same key and applies it synchronously during parsing.
 *
 * Renders an iOS-style switch (.toggle + .toggle-knob) so it visually
 * matches the other toggles in the Settings panel.
 */

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "webadb.online:theme";

function readStoredTheme(): Theme | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

function resolveInitial(): Theme {
  // Order of precedence: stored choice > OS preference > light (default).
  const stored = readStoredTheme();
  if (stored) return stored;
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function ThemeToggle() {
  // Render the same switch on first paint to avoid hydration mismatch;
  // the actual state catches up on the next tick. This is intentional —
  // the inline boot script in layout.tsx has already applied the right
  // `data-theme` attribute by the time the user sees the toggle, so any
  // visual mismatch between the switch and the page is sub-frame.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(resolveInitial());
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be disabled (private mode). The visual state still
      // works for the current session; we just can't persist.
    }
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      // Use the shared `.toggle` iOS-style switch styling so the theme
      // picker matches every other toggle in the Settings panel. The
      // `aria-checked` state matches the resolved theme.
      className="toggle"
      role="switch"
      aria-checked={isDark}
    >
      <span className="toggle-knob" />
    </button>
  );
}