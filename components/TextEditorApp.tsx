"use client";

// ── TextEditorApp ───────────────────────────────────────────────────────────
//
// Two-pane text editor. Supports two file sources:
//
//   • Device  — files on the connected Android (read via `adb sync.read`,
//               write via `adb sync.write`). Browse a configurable root
//               (default `/sdcard/Documents`) using `adb sync.readdir`.
//
//   • Local   — files persisted in `localStorage` under a single namespaced
//               key (`webadb.editor.localFiles`). Each file is `{name, content,
//               updatedAt}`. Useful for drafts / scratch files without
//               touching the device.
//
// The editor itself is a plain `<textarea>` paired with a line-number
// gutter (rendered via a synchronized `<pre>` overlaid on the textarea).
// No syntax highlighting — this is intentionally minimal to keep the
// bundle small.

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import type { AdbSession } from "@/lib/adb-client";
import { LinuxFileType } from "@yume-chan/adb";

interface Props {
  session: AdbSession;
}

// ── Source switching ────────────────────────────────────────────────────────

type Source = "device" | "local";

const DEFAULT_DEVICE_ROOT = "/sdcard/Documents";
const LOCAL_KEY = "webadb.editor.localFiles";

interface LocalFile {
  name: string;
  content: string;
  updatedAt: number;
}

interface DeviceEntry {
  name: string;
  type: LinuxFileType;
  size: number;
  mtime: number;
}

interface OpenFile {
  /** Where the file lives: "device" or "local". */
  source: Source;
  /** File name, or full device path. */
  name: string;
  /** For device files: absolute path used for read/write. */
  devicePath?: string;
  /** Current content in the editor. */
  content: string;
  /** Saved-on-disk content (for dirty detection). */
  savedContent: string;
  /** Last-saved timestamp (ms since epoch). */
  updatedAt: number;
}

// ── Local-storage helpers ───────────────────────────────────────────────────

