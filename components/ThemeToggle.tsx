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
  // Render the same button on first paint to avoid hydration mismatch;
  // the actual state catches up on the next tick. This is intentional —
  // the inline boot script in layout.tsx has already applied the right
  // `data-theme` attribute by the time the user sees the toggle, so any
  // visual mismatch between the button and the page is sub-frame.
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(resolveInitial());
    setMounted(true);
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

  // Visually stable label for the button: it always reads "Toggle theme"
  // (and shows the icon for the OTHER theme — i.e. "click to switch to
  // dark" while in light mode). Using the icon (rather than text) keeps
  // the header compact on mobile.
  const label =
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const icon = theme === "dark" ? "☀" : "☾";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="theme-toggle"
    >
      {/* Render the icon for the *opposite* of the current theme — the
          button is "switch to X", so showing X's icon is the convention.
          Until we know the resolved theme (post-mount) we render nothing
          rather than guessing, so the first paint matches the layout
          script's already-applied data-theme attribute. */}
      <span aria-hidden="true">{mounted ? icon : ""}</span>
    </button>
  );
}