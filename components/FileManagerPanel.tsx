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

function loadPins(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
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
}

function ContextMenuUI({
  menu,
  onClose,
  onOpen,
  onOpenTerminalHere,
  onCopyName,
  onCopyPath,
  onDownload,
}: {
  menu: ContextMenu;
  onClose: () => void;
  onOpen: () => void;
  onOpenTerminalHere: () => void;
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

  return (
    <div ref={ref} className="ctx-menu" style={style} role="menu">
      {item("Open", "📂", onOpen)}
      {menu.isDir && item("Open Terminal Here", "🐚", onOpenTerminalHere)}
      {item("Copy Name", "📋", onCopyName)}
      {item("Copy Path", "🔗", onCopyPath)}
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
  const [preview, setPreview] = useState<{
    url: string;
    name: string;
    kind: "text" | "image" | "video" | "audio" | "binary";
    content?: string;
  } | null>(null);
  const [pinned, setPinned] = useState<string[]>(loadPins);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries(null);
    } finally {
      setBusy(false);
    }
  }, [session]);

  // Initial load
  useEffect(() => { void list("/sdcard"); }, [list]);

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

  async function openPreview(entry: Entry) {
    if (entry.type !== LinuxFileType.File) return;
    const remote = fullPath(cwd, entry.name);
    const kind = previewKind(entry.name);

    try {
      const stream = session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;

      if (kind === "text") {
        if (entry.size > 512 * 1024) {
          setError(`Text file too large (${formatSize(entry.size)}). Download it to view.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: "", name: entry.name, kind: "text", content: await blob.text() });
      } else if (kind === "image") {
        if (entry.size > 100 * 1024 * 1024) {
          setError(`Image too large (${formatSize(entry.size)}). Download it to view.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: URL.createObjectURL(blob), name: entry.name, kind: "image" });
      } else if (kind === "video") {
        if (entry.size > 500 * 1024 * 1024) {
          setError(`Video too large (${formatSize(entry.size)}). Download it to view.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: URL.createObjectURL(blob), name: entry.name, kind: "video" });
      } else if (kind === "audio") {
        if (entry.size > 100 * 1024 * 1024) {
          setError(`Audio too large (${formatSize(entry.size)}). Download to listen.`); return;
        }
        const blob = await streamToBlob(stream);
        setPreview({ url: URL.createObjectURL(blob), name: entry.name, kind: "audio" });
      } else {
        setPreview({ url: "", name: entry.name, kind: "binary" });
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

            {/* Breadcrumb */}
            <div className="fm-breadcrumb" role="navigation" aria-label="Path">
              {segments.map((seg, i) => (
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
              ))}
            </div>

            {/* Right: upload */}
            <div className="fm-toolbar-right">
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
              <div className="row header">
                <div>Name</div>
                <div>Size</div>
                <div>Mode</div>
              </div>
              {entries.length === 0 && (
                <div className="row">
                  <div className="muted">(empty directory)</div><div></div><div></div>
                </div>
              )}
              {entries.map((e) => (
                <div
                  key={e.name}
                  className="row clickable"
                  onClick={() => ctxOpen(e)}
                  onContextMenu={(ev) => handleContextMenu(ev, e)}
                  title={
                    e.type === LinuxFileType.Directory
                      ? "Click to open · Right-click for more"
                      : "Single-click to preview · Right-click for more"
                  }
                >
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.type === LinuxFileType.Link ? "↪ " :
                     e.type === LinuxFileType.Directory ? "📁 " : "📄 "}
                    {e.name}
                  </div>
                  <div className="muted">
                    {e.type === LinuxFileType.Directory ? "—" : formatSize(e.size)}
                  </div>
                  <div className="muted">{formatMode(e.mode)}</div>
                </div>
              ))}
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
          onOpenTerminalHere={() => ctxOpenTerminalHere(contextMenu.path)}
          onCopyName={() => ctxCopyName(contextMenu.entry.name)}
          onCopyPath={() => ctxCopyPath(contextMenu.path)}
          onDownload={() => download(contextMenu.entry)}
        />
      )}

      {/* ── Preview modal ──────────────────────────────────────────── */}
      {preview && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) void closePreview(); }}
        >
          <div
            style={{
              background: "var(--bg-elev)", border: "1px solid var(--border)",
              borderRadius: 12, maxWidth: 900, width: "100%",
              maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden",
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0,
            }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-dim)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {preview.name}
              </span>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => void download({ name: preview.name, type: LinuxFileType.File, mode: 0, size: 0, mtime: 0 } as Entry)}
                  className="primary" style={{ padding: "4px 14px", fontSize: 13 }}
                >⬇ Download</button>
                <button onClick={closePreview} style={{ padding: "4px 10px", fontSize: 13 }}>✕</button>
              </div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
              {preview.kind === "text" && preview.content !== undefined && (
                <pre style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)",
                  whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "65vh",
                  overflow: "auto", background: "var(--bg)", padding: 12, borderRadius: 6,
                  border: "1px solid var(--border)" }}>
                  {preview.content}
                </pre>
              )}
              {preview.kind === "image" && preview.url && (
                <img src={preview.url} alt={preview.name} style={{ maxWidth: "100%", maxHeight: "65vh",
                  display: "block", margin: "0 auto", borderRadius: 6, objectFit: "contain" }} />
              )}
              {preview.kind === "video" && preview.url && (
                <video controls autoPlay src={preview.url} style={{ maxWidth: "100%", maxHeight: "65vh",
                  display: "block", margin: "0 auto", borderRadius: 6 }}>
                  Your browser does not support this video format.
                </video>
              )}
              {preview.kind === "audio" && preview.url && (
                <div style={{ textAlign: "center", padding: "24px 16px" }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>🎵</div>
                  <p style={{ color: "var(--text-dim)", margin: "0 0 16px", fontSize: 14 }}>{preview.name}</p>
                  <audio controls autoPlay src={preview.url} style={{ width: "100%", maxWidth: 480 }}>
                    Your browser does not support audio playback.
                  </audio>
                </div>
              )}
              {preview.kind === "binary" && (
                <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-dim)" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
                  <p style={{ margin: "0 0 16px" }}>No preview available for this file type.</p>
                  <button onClick={() => void download({ name: preview.name, type: LinuxFileType.File, mode: 0, size: 0, mtime: 0 } as Entry)} className="primary">⬇ Download</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
