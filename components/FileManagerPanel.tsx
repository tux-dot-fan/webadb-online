"use client";

import { useState, useEffect, useRef, useCallback, type ChangeEvent, Fragment } from "react";
import type { AdbSession } from "@/lib/adb-client";
import { LinuxFileType } from "@yume-chan/adb";

interface Props {
  session: AdbSession;
  /** Called when the user chooses "Open Terminal Here". Receives the directory path. */
  onOpenShell?: (path: string) => void;
}

interface Entry {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  type: LinuxFileType;
}

// ── Pinned paths (localStorage) ─────────────────────────────────────────────

const PINNED_STORAGE_KEY = "webadb.fmgr.pins";
const PINS_SEEDED_KEY = "webadb.fmgr.pins.seeded"; // tracks first-run default seeding
const SELECTED_STORAGE_KEY = "webadb.fmgr.selected"; // optional persistence

// Reasonable Android default locations — shown as pins on first run so the
// user has somewhere to start without having to navigate from / every time.
const DEFAULT_PINS: string[] = [
  "/sdcard",
  "/sdcard/DCIM",
  "/sdcard/Download",
  "/sdcard/Pictures",
  "/sdcard/Movies",
  "/sdcard/Music",
  "/sdcard/Documents",
  "/storage/emulated/0/Android/data",
];

function loadPins(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (raw !== null) {
      // User already has pins (even if empty) — don't override their choices.
      return JSON.parse(raw);
    }
  } catch { /* ignore */ }
  // First-ever load — seed sensible Android defaults so the user can start
  // browsing common folders without having to navigate from / first.
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(DEFAULT_PINS));
    localStorage.setItem(PINS_SEEDED_KEY, "1");
  } catch { /* ignore */ }
  return DEFAULT_PINS;
}

function savePins(pins: string[]) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pins));
  } catch { /* ignore */ }
}

// ── Preview kind detection ────────────────────────────────────────────────────

const PREVIEWABLE_TEXT = [
  ".txt", ".log", ".json", ".xml", ".html", ".htm",
  ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".c", ".cpp",
  ".h", ".hpp", ".py", ".sh", ".bash", ".zsh", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf", ".properties", ".md", ".rst",
  ".gradle", ".kt", ".java", ".smali", ".prop", ".rc", ".gitignore",
  ".env", ".csv", ".tsv", ".sql", ".go", ".rs", ".rb", ".php",
];
const PREVIEWABLE_IMAGE = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif",
];
const PREVIEWABLE_VIDEO = [
  ".mp4", ".mkv", ".webm", ".avi", ".mov", ".3gp", ".flv", ".wmv", ".m4v",
];
const PREVIEWABLE_AUDIO = [
  ".mp3", ".ogg", ".opus", ".wav", ".flac", ".aac", ".m4a", ".wma", ".ape", ".ac3",
];

function previewKind(name: string): "text" | "image" | "video" | "audio" | "binary" {
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if (PREVIEWABLE_TEXT.includes(ext))  return "text";
  if (PREVIEWABLE_IMAGE.includes(ext)) return "image";
  if (PREVIEWABLE_VIDEO.includes(ext)) return "video";
  if (PREVIEWABLE_AUDIO.includes(ext)) return "audio";
  return "binary";
}

/**
 * Single preview state. Holds the active preview plus the list of
 * sibling files of the same kind in the current directory — used by
 * the image viewer to support prev/next navigation and the macOS-style
 * thumbnail strip.
 */
