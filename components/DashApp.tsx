"use client";

// ── DashApp ─────────────────────────────────────────────────────────────────
//
// Universal search ("Spotlight"-style). Press ⌘K (or Ctrl+K) anywhere to open.
// Searches across:
//   • REGISTERED_APPS    — open via Enter / click
//   • File paths         — pre-populated from localStorage (File Manager's
//                          pinned paths + recently-visited dirs)
//
// Each result kind has its own section in the dropdown. Empty query → show
// a "Start typing…" hint plus a quick-launch row of all enabled apps.
//
// Open with: openAppWindow("dash")

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  REGISTERED_APPS,
  loadEnabled,
  type AppDefinition,
} from "@/lib/app-registry";

interface DashAppProps {
  /** Launch another app from a search result. Optional for type compat. */
  onLaunchApp?: (appId: string) => void;
}

interface AppResult {
  kind: "app";
  id: string;
  title: string;
  icon: ReactNode;
  desc: string;
}

interface PathResult {
  kind: "path";
  path: string;
}

type Result = AppResult | PathResult;

const PINNED_KEY = "webadb.fm.pinned";
const RECENT_KEY = "webadb.fm.recent";

function loadStoredPaths(): string[] {
  try {
    const pinned = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]") as string[];
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    return Array.from(new Set([...pinned, ...recent]));
  } catch {
    return [];
  }
}

function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  // Subsequence match: every char of needle appears in haystack in order.
  let i = 0;
  for (const c of h) {
    if (c === n[i]) i++;
    if (i === n.length) return true;
  }
  return i === n.length;
}

export function DashApp({
  onLaunchApp = () => {},
}: DashAppProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0); // keyboard navigation index
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount; re-focus on each query change to keep caret at end.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Refresh enabled set + cached paths whenever storage changes.
  const [enabledIds, setEnabledIds] = useState(
    () => new Set<string>(REGISTERED_APPS.map((a) => a.id)),
  );
  const [paths, setPaths] = useState<string[]>([]);

  useEffect(() => {
    setEnabledIds(loadEnabled(REGISTERED_APPS));
    setPaths(loadStoredPaths());

    const refresh = () => {
      setEnabledIds(loadEnabled(REGISTERED_APPS));
      setPaths(loadStoredPaths());
    };
    // StorageEvent doesn't fire in the same window, so poll lightly.
    const id = window.setInterval(refresh, 1500);
    window.addEventListener("storage", refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Build result set. Apps flagged `alwaysEnabled` are always shown
  // regardless of the user's enable/disable preferences — that way the
  // user can search for Settings and re-enable things even if they
  // disabled everything via the Settings panel.
  const results: Result[] = useMemo(() => {
    const apps: AppResult[] = REGISTERED_APPS
      .filter((a) => enabledIds.has(a.id) || a.alwaysEnabled === true)
      .filter((a) => fuzzy(`${a.title} ${a.description ?? ""}`, query))
      .map((a) => ({
        kind: "app",
        id: a.id,
        title: a.title,
        icon: a.icon,
        desc: a.description ?? "",
      }));

    const pathResults: PathResult[] = paths
      .filter((p) => fuzzy(p, query))
      .map((p) => ({ kind: "path", path: p }));

    return [...apps, ...pathResults];
  }, [query, enabledIds, paths]);

  // Keep `active` in bounds as results shrink.
  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [results.length, active]);

  const choose = (r: Result) => {
    if (r.kind === "app") onLaunchApp(r.id);
    // For path results we just open File Manager — the path itself isn't
    // navigable from here yet; the FM can render a future "open to path" hook.
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        results.length === 0 ? 0 : (i - 1 + results.length) % results.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) choose(r);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
    }
  };

  return (
    <div className="dash-app">
      <div className="dash-input-wrap">
        <span className="dash-input-icon" aria-hidden>🔎</span>
        <input
          ref={inputRef}
          type="text"
          className="dash-input"
          placeholder="Search apps, paths…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="dash-results" role="listbox">
        {results.length === 0 ? (
          <div className="dash-empty">No matches.</div>
        ) : (
          results.map((r, i) => (
            <button
              key={`${r.kind}:${r.kind === "app" ? r.id : r.path}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`dash-result${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <span className="dash-result-icon" aria-hidden>
                {r.kind === "app" ? r.icon : "📂"}
              </span>
              <span className="dash-result-text">
                <strong>
                  {r.kind === "app" ? r.title : r.path}
                </strong>
                {r.kind === "app" && r.desc && (
                  <span className="dash-result-desc">{r.desc}</span>
                )}
              </span>
              <span className="dash-result-kind">
                {r.kind === "app" ? "App" : "Path"}
              </span>
            </button>
          ))
        )}
      </div>

      <footer className="dash-footer">
        <kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> clear
      </footer>
    </div>
  );
}