function loadLocalFiles(): LocalFile[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as LocalFile[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveLocalFiles(files: LocalFile[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(files));
  } catch { /* quota exceeded — ignore */ }
}

// ── Stream → blob → text helper ─────────────────────────────────────────────

async function streamToBlob(stream: ReadableStream<Uint8Array>): Promise<Blob> {
  const parts: BlobPart[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parts.push(value as BlobPart);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(parts);
}

// ── Main component ──────────────────────────────────────────────────────────

export function TextEditorApp({ session }: Props): React.JSX.Element {
  const [source, setSource] = useState<Source>("local");

  // ── Local files state ──────────────────────────────────────────────────
  const [localFiles, setLocalFiles] = useState<LocalFile[]>(() => loadLocalFiles());

  const upsertLocal = useCallback((name: string, content: string) => {
    setLocalFiles((prev) => {
      const next = [...prev];
      const i = next.findIndex((f) => f.name === name);
      const entry: LocalFile = { name, content, updatedAt: Date.now() };
      if (i >= 0) next[i] = entry;
      else next.push(entry);
      next.sort((a, b) => a.name.localeCompare(b.name));
      saveLocalFiles(next);
      return next;
    });
  }, []);

  const deleteLocal = useCallback((name: string) => {
    setLocalFiles((prev) => {
      const next = prev.filter((f) => f.name !== name);
      saveLocalFiles(next);
      return next;
    });
  }, []);

  // ── Device files state ─────────────────────────────────────────────────
  const [deviceRoot, setDeviceRoot] = useState(DEFAULT_DEVICE_ROOT);
  const [devicePathInput, setDevicePathInput] = useState(deviceRoot);
  const [deviceFiles, setDeviceFiles] = useState<DeviceEntry[] | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // ── Currently open file ────────────────────────────────────────────────
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = open !== null && open.content !== open.savedContent;

  // ── Device readdir ─────────────────────────────────────────────────────
  const refreshDevice = useCallback(async (path: string) => {
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const raw = await session.adb.sync.readdir(path);
      const out: DeviceEntry[] = raw.map((e) => ({
        name: e.name,
        type: e.type,
        size: Number(e.size),
        mtime: Number(e.mtime),
      })).filter((e) => e.type === LinuxFileType.File);
      out.sort((a, b) => a.name.localeCompare(b.name));
      setDeviceFiles(out);
    } catch (e) {
      setDeviceError(e instanceof Error ? e.message : String(e));
      setDeviceFiles(null);
    } finally {
      setDeviceBusy(false);
    }
  }, [session]);

  // Read device root on mount (and when source switches to device).
  useEffect(() => {
    if (source === "device") void refreshDevice(deviceRoot);
  }, [source, deviceRoot, refreshDevice]);

  // ── Open a file ────────────────────────────────────────────────────────
  const openLocal = useCallback(async (file: LocalFile) => {
    setError(null);
    setOpen({
      source: "local",
      name: file.name,
      content: file.content,
      savedContent: file.content,
      updatedAt: file.updatedAt,
    });
    setStatus(`Opened ${file.name} (local)`);
  }, []);

  const openDevice = useCallback(async (entry: DeviceEntry) => {
    if (entry.type !== LinuxFileType.File) return;
    setError(null);
    const remote = deviceRoot.replace(/\/$/, "") + "/" + entry.name;
    try {
      const stream: ReadableStream<Uint8Array> =
        session.adb.sync.read(remote) as unknown as ReadableStream<Uint8Array>;
      const blob = await streamToBlob(stream);
      const content = await blob.text();
      setOpen({
        source: "device",
        name: entry.name,
        devicePath: remote,
        content,
        savedContent: content,
        updatedAt: Date.now(),
      });
      setStatus(`Opened ${entry.name} (device)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, deviceRoot]);

  const closeFile = useCallback(() => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    setOpen(null);
    setStatus(null);
  }, [dirty]);

  // ── Editor change ──────────────────────────────────────────────────────
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onEdit = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setOpen((prev) => prev ? { ...prev, content: e.target.value } : prev);
  }, []);

  // Tab key inserts 2 spaces instead of moving focus.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd, value } = ta;
    const insert = "  ";
    const newValue = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
    setOpen((prev) => prev ? { ...prev, content: newValue } : prev);
    // Restore caret position after React re-render.
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = selectionStart + insert.length;
    });
  }, []);

  // ── Save handlers ──────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!open) return;
    if (open.source === "local") {
      upsertLocal(open.name, open.content);
      setOpen((prev) => prev ? { ...prev, savedContent: prev.content, updatedAt: Date.now() } : prev);
      setStatus(`Saved ${open.name}`);
      return;
    }
    // device source
    if (!open.devicePath) return;
    try {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(open.content);
      const stream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(bytes); c.close(); },
      });
      await session.adb.sync.write({
        filename: open.devicePath,
        file: stream as unknown as Parameters<typeof session.adb.sync.write>[0]["file"],
      });
      setOpen((prev) => prev ? { ...prev, savedContent: prev.content, updatedAt: Date.now() } : prev);
      setStatus(`Saved to ${open.devicePath}`);
      // Refresh listing so timestamps/sizes update.
      void refreshDevice(deviceRoot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [open, session, refreshDevice, deviceRoot, upsertLocal]);

  const saveAs = useCallback(() => {
    if (!open) return;
    const suggested = open.name.includes(".")
      ? open.name.replace(/(\.[^.]+)?$/, "-copy$1")
      : `${open.name}-copy`;
    const name = prompt("Save as (filename):", suggested);
    if (!name) return;
    if (open.source !== "local" && localFiles.some((f) => f.name === name)) {
      if (!confirm(`${name} already exists in local files. Overwrite?`)) return;
    }
    upsertLocal(name, open.content);
    setStatus(`Saved as ${name} (local)`);
    // Switch focus to the new local file.
    setOpen({
      source: "local",
      name,
      content: open.content,
      savedContent: open.content,
      updatedAt: Date.now(),
    });
    setSource("local");
  }, [open, upsertLocal, localFiles]);

  const newLocal = useCallback(() => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    const name = prompt("New file name:", "untitled.txt");
    if (!name) return;
    const empty = "";
    upsertLocal(name, empty);
    setOpen({
      source: "local",
      name,
      content: empty,
      savedContent: empty,
      updatedAt: Date.now(),
    });
    setSource("local");
    setStatus(`Created ${name}`);
  }, [dirty, upsertLocal]);

  const deleteOpenLocal = useCallback(() => {
    if (!open || open.source !== "local") return;
    if (!confirm(`Delete ${open.name} from local files?`)) return;
    deleteLocal(open.name);
    setOpen(null);
    setStatus(`Deleted ${open.name}`);
  }, [open, deleteLocal]);

  // ── Line numbers ───────────────────────────────────────────────────────
  const lineCount = useMemo(
    () => Math.max(1, (open?.content ?? "").split("\n").length),
    [open?.content],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="editor">
      {/* ── Toolbar ────────────────────────────────────────────────── */}
      <header className="editor-toolbar">
        <div className="editor-source-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={source === "local"}
            className={`editor-tab${source === "local" ? " is-active" : ""}`}
            onClick={() => setSource("local")}
          >
            💾 Local
            {localFiles.length > 0 && <span className="editor-tab-count"> ({localFiles.length})</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === "device"}
            className={`editor-tab${source === "device" ? " is-active" : ""}`}
            onClick={() => setSource("device")}
          >
            📱 Device
          </button>
        </div>

        <div className="editor-actions">
          <button type="button" onClick={newLocal} title="Create new local file">
            ＋ New
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!open || !dirty}
            title={dirty ? "Save changes" : "Nothing to save"}
          >
            💾 Save
          </button>
          <button
            type="button"
            onClick={saveAs}
            disabled={!open}
            title="Save as a new local file"
          >
            📋 Save As
          </button>
          <button
            type="button"
            onClick={deleteOpenLocal}
            disabled={!open || open.source !== "local"}
            title="Delete this local file"
          >
            🗑 Delete
          </button>
          <button
            type="button"
            onClick={closeFile}
            disabled={!open}
            title="Close the current file"
          >
            ✕ Close
          </button>
        </div>
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

      {/* ── Body: file list + editor ─────────────────────────────── */}
      <div className="editor-body">
        <aside className="editor-sidebar">
          {source === "local" ? (
            <LocalList files={localFiles} open={open} onOpen={openLocal} onDelete={deleteLocal} />
          ) : (
            <DeviceList
              root={deviceRoot}
              pathInput={devicePathInput}
              setPathInput={setDevicePathInput}
              files={deviceFiles}
              busy={deviceBusy}
              error={deviceError}
              open={open}
              onCommitPath={(p) => { setDeviceRoot(p); setDevicePathInput(p); }}
              onOpen={openDevice}
              onRefresh={() => void refreshDevice(deviceRoot)}
            />
          )}
        </aside>

        <main className="editor-main">
          {open ? (
            <div className="editor-main-inner">
              <header className="editor-main-header">
                <span className="editor-main-name">
                  {open.source === "local" ? "💾 " : "📱 "}
                  {open.name}
                  {dirty && <span className="editor-dirty-dot" title="Unsaved changes"> ●</span>}
                </span>
                <span className="editor-main-meta">
                  {open.source === "device" && open.devicePath}
                  {" · "}
                  {lineCount} line{lineCount === 1 ? "" : "s"}
                  {" · "}
                  {open.content.length} chars
                  {" · "}
                  {open.content !== open.savedContent ? "modified" : "saved"}
                </span>
              </header>
              <div className="editor-text-wrap">
                <pre className="editor-gutter" aria-hidden>
                  {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                </pre>
                <textarea
                  ref={textareaRef}
                  className="editor-textarea"
                  value={open.content}
                  onChange={onEdit}
                  onKeyDown={onKeyDown}
                  spellCheck={false}
                  wrap="off"
                />
              </div>
            </div>
          ) : (
            <div className="editor-empty">
              <div className="editor-empty-icon">📝</div>
              <p>
                {source === "local"
                  ? "Pick a local file on the left, or click ＋ New to create one."
                  : "Pick a device file on the left to open it."}
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ── LocalList ───────────────────────────────────────────────────────────────

function LocalList({
  files, open, onOpen, onDelete,
}: {
  files: LocalFile[];
  open: OpenFile | null;
  onOpen: (f: LocalFile) => void;
  onDelete: (name: string) => void;
}) {
  if (files.length === 0) {
    return (
      <div className="editor-list-empty">
        No local files yet. Click <strong>＋ New</strong> to create one.
      </div>
    );
  }
  return (
    <ul className="editor-list">
      {files.map((f) => (
        <li
          key={f.name}
          className={`editor-list-row${open?.name === f.name && open.source === "local" ? " is-selected" : ""}`}
        >
          <button
            type="button"
            className="editor-list-row-btn"
            onClick={() => onOpen(f)}
            title={`Last saved ${new Date(f.updatedAt).toLocaleString()}`}
          >
            <span className="editor-list-name">📝 {f.name}</span>
            <span className="editor-list-meta">{f.content.length} chars</span>
          </button>
          <button
            type="button"
            className="editor-list-row-del"
            onClick={() => {
              if (confirm(`Delete ${f.name}?`)) onDelete(f.name);
            }}
            aria-label={`Delete ${f.name}`}
            title="Delete"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── DeviceList ──────────────────────────────────────────────────────────────

function DeviceList({
  root, pathInput, setPathInput, files, busy, error, open, onCommitPath, onOpen, onRefresh,
}: {
  root: string;
  pathInput: string;
  setPathInput: (v: string) => void;
  files: DeviceEntry[] | null;
  busy: boolean;
  error: string | null;
  open: OpenFile | null;
  onCommitPath: (p: string) => void;
  onOpen: (e: DeviceEntry) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="editor-device-toolbar">
        <input
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitPath(pathInput);
          }}
          spellCheck={false}
          title="Device directory"
        />
        <button
          type="button"
          onClick={() => onCommitPath(pathInput)}
          disabled={pathInput === root}
          title="Open this directory"
        >
          Go
        </button>
        <button type="button" onClick={onRefresh} disabled={busy} title="Refresh listing">
          {busy ? "…" : "↻"}
        </button>
      </div>

      {error && <div className="banner error" style={{ margin: "0 0 8px" }}>{error}</div>}

      {files === null && !error && (
        <div className="editor-list-empty">Listing…</div>
      )}
      {files && files.length === 0 && (
        <div className="editor-list-empty">No files in {root}.</div>
      )}
      {files && files.length > 0 && (
        <ul className="editor-list">
          {files.map((f) => (
            <li
              key={f.name}
              className={`editor-list-row${open?.name === f.name && open.source === "device" ? " is-selected" : ""}`}
            >
              <button
                type="button"
                className="editor-list-row-btn"
                onClick={() => onOpen(f)}
                title={`${f.size} bytes · modified ${new Date(f.mtime * 1000).toLocaleString()}`}
              >
                <span className="editor-list-name">📄 {f.name}</span>
                <span className="editor-list-meta">{f.size} B</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}