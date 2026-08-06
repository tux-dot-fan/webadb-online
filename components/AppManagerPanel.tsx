"use client";

// ── AppManagerPanel ─────────────────────────────────────────────────────────
//
// Comprehensive installed-app manager. Lists every package on the device
// (system + third-party), shows a generated avatar tile with label and
// package name, and lets the user:
//
//   • filter by All / System / Third-party / Disabled
//   • search by label or package name
//   • sort by label / size / install date
//   • launch, disable, enable, clear data, uninstall
//   • inspect permissions and grant/revoke runtime permissions
//
// Icons: each row fetches the package's real launcher icon from the APK via
// `adb shell unzip -p <apk> <res>`, with a module-level cache so the row
// list and the detail pane share one ADB round-trip per package. Falls back
// to the colored-letter avatar when extraction fails (no declared icon,
// APK repacked, network error, …).

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  getAdbClient,
  type AdbSession,
  type AppComponent,
  type PackageInfo,
  type PackageMeta,
  type PackageDetails,
} from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

type FilterMode = "all" | "system" | "user" | "disabled";
type SortMode = "label" | "size" | "install";

/**
 * A package is "system" iff its APK lives on a read-only system volume.
 * The list mirrors Android's `PackageParser.parsePackageSplitName` and the
 * system volume set defined in
 * `frameworks/base/core/java/android/os/Environment.java` /
 * `core/java/android/content/pm/PackageManagerService.java`:
 *
 *   • /system/app/, /system/priv-app/         (AOSP read-only image)
 *   • /system_ext/app/, /system_ext/priv-app/ (system extension, e.g. GMS)
 *   • /vendor/app/, /vendor/priv-app/         (SoC vendor, e.g. Qualcomm)
 *   • /product/app/, /product/priv-app/       (OEM product image, e.g. MIUI)
 *   • /oem/app/, /oem/priv-app/               (OEM-specific, optional)
 *
 * Everything else — `/data/app/` (user installs), `/data/user_de/0/...`,
 * manually sideloaded paths, etc. — is third-party.
 *
 * We deliberately DO NOT trust dumpsys `System app:` / `Flags=` markers —
 * those are absent or wrong on many OEM ROMs (MIUI/HyperOS, ColorOS, OneUI),
 * which caused every package to be misclassified as third-party.
 */
const SYSTEM_PATH_PREFIXES: readonly string[] = [
  "/system/app/",
  "/system/priv-app/",
  "/system_ext/app/",
  "/system_ext/priv-app/",
  "/vendor/app/",
  "/vendor/priv-app/",
  "/product/app/",
  "/product/priv-app/",
  "/oem/app/",
  "/oem/priv-app/",
];

function isSystemPackage(apkPath: string): boolean {
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (apkPath.startsWith(prefix)) return true;
  }
  return false;
}

interface Row {
  pkg: PackageInfo;
  meta: PackageMeta | null;
  /** Total APK size in bytes, lazily fetched. */
  size: number | null;
  /** Per-app dumpsys details, lazily fetched. */
  details: PackageDetails | null;
  /** True once both async fields are populated (or have failed). */
  ready: boolean;
}

// ── Avatar / colour helpers ─────────────────────────────────────────────────

/**
 * Pick a deterministic background colour for a package. Hue comes from a
 * hash of the name so the same app always gets the same colour; sat/light
 * are fixed in the pleasant range.
 */
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

/** First letter for an avatar. Falls back to "?" for empty labels. */
function avatarLetter(label: string, pkg: string): string {
  const trimmed = label.trim();
  if (trimmed.length > 0) {
    // Use the first grapheme (so emoji and CJK render as a single tile).
    const cp = trimmed.codePointAt(0);
    if (cp !== undefined) return String.fromCodePoint(cp).toUpperCase();
  }
  // Fallback to the package's first letter (e.g. "c" for com.example.app).
  const seg = pkg.split(".").filter(Boolean);
  const last = seg[seg.length - 1] ?? pkg;
  return (last[0] ?? "?").toUpperCase();
}

/** Format a byte count as a short human string ("12.4 MB"). */
function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Detect the MIME type from the first few bytes of an icon payload, so the
 * browser tags the Blob correctly and `<img>` decodes without sniffing.
 */