interface PreviewState {
  url: string;
  name: string;
  kind: "text" | "image" | "video" | "audio" | "binary";
  content?: string;
  /** All entries in the same directory of the same previewable kind. */
  siblings: Entry[];
  /** Index of the current file inside `siblings`. */
  index: number;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function fullPath(cwd: string, name: string) {
  return cwd === "/" ? `/${name}` : `${cwd}/${name}`;
}

function parentPath(cwd: string): string {
  if (cwd === "/") return "/";
  const parts = cwd.split("/").filter(Boolean);
  parts.pop();
  return "/" + parts.join("/");
}

function pathSegments(p: string): string[] {
  return ["/", ...p.split("/").filter(Boolean)];
}

function formatSize(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMode(mode: number): string {
  const r = (mode >> 6) & 7;
  const w = (mode >> 3) & 7;
  const x =  mode       & 7;
  const t = (n: number) =>
    (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
  return t(r) + t(w) + t(x);
}

async function streamToBlob(stream: ReadableStream<Uint8Array>): Promise<Blob> {
  const parts: BlobPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value as BlobPart);
  }
  return new Blob(parts);
}

// ── Context menu ────────────────────────────────────────────────────────────

interface ContextMenu {
  x: number; // screen clientX
  y: number; // screen clientY
  entry: Entry;
  isDir: boolean;
  path: string;
  isPinned: boolean;
}

function ContextMenuUI({
  menu,
  onClose,
  onOpen,
  onPreview,
  onOpenTerminalHere,
  onPin,
  onUnpin,
  onCopyName,
  onCopyPath,
  onDownload,
}: {
  menu: ContextMenu;
  onClose: () => void;
  onOpen: () => void;
  onPreview: () => void;
  onOpenTerminalHere: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onCopyName: () => void;
  onCopyPath: () => void;
  onDownload: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler, true);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler, true);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  // Adjust so menu stays in viewport
  const style: React.CSSProperties = {
    position: "fixed",
    top: menu.y,
    left: menu.x,
    zIndex: 9999,
  };

  const item = (label: string, icon: string, action: () => void, danger?: boolean) => (
    <button
      className={`ctx-item${danger ? " danger" : ""}`}
      onClick={() => { action(); onClose(); }}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );

  const sep = () => <div className="ctx-sep" key={Math.random()} />;

  return (
    <div ref={ref} className="ctx-menu" style={style} role="menu">
      {/* Open */}
      {item("Open", menu.isDir ? "📂" : "📄", onOpen)}

      {/* Preview — only for files (not dirs) */}
      {!menu.isDir && item("Preview", "👁", onPreview)}

      {sep()}

      {/* Open Terminal Here — only for directories */}
      {menu.isDir && item("Open Terminal Here", "🐚", onOpenTerminalHere)}

      {/* Pin / Unpin — only for directories */}
      {menu.isDir && menu.isPinned && item("Unpin from Sidebar", "☆", onUnpin)}
      {menu.isDir && !menu.isPinned && item("Pin to Sidebar", "📌", onPin)}

      {sep()}

      {/* Copy */}
      {item("Copy Name", "📋", onCopyName)}
      {item("Copy Path", "🔗", onCopyPath)}

      {/* Download — only for files */}
      {!menu.isDir && item("Download", "⬇", onDownload)}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function FileManagerPanel({ session, onOpenShell }: Props) {
  const [cwd, setCwd] = useState("/sdcard");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [pinned, setPinned] = useState<string[]>(loadPins);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  // ── Multi-select ─────────────────────────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false); // multi-select toggle
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelected, setLastSelected] = useState<string | null>(null);

  function clearSelection() { setSelected(new Set()); setLastSelected(null); }
  function exitSelectMode() { setSelectMode(false); clearSelection(); }

  const list = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const raw = await session.adb.sync.readdir(path);
      const out: Entry[] = raw.map((e) => ({
        name: e.name,
        mode: e.mode,
        size: Number(e.size),
        mtime: Number(e.mtime),
        type: e.type,
      }));
      out.sort((a, b) => {
        const ad = a.type === LinuxFileType.Directory;
        const bd = b.type === LinuxFileType.Directory;
        if (ad !== bd) return ad ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(out);
      setCwd(path);
      exitSelectMode();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries(null);
    } finally {
      setBusy(false);
    }
  }, [session]);

  // Initial load
  useEffect(() => { void list("/sdcard"); }, [list]);

