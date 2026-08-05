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

export function FileManagerPanel({ session }: Props) {
  const [cwd, setCwd] = useState("/sdcard");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

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

  async function download(entry: Entry) {
    if (entry.type !== LinuxFileType.File) return;
    const remote = `${cwd}/${entry.name}`;
    try {
      // `session.adb.sync.read` returns a stream-extra ReadableStream, not a
      // standard DOM one — the runtime contract is the same, but the types
      // differ in subtle ways (e.g. `pipeThrough` overloads). Cast for the
      // type system, the runtime API matches what we use below.
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

  function parent(): string {
    if (cwd === "/") return "/";
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.join("/");
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
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
      // Refresh the listing.
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
      <h2>Files</h2>
      <p className="panel-desc">
        Browse and download files. Read-only for now — safe to explore without
        risk to your device.
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
              className={`row ${e.type === LinuxFileType.Directory ? "clickable" : ""}`}
              onClick={() => {
                if (e.type === LinuxFileType.Directory) {
                  void list(`${cwd === "/" ? "" : cwd}/${e.name}`);
                }
              }}
              onDoubleClick={() => void download(e)}
              title={e.type === LinuxFileType.Directory ? "Click to open" : "Double-click to download"}
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
          Press <span className="kbd">Go</span> or hit <span className="kbd">Enter</span>{" "}
          to list <code>{cwd}</code>.
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