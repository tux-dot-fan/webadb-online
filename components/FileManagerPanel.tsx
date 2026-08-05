"use client";

import { useState, type ChangeEvent } from "react";
import type { AdbSession } from "@/lib/adb-client";
import { LinuxFileType } from "@yume-chan/adb";

interface Props {
  session: AdbSession;
}

interface Entry {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  type: LinuxFileType;
}

/** Entries that are safe to attempt as inline preview */
const PREVIEWABLE_TEXT = [
  ".txt", ".log", ".json", ".xml", ".html", ".htm",
  ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".c", ".cpp",
  ".h", ".hpp", ".py", ".sh", ".bash", ".zsh", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf", ".properties", ".md", ".rst",
  ".gradle", ".kt", ".java", ".smali", ".prop", ".rc", ".gitignore",
  ".env", ".csv", ".tsv", ".sql", ".go", ".rs", ".rb", ".php",
];
const PREVIEWABLE_IMAGE = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".avif",
];
const PREVIEWABLE_VIDEO = [
  ".mp4", ".mkv", ".webm", ".avi", ".mov", ".3gp", ".flv", ".wmv",
  ".m4v",
];

export function FileManagerPanel({ session }: Props) {
  const [cwd, setCwd] = useState("/sdcard");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{
    url: string;
    name: string;
    kind: "text" | "image" | "video" | "binary";
    content?: string;
  } | null>(null);

  async function list(path: string) {
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
  }

  async function previewFile(entry: Entry) {
    if (entry.type !== LinuxFileType.File) return;
    const remote = `${cwd === "/" ? "" : cwd}/${entry.name}`;
    const ext = entry.name
      .toLowerCase()
      .match(/\.[^.]+$/)?.[0] ?? "";

    try {
      const stream = session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;

      if (PREVIEWABLE_TEXT.includes(ext)) {
        // Text — read up to 512 KB inline
        if (entry.size > 512 * 1024) {
          setError(`Text file too large (${formatSize(entry.size)}). Download it to view.`);
          return;
        }
        const blob = await streamToBlob(stream);
        const text = await blob.text();
        setPreview({ url: "", name: entry.name, kind: "text", content: text });
      } else if (PREVIEWABLE_IMAGE.includes(ext)) {
        if (entry.size > 100 * 1024 * 1024) {
          setError(`Image too large (${formatSize(entry.size)}). Download it to view.`);
          return;
        }
        const blob = await streamToBlob(stream);
        const url = URL.createObjectURL(blob);
        setPreview({ url, name: entry.name, kind: "image" });
      } else if (PREVIEWABLE_VIDEO.includes(ext)) {
        if (entry.size > 500 * 1024 * 1024) {
          setError(`Video too large (${formatSize(entry.size)}). Download it to view.`);
          return;
        }
        const blob = await streamToBlob(stream);
        const url = URL.createObjectURL(blob);
        setPreview({ url, name: entry.name, kind: "video" });
      } else {
        // Binary / unknown — offer download
        setPreview({ url: "", name: entry.name, kind: "binary" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function download(entry: Entry) {
    if (entry.type !== LinuxFileType.File) return;
    const remote = `${cwd === "/" ? "" : cwd}/${entry.name}`;
    try {
      const stream = session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;
      const blob = await streamToBlob(stream);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function closePreview() {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  function parent(): string {
    if (cwd === "/") return "/";
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.join("/");
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploading(true);
    setUploadStatus(`Reading ${f.name} (${formatSize(f.size)})…`);
    setError(null);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const remoteName = f.name.replace(/[^A-Za-z0-9._-]/g, "_");
      const remotePath = `${cwd === "/" ? "" : cwd}/${remoteName}`;
      setUploadStatus(`Uploading to ${remotePath}…`);
      await session.adb.sync.write({
        filename: remotePath,
        file: new ReadableStream({
          start(controller) {
            controller.enqueue(buf);
            controller.close();
          },
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

  return (
    <section className="panel">
      <h2>File Manager</h2>
      <p className="panel-desc">
        Browse files and folders on your device. Click a file to preview
        (text, image, video), or double-click to download.
      </p>

      <div className="row" style={{ marginBottom: 10 }}>
        <input
          className="mono"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void list(cwd);
          }}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button onClick={() => void list(cwd)} disabled={busy} className="primary">
          {busy ? "Reading…" : "Go"}
        </button>
        {cwd !== "/" && (
          <button onClick={() => void list(parent())} disabled={busy}>
            Up
          </button>
        )}
        <button onClick={() => void list(cwd)} disabled={busy} title="Refresh">
          ⟳
        </button>
        <label
          style={{
            display: "inline-block",
            cursor: uploading ? "not-allowed" : "pointer",
            opacity: uploading ? 0.6 : 1,
            padding: "8px 14px",
            borderRadius: 6,
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border)",
            fontSize: 14,
          }}
        >
          {uploading ? "Uploading…" : "Upload"}
          <input
            type="file"
            onChange={(e) => void onUpload(e)}
            disabled={uploading}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {uploadStatus && (
        <div className="banner info" style={{ margin: "0 0 12px" }}>
          {uploadStatus}
        </div>
      )}

      {error && (
        <div className="banner error" style={{ margin: "0 0 12px" }}>
          {error}
        </div>
      )}

      {entries !== null && (
        <div className="file-list">
          <div className="row header">
            <div>Name</div>
            <div>Size</div>
            <div>Mode</div>
          </div>
          {entries.length === 0 && (
            <div className="row">
              <div className="muted">(empty directory)</div>
              <div></div>
              <div></div>
            </div>
          )}
          {entries.map((e) => (
            <div
              key={e.name}
              className={`row ${e.type === LinuxFileType.Directory ? "clickable" : "clickable"}`}
              onClick={() => {
                if (e.type === LinuxFileType.Directory) {
                  void list(`${cwd === "/" ? "" : cwd}/${e.name}`);
                } else {
                  void previewFile(e);
                }
              }}
              onDoubleClick={() => void download(e)}
              title={
                e.type === LinuxFileType.Directory
                  ? "Click to open"
                  : "Single-click to preview · Double-click to download"
              }
            >
              <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {e.type === LinuxFileType.Link
                  ? "↪ "
                  : e.type === LinuxFileType.Directory
                    ? "📁 "
                    : "📄 "}
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
          Press <span className="kbd">Go</span> or hit{" "}
          <span className="kbd">Enter</span> to list <code>{cwd}</code>.
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) void closePreview();
          }}
        >
          <div
            style={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              maxWidth: 900,
              width: "100%",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Modal header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                  color: "var(--text-dim)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {preview.name}
              </span>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                {preview.kind !== "text" && (
                  <button
                    onClick={() => void download({ name: preview.name, type: LinuxFileType.File, mode: 0, size: 0, mtime: 0 } as Entry)}
                    style={{ padding: "4px 12px", fontSize: 13 }}
                  >
                    Download
                  </button>
                )}
                <button
                  onClick={closePreview}
                  style={{ padding: "4px 10px", fontSize: 13 }}
                  aria-label="Close preview"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal body */}
            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: 16,
              }}
            >
              {preview.kind === "text" && preview.content !== undefined && (
                <pre
                  style={{
                    margin: 0,
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--text)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    maxHeight: "65vh",
                    overflow: "auto",
                    background: "var(--bg)",
                    padding: 12,
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                  }}
                >
                  {preview.content}
                </pre>
              )}
              {preview.kind === "image" && preview.url && (
                <img
                  src={preview.url}
                  alt={preview.name}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "65vh",
                    display: "block",
                    margin: "0 auto",
                    borderRadius: 6,
                    objectFit: "contain",
                  }}
                />
              )}
              {preview.kind === "video" && preview.url && (
                <video
                  controls
                  autoPlay
                  src={preview.url}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "65vh",
                    display: "block",
                    margin: "0 auto",
                    borderRadius: 6,
                  }}
                >
                  Your browser does not support this video format.
                </video>
              )}
              {preview.kind === "binary" && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "40px 20px",
                    color: "var(--text-dim)",
                  }}
                >
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
                  <p style={{ margin: "0 0 16px" }}>
                    No preview available for this file type.
                  </p>
                  <button
                    onClick={() =>
                      void download({
                        name: preview.name,
                        type: LinuxFileType.File,
                        mode: 0,
                        size: 0,
                        mtime: 0,
                      } as Entry)
                    }
                    className="primary"
                  >
                    Download
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
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

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMode(mode: number): string {
  const r = (mode >> 6) & 7;
  const w = (mode >> 3) & 7;
  const x = mode & 7;
  const t = (n: number) =>
    (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
  return t(r) + t(w) + t(x);
}