  // ── Path editing (double-click breadcrumb) ───────────────────────────────
  const [pathEditing, setPathEditing] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pathEditing && pathInputRef.current) {
      pathInputRef.current.focus();
      pathInputRef.current.select();
    }
  }, [pathEditing]);

  // ── Pin management ───────────────────────────────────────────────────────

  const pinCurrent = () => {
    const next = pinned.includes(cwd)
      ? pinned.filter((p) => p !== cwd)
      : [...pinned, cwd];
    setPinned(next);
    savePins(next);
  };

  const unpin = (path: string) => {
    const next = pinned.filter((p) => p !== path);
    setPinned(next);
    savePins(next);
  };

  // ── Preview / Download ────────────────────────────────────────────────────

  /**
   * Build the list of previewable siblings for a given file (used by the
   * image viewer for prev/next navigation). Only files of the same kind
   * are included — i.e. when viewing an image we list other images only.
   */
  function siblingsOf(entry: Entry): Entry[] {
    if (!entries) return [entry];
    const kind = previewKind(entry.name);
    if (kind === "binary") return [entry];
    return entries.filter(
      (e) => e.type === LinuxFileType.File && previewKind(e.name) === kind,
    );
  }

  async function openPreview(entry: Entry) {
    if (entry.type !== LinuxFileType.File) return;
    const remote = fullPath(cwd, entry.name);
    const kind = previewKind(entry.name);
    const sibs = siblingsOf(entry);
    const idx = Math.max(0, sibs.findIndex((e) => e.name === entry.name));

    // Revoke any prior blob URL so we don't leak memory between previews.
    if (preview?.url) URL.revokeObjectURL(preview.url);

    try {
      const stream = session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;

      if (kind === "text") {
        if (entry.size > 512 * 1024) {
          setError(`Text file too large (${formatSize(entry.size)}). Download it to view.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: "", name: entry.name, kind: "text", content: await blob.text(),
          siblings: sibs, index: idx });
      } else if (kind === "image") {
        if (entry.size > 100 * 1024 * 1024) {
          setError(`Image too large (${formatSize(entry.size)}). Download it to view.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: URL.createObjectURL(blob), name: entry.name, kind: "image",
          siblings: sibs, index: idx });
      } else if (kind === "video") {
        if (entry.size > 500 * 1024 * 1024) {
          setError(`Video too large (${formatSize(entry.size)}). Download it to view.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: URL.createObjectURL(blob), name: entry.name, kind: "video",
          siblings: sibs, index: idx });
      } else if (kind === "audio") {
        if (entry.size > 100 * 1024 * 1024) {
          setError(`Audio too large (${formatSize(entry.size)}). Download to listen.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: URL.createObjectURL(blob), name: entry.name, kind: "audio",
          siblings: sibs, index: idx });
      } else {
        setPreview({ url: "", name: entry.name, kind: "binary",
          siblings: sibs, index: idx });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Jump to a different sibling (called by ← / → in the image viewer or
   * by clicking a thumbnail). Looks up the next file's path, fetches it,
   * and replaces the preview state in place. Same blob-URL hygiene as
   * openPreview.
   */
  async function jumpToSibling(newIndex: number) {
    if (!preview) return;
    const sib = preview.siblings[newIndex];
    if (!sib) return;
    const remote = fullPath(cwd, sib.name);
    const kind = previewKind(sib.name);
    try {
      const stream = session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;
      if (kind === "image" || kind === "video" || kind === "audio") {
        if (sib.size > 500 * 1024 * 1024) {
          setError(`File too large to preview (${formatSize(sib.size)}).`); return;
        }
        const blob = await streamToBlob(stream);
        if (preview.url) URL.revokeObjectURL(preview.url);
        setPreview({
          url: URL.createObjectURL(blob),
          name: sib.name,
          kind,
          siblings: preview.siblings,
          index: newIndex,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function download(entry: Entry) {
    if (entry.type !== LinuxFileType.File) return;
    const remote = fullPath(cwd, entry.name);
    try {
      const stream = session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;
      const blob = await streamToBlob(stream);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function closePreview() {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  // ── Context menu actions ─────────────────────────────────────────────────

  const handleContextMenu = (e: React.MouseEvent, entry: Entry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      entry,
      isDir: entry.type === LinuxFileType.Directory,
      path: fullPath(cwd, entry.name),
      isPinned: pinned.includes(fullPath(cwd, entry.name)),
    });
  };

  const ctxOpen = (entry: Entry) => {
    if (entry.type === LinuxFileType.Directory) {
      void list(fullPath(cwd, entry.name));
    } else {
      void openPreview(entry);
    }
  };

  const ctxOpenTerminalHere = (path: string) => {
    onOpenShell?.(path);
  };

  const ctxPin = (path: string) => {
    if (!pinned.includes(path)) setPinned((prev) => [...prev, path]);
  };

  const ctxUnpin = (path: string) => {
    setPinned((prev) => prev.filter((p) => p !== path));
  };

  const ctxPreview = (entry: Entry) => {
    void openPreview(entry);
  };

  const ctxCopyName = (name: string) => {
    void navigator.clipboard.writeText(name);
  };

  const ctxCopyPath = (path: string) => {
    void navigator.clipboard.writeText(path);
  };

  // ── Upload ────────────────────────────────────────────────────────────────

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploading(true);
    setUploadStatus(`Reading ${f.name} (${formatSize(f.size)})…`);
    setError(null);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const safeName = f.name.replace(/[^A-Za-z0-9._-]/g, "_");
      const remotePath = fullPath(cwd, safeName);
      setUploadStatus(`Uploading to ${remotePath}…`);
      await session.adb.sync.write({
        filename: remotePath,
        file: new ReadableStream({
          start(c) { c.enqueue(buf); c.close(); },
        }) as unknown as Parameters<typeof session.adb.sync.write>[0]["file"],
      });
      setUploadStatus(`Uploaded → ${remotePath}`);
      await list(cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUploadStatus(null);
    } finally {
      setUploading(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const segments = pathSegments(cwd);
  const isPinned = pinned.includes(cwd);

  return (
    <div className="fm-two-col">
      {/* ── Left sidebar: pinned paths ───────────────────────────────── */}
      <aside className="fm-sidebar">
        <div className="fm-sidebar-head">
          <span className="fm-sidebar-title">📌 Pinned</span>
          <button
            className="fm-pin-btn"
            onClick={pinCurrent}
            title={isPinned ? "Unpin current path" : "Pin current path"}
            aria-label={isPinned ? "Unpin current path" : "Pin current path"}
          >
            {isPinned ? "★" : "☆"}
          </button>
        </div>

        <div className="fm-pin-list" role="list">
          {pinned.length === 0 && (
            <p className="fm-pin-empty">
              Click ☆ to pin a folder.
            </p>
          )}
          {pinned.map((p) => (
            <div key={p} className="fm-pin-item" role="listitem">
              <button
                className={`fm-pin-path${p === cwd ? " active" : ""}`}
                onClick={() => void list(p)}
                title={p}
              >
                📁
                <span className="fm-pin-label">
                  {p === "/" ? "/ (root)" : p.split("/").pop()}
                </span>
              </button>
              <button
                className="fm-pin-remove"
                onClick={() => unpin(p)}
                title="Remove pin"
                aria-label={`Remove pin ${p}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────────────── */}
      <main className="fm-main">
        <section className="panel" style={{ margin: 0, padding: "10px 14px" }}>
          {/* ── Toolbar ── */}
          <div className="fm-toolbar">
            <div className="fm-toolbar-nav">
              <button
                className="fm-icon-btn"
                onClick={() => void list(parentPath(cwd))}
                disabled={busy || cwd === "/"}
                title="Parent folder"
                aria-label="Go to parent folder"
              >▲</button>
              <button
                className="fm-icon-btn"
                onClick={() => void list(cwd)}
                disabled={busy}
                title="Refresh"
                aria-label="Refresh"
              >↺</button>
            </div>

            {/* Breadcrumb (double-click to edit path) */}
            <div
              className="fm-breadcrumb"
              role="navigation"
              aria-label="Path"
              onDoubleClick={() => setPathEditing(true)}
              title="Double-click to edit path"
            >
              {pathEditing ? (
                <input
                  ref={pathInputRef}
                  className="fm-breadcrumb-input"
                  defaultValue={cwd}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") {
                      const v = (ev.currentTarget.value || "").trim();
                      if (v) void list(v.startsWith("/") ? v : "/" + v);
                      setPathEditing(false);
                    } else if (ev.key === "Escape") {
                      setPathEditing(false);
                    }
                  }}
                  onBlur={() => setPathEditing(false)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label="Edit path"
                />
              ) : (
                segments.map((seg, i) => (
                  <span key={i} className="fm-breadcrumb-item">
                    {i > 0 && <span className="fm-breadcrumb-sep">/</span>}
                    <button
                      className="fm-breadcrumb-btn"
                      onClick={() => {
                        const target = seg === "/"
                          ? "/"
                          : "/" + segments.slice(1, i + 1).join("/");
                        void list(target);
                      }}
                      title={seg === "/" ? "Root" : seg}
                    >
                      {seg === "/" ? "📁" : seg}
                    </button>
                  </span>
                ))
              )}
            </div>

            {/* Right: upload + select-mode toggle */}
            <div className="fm-toolbar-right">
              <button
                className={`fm-icon-btn${selectMode ? " active" : ""}`}
                onClick={() => {
                  if (selectMode) exitSelectMode();
                  else setSelectMode(true);
                }}
                title={selectMode ? "Exit selection mode" : "Select multiple files"}
                aria-pressed={selectMode}
              >
                ✓
              </button>
              <label className="fm-upload-btn" title={uploading ? "Uploading…" : "Upload file here"}>
                {uploading ? <span className="fm-uploading-dot">⬤</span> : <span>⬆ Upload</span>}
                <input type="file" onChange={(e) => void onUpload(e)} disabled={uploading} style={{ display: "none" }} />
              </label>
            </div>
          </div>

          {/* ── Status banners ── */}
          {uploadStatus && <div className="banner info" style={{ margin: "8px 0 0" }}>{uploadStatus}</div>}
          {error && <div className="banner error" style={{ margin: "8px 0 0" }}>{error}</div>}

          {/* ── File list ── */}
          {entries !== null && (
            <div className="file-list" style={{ marginTop: 6 }}>
              {/* ── Selection action bar ── */}
              {selected.size > 0 && (
                <div className="fm-sel-bar">
                  <span className="fm-sel-count">{selected.size} selected</span>
                  <button className="fm-sel-btn" onClick={() => void navigator.clipboard.writeText([...selected].map((n) => `"${n}"`).join(" "))}>📋 Copy Names</button>
                  <button className="fm-sel-btn" onClick={() => void navigator.clipboard.writeText(selected.has("..") ? "" : [...selected].map((n) => fullPath(cwd, n)).join("\n"))}>🔗 Copy Paths</button>
                  <button className="fm-sel-btn danger" onClick={clearSelection}>✕ Clear</button>
                </div>
              )}

              <div className="row header">
                {/* 4px gutter when selectMode off; 28px checkbox when on */}
                <div style={{ width: selectMode ? 28 : 4, flexShrink: 0, transition: "width 0.15s" }} />
                <div>Name</div>
                <div>Size</div>
                <div>Mode</div>
              </div>
              {entries.length === 0 && (
                <div className="row">
                  <div style={{ width: selectMode ? 28 : 4, flexShrink: 0 }} />
                  <div className="row-name muted">(empty directory)</div><div></div><div></div>
                </div>
              )}
              {entries.map((e) => {
                const isSelected = selected.has(e.name);
                return (
                <div
                  key={e.name}
                  className={`row${isSelected ? " selected" : ""}${selectMode ? " sel-row" : " clickable"}`}
                  onClick={(evt) => {
                    if (selectMode) {
                      // Toggle selection on checkbox click area or row click
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(e.name)) next.delete(e.name);
                        else next.add(e.name);
                        return next;
                      });
                      setLastSelected(e.name);
                    } else {
                      // Normal mode: click = open/preview
                      clearSelection();
                      ctxOpen(e);
                    }
                  }}
                  onContextMenu={(ev) => {
                    if (!selectMode) {
                      // In normal mode, select the item before showing ctx menu
                      setSelected(new Set([e.name]));
                      setLastSelected(e.name);
                    }
                    handleContextMenu(ev, e);
                  }}
                  title={
                    e.type === LinuxFileType.Directory
                      ? "Click to open"
                      : "Click to preview"
                  }
                >
                  {/* 4px gutter when selectMode off; full checkbox when on */}
                  <div
                    style={{
                      width: selectMode ? 28 : 4,
                      flexShrink: 0,
                      transition: "width 0.15s",
                      overflow: "hidden",
                      cursor: selectMode ? "pointer" : "default",
                    }}
                  >
                    {selectMode && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${e.name}`}
                        checked={isSelected}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(e.name)) next.delete(e.name);
                            else next.add(e.name);
                            return next;
                          });
                          setLastSelected(e.name);
                        }}
                        onClick={(evt) => evt.stopPropagation()}
                      />
                    )}
                  </div>
                  <div className="row-name">
                    {e.type === LinuxFileType.Link ? "↪ " :
                     e.type === LinuxFileType.Directory ? "📁 " : "📄 "}
                    {e.name}
                  </div>
                  <div className="muted">
                    {e.type === LinuxFileType.Directory ? "—" : formatSize(e.size)}
                  </div>
                  <div className="muted">{formatMode(e.mode)}</div>
                </div>
              );})}
            </div>
          )}

          {entries === null && !error && !busy && (
            <div className="muted" style={{ padding: "12px 0" }}>
              Navigate to a folder to browse its contents.
            </div>
          )}
        </section>
      </main>

      {/* ── Context menu ──────────────────────────────────────────── */}
      {contextMenu && (
        <ContextMenuUI
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onOpen={() => ctxOpen(contextMenu.entry)}
          onPreview={() => ctxPreview(contextMenu.entry)}
          onOpenTerminalHere={() => ctxOpenTerminalHere(contextMenu.path)}
          onPin={() => ctxPin(contextMenu.path)}
          onUnpin={() => ctxUnpin(contextMenu.path)}
          onCopyName={() => ctxCopyName(contextMenu.entry.name)}
          onCopyPath={() => ctxCopyPath(contextMenu.path)}
          onDownload={() => void download(contextMenu.entry)}
        />
      )}

      {/* ── Preview modal ──────────────────────────────────────────── */}
      {preview && (
        <PreviewModal
          preview={preview}
          cwd={cwd}
          session={session}
          onClose={closePreview}
          onPrev={() => void jumpToSibling(Math.max(0, preview.index - 1))}
          onNext={() => void jumpToSibling(Math.min(preview.siblings.length - 1, preview.index + 1))}
          onJump={(i) => void jumpToSibling(i)}
          onDownload={() => void download({
            name: preview.name,
            type: LinuxFileType.File, mode: 0, size: 0, mtime: 0,
          } as Entry)}
        />
      )}
    </div>
  );
}

