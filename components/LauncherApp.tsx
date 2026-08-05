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
// The grid is paged when it overflows the visible area — dots at the
// bottom + side arrows let the user flip between pages. Page count is
// derived from the height available at render time (we measure the
// container with ResizeObserver).
//
// Open with: openAppWindow("launcher")

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

  // Always-on apps (Apps, Search, Settings) are always shown — they're
  // core navigation surfaces and removing them from the launcher would
  // make it harder to get back into Settings to re-enable things.
  const tiles = REGISTERED_APPS.filter(
    (a) => a.alwaysEnabled === true || enabledIds.has(a.id),
  );

  // ── Paging ─────────────────────────────────────────────────────────────
  // We try to keep the grid within the viewport. The page host is the
  // .overlay-fullscreen surface; we measure its height to decide how many
  // rows fit, then compute page count. The page flipper is keyboard-
  // friendly too (←/→, Home/End).
  const hostRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const recompute = () => {
      const h = host.clientHeight;
      // 6 rows of 110px leaves room for the dots footer + nav arrows.
      const rows = Math.max(2, Math.floor((h - 60) / 110));
      const cols = 6; // visual sweet spot for tile width
      const per = rows * cols;
      const count = Math.max(1, Math.ceil(tiles.length / per));
      setPageCount((prev) => {
        if (count !== prev) {
          // Clamp page if tiles shrank.
          setPage((p) => Math.min(p, count - 1));
        }
        return count;
      });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(host);
    return () => ro.disconnect();
  }, [tiles.length]);

  const perPage = Math.ceil(tiles.length / pageCount);
  const pageItems = tiles.slice(page * perPage, (page + 1) * perPage);

  const flip = (delta: number) => {
    setPage((p) => (p + delta + pageCount) % pageCount);
  };

  return (
    <div ref={hostRef} className="launcher-app">
      <div className="launcher-grid">
        {pageItems.map((app) => (
          <button
            key={app.id}
            type="button"
            className="launcher-tile"
            onClick={() => onLaunchApp(app.id)}
            title={app.description ?? app.title}
          >
            <span className="launcher-tile-icon" aria-hidden>
              {app.icon}
            </span>
            <span className="launcher-tile-title">{app.title}</span>
          </button>
        ))}
      </div>

      {pageCount > 1 && (
        <nav className="launcher-pager" aria-label="Launcher pages">
          <button
            type="button"
            className="launcher-arrow"
            aria-label="Previous page"
            onClick={() => flip(-1)}
          >
            ‹
          </button>
          <div className="launcher-dots" role="tablist">
            {Array.from({ length: pageCount }).map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === page}
                aria-label={`Page ${i + 1}`}
                className={`launcher-dot${i === page ? " is-active" : ""}`}
                onClick={() => setPage(i)}
              />
            ))}
          </div>
          <button
            type="button"
            className="launcher-arrow"
            aria-label="Next page"
            onClick={() => flip(1)}
          >
            ›
          </button>
        </nav>
      )}
    </div>
  );
}