function iconMime(bytes: Uint8Array): string {
  if (bytes.length >= 4 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "application/octet-stream";
}

/**
 * Module-level icon cache. Keyed by APK path so that the detail pane and
 * the row list for the same package share one ADB round-trip.
 *
 * Value is the promise (not the bytes) so concurrent callers all await the
 * same `unzip -p` invocation instead of fanning out N requests.
 */
const iconFetchCache = new Map<string, Promise<Uint8Array | null>>();
function fetchIcon(apkPath: string, candidates: readonly string[]): Promise<Uint8Array | null> {
  const key = apkPath + "\u0000" + candidates.join("|");
  let p = iconFetchCache.get(key);
  if (!p) {
    p = getAdbClient().getPackageIcon(apkPath, candidates);
    iconFetchCache.set(key, p);
  }
  return p;
}

/** Render an app icon: tries the real raster from the APK, falls back to the
 * colored-letter avatar. The fetch is shared across instances via a
 * module-level cache so two avatars for the same APK share one ADB call.
 */
function AppIcon({
  apkPath, candidates, colour, letter, size,
}: {
  apkPath: string;
  candidates: readonly string[];
  colour: string;
  letter: string;
  /** "sm" (default, 40px row) or "lg" (96px detail). */
  size?: "sm" | "lg";
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // Empty candidates means the APK declared no icon — skip the round-trip.
    if (candidates.length === 0) return;
    let url: string | null = null;
    let cancelled = false;
    fetchIcon(apkPath, candidates)
      .then((bytes) => {
        if (cancelled || !bytes) return;
        // Copy into a fresh ArrayBuffer so the BlobPart type is satisfied
        // (TS 5.x narrows `Uint8Array.buffer` to `ArrayBufferLike` which
        // includes SharedArrayBuffer; Blob wants a concrete ArrayBuffer).
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        const blob = new Blob([ab], { type: iconMime(bytes) });
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => { /* stay on letter avatar */ });
    return () => {
      cancelled = true;
      // Note: we don't revoke the blob URL here — the next mount of the same
      // icon (e.g. switching back to the same package) will reuse it via the
      // module cache. revokeObjectURL fires on cache eviction only.
    };
  }, [apkPath, candidates]);

  const cls = `apps-avatar${size === "lg" ? " apps-avatar-lg" : ""}`;
  if (!src) {
    return (
      <span className={cls} style={{ background: colour }} aria-hidden>
        {letter}
      </span>
    );
  }
  return (
    <span className={cls} style={{ background: colour }} aria-hidden>
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={() => {
          // Once the raster decodes we don't need the colored backdrop, but
          // we keep it visible behind transparent icons (rare for launcher
          // icons but harmless). Setting width/height in CSS keeps layout
          // stable while the image loads.
        }}
      />
    </span>
  );
}

/** Format an ISO timestamp as a short date. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

// ── Component ───────────────────────────────────────────────────────────────

export function AppManagerPanel({ session: _session }: Props) {
  const [apps, setApps] = useState<PackageInfo[] | null>(null);
  const [rowMeta, setRowMeta] = useState<Record<string, PackageMeta | null>>({});
  const [rowSize, setRowSize] = useState<Record<string, number | null>>({});
  const [rowDetails, setRowDetails] = useState<Record<string, PackageDetails | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [filter, setFilter] = useState<FilterMode>("user");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("label");
  const [selected, setSelected] = useState<string | null>(null);

  // ── Initial load ────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await getAdbClient().listInstalledPackages();
      setApps(list);
      setRowMeta({});
      setRowSize({});
      setRowDetails({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Lazy per-row enrichment ─────────────────────────────────────────────
  // For each visible row we fetch aapt2 metadata, size, and dumpsys
  // details in parallel. Each is cached so re-renders don't re-fetch.
  const inflight = useRef<Set<string>>(new Set());

  const ensureRowEnriched = useCallback(async (pkg: string, apkPath: string) => {
    if (inflight.current.has(pkg)) return;
    inflight.current.add(pkg);

    // Fire all three in parallel; each updates its own cache slice.
    const promises: Promise<void>[] = [];

    if (!(pkg in rowMeta)) {
      promises.push(
        getAdbClient()
          .getPackageMeta(apkPath)
          .then((m) => setRowMeta((p) => ({ ...p, [pkg]: m })))
          .catch(() => setRowMeta((p) => ({ ...p, [pkg]: null }))),
      );
    }
    if (!(pkg in rowSize)) {
      promises.push(
        getAdbClient()
          .getPackageSize(apkPath)
          .then((s) => setRowSize((p) => ({ ...p, [pkg]: s })))
          .catch(() => setRowSize((p) => ({ ...p, [pkg]: null }))),
      );
    }
    if (!(pkg in rowDetails)) {
      promises.push(
        getAdbClient()
          .getPackageDetails(pkg)
          .then((d) => setRowDetails((p) => ({ ...p, [pkg]: d })))
          .catch(() => setRowDetails((p) => ({ ...p, [pkg]: null }))),
      );
    }

    if (promises.length === 0) {
      inflight.current.delete(pkg);
      return;
    }
    await Promise.all(promises);
    inflight.current.delete(pkg);
  }, [rowMeta, rowSize, rowDetails]);

  // ── Filtering + sorting ─────────────────────────────────────────────────
  const visibleRows = useMemo<Row[]>(() => {
    if (!apps) return [];
    const needle = search.trim().toLowerCase();
    const rows: Row[] = [];
    for (const pkg of apps) {
      const meta = rowMeta[pkg.packageName] ?? null;
      const details = rowDetails[pkg.packageName] ?? null;
      const label = meta?.label || pkg.packageName;
      if (needle && !label.toLowerCase().includes(needle)
          && !pkg.packageName.toLowerCase().includes(needle)) {
        continue;
      }
      const isSystem = isSystemPackage(pkg.apkPath);
      const isDisabled = details ? !details.enabled : false;
      if (filter === "system" && !isSystem) continue;
      if (filter === "user" && isSystem) continue;
      if (filter === "disabled" && !isDisabled) continue;
      rows.push({
        pkg,
        meta,
        size: rowSize[pkg.packageName] ?? null,
        details,
        ready: pkg.packageName in rowMeta
            && pkg.packageName in rowSize
            && pkg.packageName in rowDetails,
      });
    }
    rows.sort((a, b) => {
      if (sort === "size") {
        return (b.size ?? -1) - (a.size ?? -1);
      }
      if (sort === "install") {
        const ad = a.details?.firstInstallTime ?? "";
        const bd = b.details?.firstInstallTime ?? "";
        return bd.localeCompare(ad);
      }
      // label
      const al = (a.meta?.label || a.pkg.packageName).toLowerCase();
      const bl = (b.meta?.label || b.pkg.packageName).toLowerCase();
      return al.localeCompare(bl);
    });
    return rows;
  }, [apps, rowMeta, rowSize, rowDetails, search, filter, sort]);

  // Auto-enrich visible rows once they're rendered, up to a concurrency
  // limit so we don't DDoS the device with 200 simultaneous aapt2 calls.
  useEffect(() => {
    let cancelled = false;
    const queue: { pkg: string; apkPath: string }[] = [];
    for (const r of visibleRows) {
      if (!r.ready) queue.push({ pkg: r.pkg.packageName, apkPath: r.pkg.apkPath });
    }
    const CONCURRENCY = 6;
    let cursor = 0;
    const workers = Array.from({ length: CONCURRENCY }, () => (async () => {
      while (!cancelled) {
        const next = queue[cursor++];
        if (!next) return;
        await ensureRowEnriched(next.pkg, next.apkPath);
      }
    })());
    void Promise.all(workers);
    return () => { cancelled = true; };
  }, [visibleRows, ensureRowEnriched]);

  // ── Selected row ────────────────────────────────────────────────────────
  const selectedRow = useMemo<Row | null>(() => {
    if (!selected || !apps) return null;
    const inVisible = visibleRows.find((r) => r.pkg.packageName === selected);
    if (inVisible) return inVisible;
    const pkgInfo = apps.find((p) => p.packageName === selected);
    if (!pkgInfo) return null;
    return {
      pkg: pkgInfo,
      meta: rowMeta[selected] ?? null,
      size: rowSize[selected] ?? null,
      details: rowDetails[selected] ?? null,
      ready: selected in rowMeta && selected in rowSize && selected in rowDetails,
    };
  }, [selected, visibleRows, apps, rowMeta, rowSize, rowDetails]);

  // Ensure selected is always enriched (so the detail panel has data).
  useEffect(() => {
    if (!selectedRow) return;
    void ensureRowEnriched(selectedRow.pkg.packageName, selectedRow.pkg.apkPath);
  }, [selectedRow, ensureRowEnriched]);

  // ── Action handlers ─────────────────────────────────────────────────────
  const [pending, setPending] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    pkg: string;
    x: number;
    y: number;
  } | null>(null);

  const action = useCallback(
    async (kind: "launch" | "launchActivity" | "disable" | "enable" | "clear" | "uninstall", pkg: string, extra?: { className?: string }) => {
      setPending(`${kind}:${pkg}`);
      setError(null);
      try {
        const client = getAdbClient();
        switch (kind) {
          case "launch":
            await client.launchPackage(pkg);
            setStatus(`Launched ${pkg}`);
            break;
          case "launchActivity": {
            if (!extra?.className) throw new Error("launchActivity needs a className");
            await client.launchActivity(pkg, extra.className);
            setStatus(`Started ${extra.className}`);
            break;
          }
          case "disable": {
            const ok = await client.setPackageEnabled(pkg, false);
            if (!ok) throw new Error("pm disable failed");
            setStatus(`Disabled ${pkg}`);
            // Invalidate cached details so the row reflects the change.
            setRowDetails((d) => ({ ...d, [pkg]: null }));
            break;
          }
          case "enable": {
            const ok = await client.setPackageEnabled(pkg, true);
            if (!ok) throw new Error("pm enable failed");
            setStatus(`Enabled ${pkg}`);
            setRowDetails((d) => ({ ...d, [pkg]: null }));
            break;
          }
          case "clear": {
            const ok = await client.clearAppData(pkg);
            if (!ok) throw new Error("pm clear failed");
            setStatus(`Cleared data for ${pkg}`);
            break;
          }
          case "uninstall": {
            const ok = await client.uninstallPackage(pkg);
            if (!ok) throw new Error("pm uninstall failed");
            setStatus(`Uninstalled ${pkg}`);
            // Drop from the package list.
            setApps((prev) => prev?.filter((p) => p.packageName !== pkg) ?? null);
            if (selected === pkg) setSelected(null);
            break;
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [selected],
  );

  // ── Permission toggle (called from the detail panel) ────────────────────
  const togglePermission = useCallback(
    async (pkg: string, perm: string, grant: boolean) => {
      setPending(`perm:${pkg}:${perm}`);
      setError(null);
      try {
        const ok = await getAdbClient().setPermission(pkg, perm, grant);
        if (!ok) throw new Error(`pm ${grant ? "grant" : "revoke"} failed`);
        setStatus(`${grant ? "Granted" : "Revoked"} ${perm}`);
        // Refetch details so the granted set stays in sync.
        setRowDetails((d) => ({ ...d, [pkg]: null }));
        await getAdbClient().getPackageDetails(pkg).then((fresh) => {
          if (fresh) setRowDetails((d) => ({ ...d, [pkg]: fresh }));
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [],
  );

  // ── Context menu outside-click dismissal ────────────────────────────────
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest(".apps-ctx-menu")) setCtxMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="apps-manager">
      {/* ── Toolbar ───────────────────────────────────────────────── */}
      <header className="apps-toolbar">
        <div className="apps-filter-chips">
          {(["all", "user", "system", "disabled"] as FilterMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`apps-chip${filter === m ? " is-active" : ""}`}
              onClick={() => setFilter(m)}
            >
              {m === "all" ? "All"
                : m === "user" ? "Third-party"
                : m === "system" ? "System"
                : "Disabled"}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="apps-search"
          placeholder="Search apps…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="apps-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          aria-label="Sort"
        >
          <option value="label">Sort by name</option>
          <option value="size">Sort by size</option>
          <option value="install">Sort by install date</option>
        </select>
        <button
          type="button"
          className="apps-refresh"
          onClick={() => void refresh()}
          disabled={busy}
          title="Reload package list"
        >
          {busy ? "…" : "↻"}
        </button>
      </header>

      {status && (
        <div className="banner info" style={{ margin: "0 0 8px" }}>
          {status}
        </div>
      )}
      {error && (
        <div className="banner error" style={{ margin: "0 0 8px" }}>
          {error}
        </div>
      )}

      <div className="apps-body">
        {/* ── Left: list ──────────────────────────────────────────── */}
        <div className="apps-list">
          {!apps && !error && (
            <div className="muted" style={{ padding: "14px 12px" }}>
              Loading package list…
            </div>
          )}
          {apps && visibleRows.length === 0 && (
            <div className="muted" style={{ padding: "14px 12px" }}>
              No apps match your filter.
            </div>
          )}
          {visibleRows.map((r) => {
            const isSelected = r.pkg.packageName === selected;
            const letter = avatarLetter(r.meta?.label ?? "", r.pkg.packageName);
            const colour = avatarColor(r.pkg.packageName);
            const label = r.meta?.label || r.pkg.packageName;
            const isSystem = isSystemPackage(r.pkg.apkPath);
            const isDisabled = r.details ? !r.details.enabled : false;
            return (
              <button
                key={r.pkg.packageName}
                type="button"
                className={`apps-row${isSelected ? " is-selected" : ""}`}
                onClick={() => setSelected(r.pkg.packageName)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(r.pkg.packageName);
                  setCtxMenu({ pkg: r.pkg.packageName, x: e.clientX, y: e.clientY });
                }}
              >
                <AppIcon
                  apkPath={r.pkg.apkPath}
                  candidates={r.meta?.iconCandidates ?? []}
                  colour={colour}
                  letter={letter}
                />
                <span className="apps-row-text">
                  <span className="apps-row-label">{label}</span>
                  <span className="apps-row-pkg">{r.pkg.packageName}</span>
                </span>
                <span className="apps-row-meta">
                  {isSystem && <span className="apps-badge apps-badge-system">sys</span>}
                  {isDisabled && <span className="apps-badge apps-badge-disabled">off</span>}
                  <span className="apps-row-size">{formatBytes(r.size)}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Right: detail ───────────────────────────────────────── */}
        {selectedRow ? (
          <AppDetail
            key={selectedRow.pkg.packageName}
            row={selectedRow}
            pending={pending}
            onLaunch={() => void action("launch", selectedRow.pkg.packageName)}
            onLaunchActivity={(className) => void action(
              "launchActivity",
              selectedRow.pkg.packageName,
              { className },
            )}
            onToggle={() => void action(
              selectedRow.details?.enabled ? "disable" : "enable",
              selectedRow.pkg.packageName,
            )}
            onClear={() => void action("clear", selectedRow.pkg.packageName)}
            onUninstall={() => void action("uninstall", selectedRow.pkg.packageName)}
            onTogglePermission={(perm, grant) => void togglePermission(
              selectedRow.pkg.packageName, perm, grant,
            )}
          />
        ) : (
          <div className="apps-detail apps-detail-empty">
            <div className="apps-empty-icon">📱</div>
            <p>Select an app to view its details.</p>
          </div>
        )}
      </div>

      {/* ── Right-click context menu ──────────────────────────────── */}
      {ctxMenu && (
        <div
          className="apps-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
        >
          <ContextItem
            onClick={() => {
              void action("launch", ctxMenu.pkg);
              setCtxMenu(null);
            }}
          >
            ▶ Launch
          </ContextItem>
          {(() => {
            const r = visibleRows.find((x) => x.pkg.packageName === ctxMenu.pkg);
            const enabled = r?.details?.enabled ?? true;
            return (
              <ContextItem
                onClick={() => {
                  void action(enabled ? "disable" : "enable", ctxMenu.pkg);
                  setCtxMenu(null);
                }}
              >
                {enabled ? "⊘ Disable" : "✓ Enable"}
              </ContextItem>
            );
          })()}
          <ContextItem
            onClick={() => {
              void action("clear", ctxMenu.pkg);
              setCtxMenu(null);
            }}
          >
            🧹 Clear data
          </ContextItem>
          <div className="apps-ctx-sep" />
          <ContextItem
            danger
            onClick={() => {
              if (confirm(`Uninstall ${ctxMenu.pkg}? This cannot be undone.`)) {
                void action("uninstall", ctxMenu.pkg);
              }
              setCtxMenu(null);
            }}
          >
            🗑 Uninstall
          </ContextItem>
        </div>
      )}
    </div>
  );
}

// ── Detail panel ────────────────────────────────────────────────────────────

interface AppDetailProps {
  row: Row;
  pending: string | null;
  onLaunch: () => void;
  /**
   * Launch a specific Activity (deep-link). The className comes from
   * dumpsys and is already in `<pkg>/<class>` form, so we pass it
   * straight to `am start -n`. We don't surface a similar hook for
   * services / receivers / providers because Android doesn't have a
   * simple CLI to start a service or send a broadcast targeted at a
   * specific component — surfacing broken-looking buttons would be
   * worse than not surfacing them.
   */
  onLaunchActivity: (className: string) => void;
  onToggle: () => void;
  onClear: () => void;
  onUninstall: () => void;
  onTogglePermission: (perm: string, grant: boolean) => void;
}

function AppDetail({
  row, pending,
  onLaunch, onLaunchActivity, onToggle, onClear, onUninstall,
  onTogglePermission,
}: AppDetailProps) {
  const label = row.meta?.label || row.pkg.packageName;
  const letter = avatarLetter(label, row.pkg.packageName);
  const colour = avatarColor(row.pkg.packageName);
  const isSystem = isSystemPackage(row.pkg.apkPath);
  const isEnabled = row.details?.enabled ?? true;
  const requested = row.details?.requestedPermissions ?? [];
  const granted = row.details?.grantedPermissions ?? [];
  const grantedSet = new Set(granted);
  const components = {
    activity: row.details?.activities ?? [],
    service: row.details?.services ?? [],
    receiver: row.details?.receivers ?? [],
    provider: row.details?.providers ?? [],
  };
  const totalComponents =
    components.activity.length
    + components.service.length
    + components.receiver.length
    + components.provider.length;

  const busy = (suffix: string) => pending === `${suffix}:${row.pkg.packageName}`;

  return (
    <div className="apps-detail">
      <header className="apps-detail-header">
        <AppIcon
          apkPath={row.pkg.apkPath}
          candidates={row.meta?.iconCandidates ?? []}
          colour={colour}
          letter={letter}
          size="lg"
        />
        <div className="apps-detail-titles">
          <h3 className="apps-detail-label">{label}</h3>
          <p className="apps-detail-pkg">{row.pkg.packageName}</p>
          {isSystem && <span className="apps-badge apps-badge-system">System app</span>}
          {!isEnabled && <span className="apps-badge apps-badge-disabled">Disabled</span>}
          {row.meta?.debuggable && <span className="apps-badge apps-badge-debug">debuggable</span>}
        </div>
      </header>

      <div className="apps-detail-actions">
        <button type="button" onClick={onLaunch} disabled={pending !== null || !isEnabled}
          title={isEnabled ? "Launch this app" : "App is disabled"}>
          ▶ Launch
        </button>
        <button type="button" onClick={onToggle}
          disabled={pending !== null || isSystem}
          title={isSystem ? "System apps can't be disabled" : (isEnabled ? "Disable" : "Enable")}>
          {isEnabled ? "⊘ Disable" : "✓ Enable"}
        </button>
        <button type="button" onClick={onClear}
          disabled={pending !== null || !isEnabled}
          title="Wipe app data (pm clear)">
          🧹 Clear data
        </button>
        <button
          type="button"
          className="apps-danger-btn"
          onClick={() => {
            if (confirm(`Uninstall ${row.pkg.packageName}? This cannot be undone.`)) onUninstall();
          }}
          disabled={busy("uninstall") || isSystem}
          title={isSystem ? "System apps can't be uninstalled" : "Uninstall"}
        >
          🗑 Uninstall
        </button>
      </div>

      <dl className="apps-detail-meta">
        <dt>Version</dt>
        <dd>
          {row.meta?.versionName ?? "—"}
          {row.meta?.versionCode !== null && row.meta?.versionCode !== undefined
            ? <span className="muted"> ({row.meta.versionCode})</span>
            : null}
        </dd>
        <dt>Size</dt>
        <dd>{formatBytes(row.size)}</dd>
        <dt>Target SDK</dt>
        <dd>{row.meta?.targetSdk ?? "—"}</dd>
        <dt>Min SDK</dt>
        <dd>{row.meta?.minSdk ?? "—"}</dd>
        <dt>ABI</dt>
        <dd>{row.details?.primaryCpuAbi ?? "—"}</dd>
        <dt>Installed</dt>
        <dd>{formatDate(row.details?.firstInstallTime ?? null)}</dd>
        <dt>Updated</dt>
        <dd>{formatDate(row.details?.lastUpdateTime ?? null)}</dd>
        <dt>APK path</dt>
        <dd className="apps-meta-path">{row.pkg.apkPath}</dd>
      </dl>

      {/*
        Components section — Activities / Services / Receivers / Providers
        declared by this package in its manifest. We surface them so a
        developer can answer "what can this app actually expose to
        other apps / to my testing harness?" without leaving the
        browser.

        UX:
          • 4 tabs at the top with counts; default "All".
          • Each row: className, optional "permission" badge if gated,
            "exported" / "not exported" pill, intent action chips.
          • Activity rows are clickable — they fire `am start -n`,
            which is the standard developer way to deep-link to a
            sub-screen (e.g. jump straight to
            Settings → ConfigureNotificationSettingsActivity).
          • Service / Receiver / Provider rows are NOT clickable.
            Android has no clean CLI to invoke a service directly or
            target a broadcast at a specific component, so we'd have
            to fake it with `am startservice` / `am broadcast` and a
            hand-rolled intent. Showing broken-looking buttons is
            worse than not showing any — keep these as read-only.
      */}
      <section className="apps-components">
        <h4>Components ({totalComponents})</h4>
        {totalComponents === 0 ? (
          <p className="muted">No components declared.</p>
        ) : (
          <ComponentsList
            components={components}
            busyActivityClass={busy("launchActivity")}
            onLaunchActivity={(cls) => onLaunchActivity(cls)}
          />
        )}
      </section>

      <section className="apps-perms">
        <h4>Permissions ({requested.length})</h4>
        {requested.length === 0 ? (
          <p className="muted">No permissions declared.</p>
        ) : (
          <ul className="apps-perms-list">
            {requested.map((perm) => {
              const isGranted = grantedSet.has(perm);
              const id = `perm-${row.pkg.packageName}-${perm}`;
              return (
                <li key={perm} className={`apps-perm${isGranted ? " is-granted" : ""}`}>
                  <label htmlFor={id} className="apps-perm-label" title={perm}>
                    {perm}
                  </label>
                  <span className="toggle apps-perm-toggle">
                    <input
                      id={id}
                      type="checkbox"
                      checked={isGranted}
                      onChange={(e) => onTogglePermission(perm, e.target.checked)}
                      disabled={pending === `perm:${row.pkg.packageName}:${perm}`}
                    />
                    <span className="toggle-knob" />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── Components list (Activities / Services / Receivers / Providers) ─────────

type ComponentKind = "activity" | "service" | "receiver" | "provider";

const KIND_LABEL: Record<ComponentKind, string> = {
  activity: "Activity",
  service: "Service",
  receiver: "Receiver",
  provider: "Provider",
};

const KIND_ICON: Record<ComponentKind, string> = {
  activity: "▶",
  service: "⚙",
  receiver: "📡",
  provider: "🗄",
};

interface ComponentsListProps {
  components: Record<ComponentKind, AppComponent[]>;
  busyActivityClass: boolean;
  onLaunchActivity: (className: string) => void;
}

function ComponentsList({
  components, busyActivityClass, onLaunchActivity,
}: ComponentsListProps) {
  const [activeTab, setActiveTab] = useState<ComponentKind | "all">("all");

  const tabs: Array<{ key: ComponentKind | "all"; label: string; count: number }> = [
    { key: "all", label: "All", count:
      components.activity.length + components.service.length +
      components.receiver.length + components.provider.length },
    { key: "activity", label: "Activities", count: components.activity.length },
    { key: "service", label: "Services", count: components.service.length },
    { key: "receiver", label: "Receivers", count: components.receiver.length },
    { key: "provider", label: "Providers", count: components.provider.length },
  ];

  const visible: Array<{ kind: ComponentKind; c: AppComponent }> = activeTab === "all"
    ? [
        ...components.activity.map((c) => ({ kind: "activity" as const, c })),
        ...components.service.map((c) => ({ kind: "service" as const, c })),
        ...components.receiver.map((c) => ({ kind: "receiver" as const, c })),
        ...components.provider.map((c) => ({ kind: "provider" as const, c })),
      ]
    : components[activeTab].map((c) => ({ kind: activeTab, c }));

  return (
    <div className="apps-components-list">
      <div className="apps-components-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`apps-components-tab${activeTab === t.key ? " is-active" : ""}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label} <span className="apps-components-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      <ul className="apps-components-rows">
        {visible.map(({ kind, c }) => (
          <ComponentRow
            key={`${kind}:${c.className}`}
            kind={kind}
            component={c}
            // Activity rows are launchable; the others are read-only.
            // We pass `undefined` for non-launchable rows so the row
            // renders as a plain <li> instead of a <button>, and the
            // visual hint is "this is informational, not actionable".
            onLaunch={kind === "activity"
              ? () => onLaunchActivity(c.className)
              : undefined}
            busy={kind === "activity" && busyActivityClass}
          />
        ))}
      </ul>
    </div>
  );
}

interface ComponentRowProps {
  kind: ComponentKind;
  component: AppComponent;
  onLaunch?: () => void;
  busy: boolean;
}

function ComponentRow({ kind, component, onLaunch, busy }: ComponentRowProps) {
  const inner = (
    <>
      <span className="apps-component-kind" aria-hidden="true">
        {KIND_ICON[kind]}
      </span>
      <span className="apps-component-body">
        <span className="apps-component-name" title={component.className}>
          {component.className}
        </span>
        {component.intentActions.length > 0 && (
          <span className="apps-component-actions">
            {component.intentActions.slice(0, 3).map((a) => (
              <span key={a} className="apps-component-action" title={a}>
                {shortenAction(a)}
              </span>
            ))}
            {component.intentActions.length > 3 && (
              <span className="apps-component-action apps-component-action-more">
                +{component.intentActions.length - 3}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="apps-component-meta">
        {component.permission && (
          <span
            className="apps-component-perm"
            title={component.permission}
          >
            🔒 {shortenPermission(component.permission)}
          </span>
        )}
        <span
          className={`apps-component-exported${component.exported ? "" : " is-private"}`}
          title={component.exported
            ? component.permission
              ? `Exported, gated by ${component.permission}`
              : "Exported, callable by anyone"
            : "Not exported"}
        >
          {component.exported ? "exported" : "private"}
        </span>
      </span>
    </>
  );

  if (!onLaunch) {
    return <li className="apps-component-row apps-component-row--readonly">{inner}</li>;
  }
  return (
    <li className="apps-component-row apps-component-row--launchable">
      <button
        type="button"
        className="apps-component-launch"
        onClick={onLaunch}
        disabled={busy}
        title={`Launch ${component.className}`}
      >
        {inner}
      </button>
    </li>
  );
}

/**
 * Trim a fully-qualified intent action down to its last segment so
 * chips like "android.intent.action.MAIN" become "MAIN" and fit on
 * one line. We keep the full string in the `title` attribute for
 * hover-tooltips.
 */
function shortenAction(action: string): string {
  const i = action.lastIndexOf(".");
  return i >= 0 ? action.slice(i + 1) : action;
}

/** Same idea for permission names: "android.permission.READ_CONTACTS" → "READ_CONTACTS". */
function shortenPermission(perm: string): string {
  return shortenAction(perm);
}

function ContextItem({
  onClick, danger, children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`apps-ctx-item${danger ? " apps-ctx-item-danger" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}