// ── PreviewModal ────────────────────────────────────────────────────────────
//
// Modal overlay that hosts the preview UI. For images it adds keyboard
// ←/→ navigation between siblings and a macOS-style thumbnail strip at
// the bottom. Each thumbnail is lazy-loaded on first paint and cached.

interface PreviewModalProps {
  preview: PreviewState;
  cwd: string;
  session: AdbSession;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  onDownload: () => void;
}

function PreviewModal({
  preview, cwd, session, onClose, onPrev, onNext, onJump, onDownload,
}: PreviewModalProps) {
  const isImage = preview.kind === "image";
  const hasSiblings = preview.siblings.length > 1;

  // Keyboard navigation for the image viewer.
  useEffect(() => {
    if (!isImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); onNext(); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isImage, onPrev, onNext, onClose]);

  return (
    <div
      className="preview-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="preview-modal">
        <div className="preview-header">
          <span className="preview-title">
            {preview.name}
            {hasSiblings && (
              <span className="preview-count"> ({preview.index + 1} / {preview.siblings.length})</span>
            )}
          </span>
          <div className="preview-actions">
            {isImage && hasSiblings && (
              <>
                <button
                  type="button"
                  className="preview-nav-btn"
                  onClick={onPrev}
                  disabled={preview.index <= 0}
                  title="Previous image (←)"
                  aria-label="Previous image"
                >‹</button>
                <button
                  type="button"
                  className="preview-nav-btn"
                  onClick={onNext}
                  disabled={preview.index >= preview.siblings.length - 1}
                  title="Next image (→)"
                  aria-label="Next image"
                >›</button>
              </>
            )}
            <button onClick={onDownload} className="primary">⬇ Download</button>
            <button onClick={onClose} aria-label="Close preview">✕</button>
          </div>
        </div>

        <div className="preview-body">
          {preview.kind === "text" && preview.content !== undefined && (
            <pre className="preview-text">
              {preview.content}
            </pre>
          )}
          {preview.kind === "image" && preview.url && (
            <img
              src={preview.url}
              alt={preview.name}
              className="preview-image"
              draggable={false}
            />
          )}
          {preview.kind === "video" && preview.url && (
            <video
              controls autoPlay src={preview.url}
              className="preview-video"
            >
              Your browser does not support this video format.
            </video>
          )}
          {preview.kind === "audio" && preview.url && (
            <div className="preview-audio">
              <div className="preview-audio-icon">🎵</div>
              <p className="preview-audio-name">{preview.name}</p>
              <audio controls autoPlay src={preview.url} style={{ width: "100%", maxWidth: 480 }}>
                Your browser does not support audio playback.
              </audio>
            </div>
          )}
          {preview.kind === "binary" && (
            <div className="preview-binary">
              <div className="preview-binary-icon">📄</div>
              <p>No preview available for this file type.</p>
              <button onClick={onDownload} className="primary">⬇ Download</button>
            </div>
          )}
        </div>

        {/* ── Thumbnail strip — only for image viewer ──────────────── */}
        {isImage && hasSiblings && (
          <ThumbnailStrip
            siblings={preview.siblings}
            cwd={cwd}
            session={session}
            currentIndex={preview.index}
            onJump={onJump}
          />
        )}
      </div>
    </div>
  );
}

// ── ThumbnailStrip ──────────────────────────────────────────────────────────

interface ThumbnailStripProps {
  siblings: Entry[];
  cwd: string;
  session: AdbSession;
  currentIndex: number;
  onJump: (index: number) => void;
}

function ThumbnailStrip({
  siblings, cwd, session, currentIndex, onJump,
}: ThumbnailStripProps) {
  // Lazy-load thumbnails: we fetch each sibling's blob on first viewport
  // intersection. The current image is fetched eagerly so the strip
  // doesn't pop in after navigation. Cached by entry.name.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Cancel flag so a later unmount doesn't set state from a stale fetch.
    let cancelled = false;
    const ensure = async (entry: Entry) => {
      if (thumbs[entry.name]) return;
      try {
        const remote = cwd.replace(/\/$/, "") + "/" + entry.name;
        const stream: ReadableStream<Uint8Array> =
          session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;
        const blob = await streamToBlob(stream);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setThumbs((prev) => ({ ...prev, [entry.name]: url }));
      } catch { /* ignore — failed thumb shows placeholder */ }
    };
    // Eagerly load the current item + its immediate neighbours so the
    // user sees thumbnails for adjacent images right away.
    const eager = new Set<number>([currentIndex]);
    if (currentIndex + 1 < siblings.length) eager.add(currentIndex + 1);
    if (currentIndex - 1 >= 0) eager.add(currentIndex - 1);
    for (const i of eager) void ensure(siblings[i]);

    // IntersectionObserver lazily loads the rest as the strip scrolls.
    const strip = stripRef.current;
    if (!strip || typeof IntersectionObserver === "undefined") return;
    const tiles = Array.from(strip.querySelectorAll<HTMLElement>("[data-thumb-idx]"));
    const io = new IntersectionObserver((entries) => {
      for (const obs of entries) {
        if (!obs.isIntersecting) continue;
        const target = obs.target as HTMLElement;
        const i = Number.parseInt(target.dataset.thumbIdx ?? "-1", 10);
        if (i >= 0) void ensure(siblings[i]);
      }
    }, { root: strip, rootMargin: "100px" });
    for (const t of tiles) io.observe(t);
    return () => {
      cancelled = true;
      io.disconnect();
    };
    // We intentionally depend on `cwd` + the index set so the strip
    // re-evaluates whenever the user navigates to a new directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, siblings, currentIndex]);

  // Revoke object URLs on unmount to avoid leaking thumbnails.
  useEffect(() => {
    return () => {
      for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
    };
  }, [thumbs]);

  return (
    <div className="preview-thumbs" ref={stripRef}>
      {siblings.map((s, i) => {
        const url = thumbs[s.name];
        const active = i === currentIndex;
        return (
          <button
            key={s.name}
            type="button"
            className={`preview-thumb${active ? " is-active" : ""}`}
            data-thumb-idx={i}
            onClick={() => onJump(i)}
            title={s.name}
          >
            {url
              ? <img src={url} alt="" draggable={false} />
              : <span className="preview-thumb-placeholder">{s.name[0]?.toUpperCase() ?? "?"}</span>
            }
          </button>
        );
      })}
    </div>
  );
}
