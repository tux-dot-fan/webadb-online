"use client";

/**
 * Interactive shell panel — a full xterm.js terminal wired up to an ADB
 * PTY session, plus a left-hand sidebar that exposes three "toolboxes":
 *
 *   1. Commands  — pre-baked shell one-liners the user clicks to inject
 *                  into the current PTY (e.g. `pm list packages -3`,
 *                  `dumpsys battery`, etc). Doesn't touch the device
 *                  filesystem; the bytes go straight through xterm.
 *
 *   2. Scripts   — user-uploaded .sh files. Stored on the device under
 *                  `/data/local/tmp/webadb/scripts/` so the +x bit
 *                  survives a chmod (no F2FS emulation weirdness like
 *                  on /sdcard). Right-click → run / rename / copy path
 *                  / download / delete / info.
 *
 *   3. Binaries  — arbitrary executables. Same UI as Scripts but stored
 *                  under `/data/local/tmp/webadb/bin/` and chmod +x'd
 *                  on upload. Convenient for testing a quick tool on a
 *                  device without copying it through the File Manager.
 *
 * The sidebar collapses so the terminal can fill the window when the
 * user just wants a plain shell.
 *
 * The panel exposes `runCommand(cmd)` and `focus()` via
 * `useImperativeHandle` — Workspace uses them when other apps request
 * "open Terminal Here" (e.g. File Manager → "Open shell in this dir").
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle,
  useRef, useState,
} from "react";
import type { AdbSession } from "@/lib/adb-client";
import { getAdbClient, type AdbClient } from "@/lib/adb-client";
import { LinuxFileType } from "@yume-chan/adb";

// ── Public ref contract ────────────────────────────────────────────────────

export interface ShellPanelHandle {
  /** Write `cmd` to the current PTY followed by `\n`. No-op if not ready. */
  runCommand(cmd: string): void;
  /** Move keyboard focus to the terminal canvas. */
  focus(): void;
}

interface Props {
  session: AdbSession;
  /** Shell command to run immediately after the PTY starts (e.g. "cd /sdcard"). */
  initialCommand?: string;
}

// ── xterm handle (kept opaque to the rest of the file) ─────────────────────

interface TermHandle {
  term: import("@xterm/xterm").Terminal;
  fit: import("@xterm/addon-fit").FitAddon;
  pty: {
    kill(): void;
    resize(r: number, c: number): Promise<void>;
  };
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  cleanup: () => void;
}

// ── Sidebar state ──────────────────────────────────────────────────────────
//
// We keep all sidebar state as localStorage-backed settings (so the user's
// custom command list survives a refresh) but the file lists themselves
// are fetched live from the device each time the sidebar mounts.

interface SavedCommand {
  /** Stable id so we can reorder/delete without breaking keys. */
  id: string;
  label: string;
  command: string;
}

const SAVED_COMMANDS_KEY = "webadb.shell.savedCommands";

/**
 * Built-in command palette. Editable: the user can add/remove via the
 * "+" / "✕" buttons in the sidebar, and changes persist to localStorage.
 *
 * Kept short on purpose — these are meant as one-click shortcuts, not a
 * replacement for typing into the PTY.
 */
const DEFAULT_COMMANDS: SavedCommand[] = [
  { id: "c-pm-list",    label: "3rd-party packages",  command: "pm list packages -3" },
  { id: "c-pm-system",  label: "System packages",      command: "pm list packages -s | head -n 30" },
  { id: "c-df",         label: "Disk free",            command: "df -h /data /system" },
  { id: "c-free",       label: "Memory",               command: "free -h" },
  { id: "c-uptime",     label: "Uptime",               command: "uptime" },
  { id: "c-battery",    label: "Battery",              command: "dumpsys battery | head -n 30" },
  { id: "c-wm",         label: "Window state",         command: "dumpsys window | head -n 40" },
  { id: "c-top",        label: "Top (3 ticks)",        command: "top -b -n 3 -d 1 | tail -n 20" },
  { id: "c-env",        label: "Env (PATH)",           command: "echo \"PATH=$PATH\"" },
  { id: "c-getprop",    label: "Device props",         command: "getprop ro.product.model ro.build.version.release ro.product.cpu.abi" },
];

const SCRIPTS_DIR = "/data/local/tmp/webadb/scripts";
const BIN_DIR     = "/data/local/tmp/webadb/bin";

type Kind = "script" | "binary";

interface SidebarEntry {
  name: string;
  /** Absolute path on the device. */
  path: string;
  size: number;
  mtimeMs: number;
}

// ── Sidebar helpers ────────────────────────────────────────────────────────

function loadSavedCommands(): SavedCommand[] {
  try {
    const raw = localStorage.getItem(SAVED_COMMANDS_KEY);
    if (!raw) return DEFAULT_COMMANDS;
    const arr = JSON.parse(raw) as SavedCommand[];
    if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_COMMANDS;
    return arr;
  } catch {
    return DEFAULT_COMMANDS;
  }
}

function saveSavedCommands(list: SavedCommand[]): void {
  try {
    localStorage.setItem(SAVED_COMMANDS_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

/** Sanitize a user-provided filename for the scripts/ or bin/ dir. */
function sanitizeName(name: string, kind: Kind): string {
  const trimmed = name.trim().replace(/^\/+/, "");
  // Strip path separators entirely — we only allow a basename in our dirs.
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  // Allow only a conservative charset; collapse anything else to '_'.
  let cleaned = base.replace(/[^A-Za-z0-9._+-]/g, "_");
  if (!cleaned) cleaned = kind === "script" ? "script.sh" : "binary";
  if (kind === "script" && !/\.(sh|bash)$/i.test(cleaned)) cleaned += ".sh";
  return cleaned;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Main panel ─────────────────────────────────────────────────────────────

export const ShellPanel = forwardRef<ShellPanelHandle, Props>(
  function ShellPanel({ session, initialCommand }, ref) {
    return (
      <PanelInner
        ref={ref}
        session={session}
        initialCommand={initialCommand}
      />
    );
  },
);

// Implementation detail: split out so we can keep `forwardRef`'s signature
// without polluting the render with extra wrappers.
const PanelInner = forwardRef<ShellPanelHandle, Props>(
  function PanelInner({ session, initialCommand }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<TermHandle | null>(null);
    const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
    const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);

    // Bumping this key on the container <div> forces React to unmount +
    // remount, which in turn re-runs our setup effect and re-opens a
    // fresh PTY. Used by the Restart button and by device-switch.
    const [remountKey, setRemountKey] = useState(0);
    const [status, setStatus] = useState<"starting" | "running" | "stopped">("starting");
    const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
      if (typeof window === "undefined") return true;
      return localStorage.getItem("webadb.shell.sidebarOpen") !== "0";
    });

    useEffect(() => {
      try {
        localStorage.setItem("webadb.shell.sidebarOpen", sidebarOpen ? "1" : "0");
      } catch { /* ignore */ }
    }, [sidebarOpen]);

    const serial = session.adb.serial;

    // ── Imperative handle ────────────────────────────────────────────────
    //
    // `runCommand` is used by the sidebar's "Commands" section and by
    // File Manager's "Open Terminal Here" path. We tolerate being called
    // before the PTY is up — the command is dropped on the floor in that
    // case rather than queued (the PTY starts with `sh -i` so any prior
    // queued input would be processed in the wrong order anyway).
    //
    // `focus` puts the keyboard cursor inside the xterm canvas so the
    // user can immediately type — useful after clicking a sidebar entry.

    useImperativeHandle(ref, () => ({
      runCommand(cmd: string) {
        const writer = writerRef.current;
        if (!writer) return;
        // \r\n ensures the device's line discipline sees a real newline
        // even when the PTY was last in raw mode (Ctrl-C etc).
        writer.write(new TextEncoder().encode(cmd + "\r\n")).catch(() => {});
      },
      focus() {
        const term = termRef.current;
        if (!term) return;
        term.focus();
      },
    }), []);

    useEffect(() => {
      if (!containerRef.current) return;
      let cancelled = false;
      let handle: TermHandle | null = null;

      async function setup() {
        // Dynamic imports — xterm.js and addon-fit both touch `window` at
        // import time, so a static import would break SSR. The bundler
        // puts them in their own chunk, fetched on first panel mount.
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);

        // Terminal palette adapts to the page theme so text is always legible.
        function getPageTheme(): "light" | "dark" {
          return (document.documentElement.getAttribute("data-theme") as "light" | "dark") ?? "light";
        }

        const LIGHT_THEME = {
          background: "#ffffff", foreground: "#1c2433", cursor: "#1c2433",
          selectionBackground: "rgba(37, 99, 235, 0.2)",
          black: "#1c2433", red: "#dc2626", green: "#15803d", yellow: "#b45309",
          blue: "#2563eb", magenta: "#7c3aed", cyan: "#0891b2", white: "#e6ebf5",
          brightBlack: "#5a657a", brightRed: "#ef4444", brightGreen: "#22c55e",
          brightYellow: "#f59e0b", brightBlue: "#3b82f6", brightMagenta: "#8b5cf6",
          brightCyan: "#06b6d4", brightWhite: "#ffffff",
        };
        const DARK_THEME = {
          background: "#0d1117", foreground: "#e6edf3", cursor: "#e6edf3",
          selectionBackground: "rgba(78, 161, 255, 0.25)",
          black: "#0d1117", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
          blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#e6edf3",
          brightBlack: "#484f58", brightRed: "#ffa198", brightGreen: "#56d364",
          brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
          brightCyan: "#56d4dd", brightWhite: "#ffffff",
        };

        const term = new Terminal({
          fontSize: 14,
          fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
          fontWeight: "400",
          fontWeightBold: "700",
          cursorBlink: true,
          cursorStyle: "block",
          theme: getPageTheme() === "dark" ? DARK_THEME : LIGHT_THEME,
          scrollback: 10_000,
          allowTransparency: false,
          convertEol: true,
        });

        const containerBg = getPageTheme() === "dark" ? "#0d1117" : "#ffffff";
        containerRef.current!.style.background = containerBg;

        const themeObserver = new MutationObserver(() => {
          const next = getPageTheme() === "dark" ? DARK_THEME : LIGHT_THEME;
          term.options.theme = next;
          if (containerRef.current) {
            containerRef.current.style.background =
              getPageTheme() === "dark" ? "#0d1117" : "#ffffff";
          }
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current!);
        fit.fit();
        termRef.current = term;

        let pty: Awaited<ReturnType<AdbClient["startShellPty"]>>;
        try {
          pty = await getAdbClient().startShellPty(["sh", "-i"]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          term.writeln(`\r\n\x1b[31mfailed to start shell: ${msg}\x1b[0m`);
          setStatus("stopped");
          return;
        }

        if (cancelled) {
          pty.kill();
          return;
        }

        // Device → terminal pump.
        const reader = pty.output.getReader();
        const pump = (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) term.write(value);
            }
          } catch {
            // Stream errored (typically because the device disconnected).
          }
        })();

        // Terminal → device pump. Reuse one writer across all onData
        // events (creating a fresh writer per keystroke would add latency).
        const writer = pty.input.getWriter();
        writerRef.current = writer;

        if (initialCommand) {
          setTimeout(() => {
            const cmd = initialCommand + "\n";
            writer.write(new TextEncoder().encode(cmd)).catch(() => {});
          }, 120);
        }
        const dataDisp = term.onData((data) => {
          writer.write(new TextEncoder().encode(data)).catch(() => {});
        });

        const ro = new ResizeObserver(() => {
          try {
            fit.fit();
            pty.resize(term.rows, term.cols).catch(() => {});
          } catch {
            // term disposed mid-resize — safe to ignore.
          }
        });
        ro.observe(containerRef.current!);

        const cleanup = () => {
          ro.disconnect();
          themeObserver.disconnect();
          dataDisp.dispose();
          try { pty.kill(); } catch { /* already dead */ }
          writer.releaseLock();
          reader.cancel().catch(() => {});
          term.dispose();
          termRef.current = null;
          writerRef.current = null;
        };
        handle = { term, fit, pty, writer, reader, cleanup };
        handleRef.current = handle;
        setStatus("running");

        pump.finally(() => {
          if (!cancelled) {
            term.writeln("\r\n\x1b[31m[connection closed]\x1b[0m");
            setStatus("stopped");
          }
        });
      }

      void setup();
      return () => {
        cancelled = true;
        handle?.cleanup();
        handleRef.current = null;
      };
    }, [serial, remountKey]);

    return (
      <section className="panel shell-panel">
        {/*
          We intentionally do NOT render the previous shell-panel-head
          (StatusBadge + « Hide / » Sidebar toggle). The connection
          status is now surfaced in the global topbar / Settings →
          Device, and the sidebar can be toggled from the dock's
          context menu or via the file manager's "Terminal here"
          action. Removing this row gives the panel a cleaner
          macOS-style top edge — window content flows directly from
          the titlebar down.
        */}
        <div className={`shell-panel-body${sidebarOpen ? "" : " sidebar-closed"}`}>
          {sidebarOpen && (
            <TerminalSidebar
              session={session}
              onRunCommand={(cmd) => {
                const w = writerRef.current;
                if (!w) return;
                w.write(new TextEncoder().encode(cmd + "\r\n")).catch(() => {});
                termRef.current?.focus();
              }}
            />
          )}
          <div
            key={remountKey}
            ref={containerRef}
            className="xterm-container panel-fill"
          />
        </div>
      </section>
    );
  },
);

// ── Sidebar ────────────────────────────────────────────────────────────────

interface SidebarProps {
  session: AdbSession;
  onRunCommand(cmd: string): void;
}

function TerminalSidebar({ session, onRunCommand }: SidebarProps) {
  const [tab, setTab] = useState<Kind | "commands">("commands");
  const adb = getAdbClient();

  return (
    <aside className="shell-sidebar">
      <nav className="shell-sidebar-tabs" role="tablist">
        <TabBtn active={tab === "commands"} onClick={() => setTab("commands")}>⚡ Commands</TabBtn>
        <TabBtn active={tab === "script"}  onClick={() => setTab("script")}>📜 Scripts</TabBtn>
        <TabBtn active={tab === "binary"}  onClick={() => setTab("binary")}>⚙ Binaries</TabBtn>
      </nav>
      <div className="shell-sidebar-body">
        {tab === "commands" && <CommandsTab onRunCommand={onRunCommand} />}
        {tab === "script" && <FilesTab session={session} adb={adb} kind="script" onRunCommand={onRunCommand} />}
        {tab === "binary" && <FilesTab session={session} adb={adb} kind="binary" onRunCommand={onRunCommand} />}
      </div>
    </aside>
  );
}

function TabBtn(
  { active, onClick, children }:
  { active: boolean; onClick: () => void; children: React.ReactNode },
) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`shell-sidebar-tab${active ? " active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ── Commands tab ───────────────────────────────────────────────────────────

function CommandsTab({ onRunCommand }: { onRunCommand: (cmd: string) => void }) {
  const [list, setList] = useState<SavedCommand[]>(() => loadSavedCommands());
  const [adding, setAdding] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftCmd, setDraftCmd] = useState("");

  function persist(next: SavedCommand[]) {
    setList(next);
    saveSavedCommands(next);
  }

  function add() {
    const label = draftLabel.trim();
    const command = draftCmd.trim();
    if (!label || !command) return;
    const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    persist([...list, { id, label, command }]);
    setDraftLabel("");
    setDraftCmd("");
    setAdding(false);
  }

  function remove(id: string) {
    persist(list.filter((c) => c.id !== id));
  }

  function reset() {
    if (!confirm("Reset the commands list to defaults?")) return;
    persist(DEFAULT_COMMANDS);
  }

  return (
    <div className="shell-cmds">
      <p className="shell-sidebar-hint">
        Click a command to inject it into the current PTY. Add your own
        with the <strong>+</strong> button.
      </p>
      <ul className="shell-cmd-list">
        {list.map((c) => (
          <li key={c.id} className="shell-cmd-item">
            <button
              className="shell-cmd-run"
              title={c.command}
              onClick={() => onRunCommand(c.command)}
            >
              <span className="shell-cmd-label">{c.label}</span>
              <code className="shell-cmd-cmd">{c.command}</code>
            </button>
            <button
              className="shell-cmd-del"
              title="Remove"
              aria-label={`Remove ${c.label}`}
              onClick={() => remove(c.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="shell-cmd-actions">
        <button className="ghost" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "+ Add command"}
        </button>
        <button className="ghost" onClick={reset} title="Restore defaults">
          Reset
        </button>
      </div>
      {adding && (
        <div className="shell-cmd-add">
          <input
            placeholder="Label (e.g. List users)"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
          />
          <textarea
            placeholder="Command (e.g. pm list users)"
            value={draftCmd}
            onChange={(e) => setDraftCmd(e.target.value)}
            rows={2}
          />
          <button
            className="primary"
            disabled={!draftLabel.trim() || !draftCmd.trim()}
            onClick={add}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ── Files tab (Scripts / Binaries) ────────────────────────────────────────

interface FilesTabProps {
  session: AdbSession;
  adb: AdbClient;
  kind: Kind;
  onRunCommand: (cmd: string) => void;
}

function FilesTab({ session, adb, kind, onRunCommand }: FilesTabProps) {
  const dir = kind === "script" ? SCRIPTS_DIR : BIN_DIR;
  const [entries, setEntries] = useState<SidebarEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await adb.shellMkdirP(dir);
      const raw = await session.adb.sync.readdir(dir);
      const list: SidebarEntry[] = raw
        .filter((e) => e.type === LinuxFileType.File)
        .map((e) => ({
          name: e.name,
          path: `${dir}/${e.name}`,
          size: typeof e.size === "number" ? e.size : 0,
          mtimeMs: typeof e.mtime === "number" ? e.mtime * 1000 : 0,
        }))
        // Newest first — easier to find what you just uploaded.
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      setEntries(list);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to list ${dir}: ${msg}`);
      setEntries([]);
    } finally {
      setBusy(false);
    }
  }, [adb, session, dir]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    setStatus(`Pushing ${files.length} file${files.length === 1 ? "" : "s"}…`);
    try {
      await adb.shellMkdirP(dir);
      let count = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const safe = sanitizeName(f.name, kind);
        const remote = `${dir}/${safe}`;
        const buf = new Uint8Array(await f.arrayBuffer());
        const written = await adb.pushBytes(remote, buf);
        if (kind === "binary" || /\.sh$|\.bash$/i.test(safe)) {
          await adb.shellChmod(remote, "0755");
        }
        count += 1;
        setStatus(`Uploaded ${count}/${files.length}: ${safe} (${written} B)`);
      }
      setStatus(`✓ ${count} file${count === 1 ? "" : "s"} uploaded`);
      await reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Upload failed: ${msg}`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setTimeout(() => setStatus(null), 3000);
    }
  }

  function runEntry(e: SidebarEntry) {
    if (kind === "script") {
      // `sh <path>` runs the script with the system shell (not `sh -i`,
      // because the script shouldn't share the PTY's line discipline).
      onRunCommand(`sh '${e.path}'`);
    } else {
      onRunCommand(`'${e.path}'`);
    }
  }

  async function renameEntry(e: SidebarEntry) {
    const next = window.prompt(`Rename ${e.name} to:`, e.name);
    if (!next || next === e.name) return;
    const safe = sanitizeName(next, kind);
    if (safe === e.name) return;
    const newPath = `${dir}/${safe}`;
    try {
      setBusy(true);
      await adb.shellMkdirP(dir);
      // `mv` overwrites nothing — refuse if target exists so we don't
      // silently clobber a user's other file.
      const exists = await adb.shellExists(newPath);
      if (exists) {
        setError(`Refusing to overwrite existing file: ${safe}`);
        return;
      }
      const out = await session.adb.subprocess.shellProtocol?.isSupported
        ? await (async () => {
            // shellProtocol was checked truthy above; TS doesn't narrow
            // through the conditional expression, so we re-bind it here.
            const shell = session.adb.subprocess.shellProtocol!;
            const proc = shell.spawn(["mv", e.path, newPath]);
            const r = await proc.wait();
            return r.exitCode;
          })()
        : null;
      if (out !== null && out !== 0) {
        setError(`mv failed (exit ${out})`);
        return;
      }
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Rename failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyPath(e: SidebarEntry) {
    try {
      await navigator.clipboard.writeText(e.path);
      setStatus(`Copied: ${e.path}`);
      setTimeout(() => setStatus(null), 1500);
    } catch {
      // Fallback for browsers without async clipboard permission.
      window.prompt("Copy path:", e.path);
    }
  }

  async function downloadEntry(e: SidebarEntry) {
    try {
      setBusy(true);
      const bytes = await adb.pullBytes(e.path);
      // Wrap the buffer in a fresh ArrayBuffer view so the Blob
      // constructor accepts it (Uint8Array<ArrayBufferLike> doesn't
      // satisfy BlobPart's tighter ArrayBuffer constraint under the
      // current TS lib).
      const blob = new Blob([bytes.buffer as ArrayBuffer]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = e.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so Safari has a chance to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Download failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(e: SidebarEntry) {
    if (!confirm(`Delete ${e.name} from the device?`)) return;
    try {
      setBusy(true);
      await adb.shellRm(e.path);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Delete failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function infoEntry(e: SidebarEntry) {
    setBusy(true);
    try {
      const out = await session.adb.subprocess.shellProtocol?.isSupported
        ? await (async () => {
            const shell = session.adb.subprocess.shellProtocol!;
            const proc = shell.spawn(["stat", e.path]);
            const r = await proc.wait();
            return (await r.stdout.toString()) + (await r.stderr.toString());
          })()
        : "";
      alert(
        `Path: ${e.path}\n` +
        `Size: ${fmtSize(e.size)}\n` +
        `Modified: ${fmtMtime(e.mtimeMs)}\n\n` +
        `--- stat ---\n${out.trim() || "(no output)"}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`stat failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell-files">
      <div className="shell-files-head">
        <code className="shell-files-dir" title={dir}>{dir}</code>
        <button className="ghost small" onClick={reload} disabled={busy} title="Refresh">
          ⟳
        </button>
      </div>
      <div className="shell-files-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          + Upload {kind === "script" ? "script" : "binary"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          accept={kind === "script" ? ".sh,.bash,text/*" : undefined}
          onChange={(e) => uploadFiles(e.target.files)}
        />
      </div>
      {status && <div className="shell-files-status">{status}</div>}
      {error && <div className="shell-files-error">{error}</div>}
      {entries === null ? (
        <div className="shell-files-empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="shell-files-empty">
          No files yet. Upload one above to get started.
        </div>
      ) : (
        <ul className="shell-files-list">
          {entries.map((e) => (
            <FileRow
              key={e.path}
              entry={e}
              kind={kind}
              busy={busy}
              onRun={() => runEntry(e)}
              onRename={() => renameEntry(e)}
              onCopy={() => copyPath(e)}
              onDownload={() => downloadEntry(e)}
              onDelete={() => deleteEntry(e)}
              onInfo={() => infoEntry(e)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── File row with right-click menu ─────────────────────────────────────────

interface FileRowProps {
  entry: SidebarEntry;
  kind: Kind;
  busy: boolean;
  onRun(): void;
  onRename(): void;
  onCopy(): void;
  onDownload(): void;
  onDelete(): void;
  onInfo(): void;
}

function FileRow({
  entry, kind, busy, onRun, onRename, onCopy, onDownload, onDelete, onInfo,
}: FileRowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest(".shell-file-menu")) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menu]);

  function openMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function closeAnd(fn: () => void) {
    setMenu(null);
    fn();
  }

  return (
    <div ref={rootRef} className="shell-file-item">
      <button
        className="shell-file-main"
        disabled={busy}
        onDoubleClick={onRun}
        onContextMenu={openMenu}
        title={`${entry.path}\nDouble-click: run · Right-click for more`}
      >
        <span className="shell-file-icon">{kind === "script" ? "📜" : "⚙"}</span>
        <span className="shell-file-meta">
          <span className="shell-file-name">{entry.name}</span>
          <span className="shell-file-sub">
            {fmtSize(entry.size)} · {fmtMtime(entry.mtimeMs)}
          </span>
        </span>
      </button>
      <button
        className="shell-file-run"
        disabled={busy}
        onClick={onRun}
        title="Run"
        aria-label={`Run ${entry.name}`}
      >
        ▶
      </button>
      {menu && (
        <div
          className="shell-file-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <MenuItem onClick={() => closeAnd(onRun)}>▶ Run</MenuItem>
          <MenuItem onClick={() => closeAnd(onRename)}>✎ Rename…</MenuItem>
          <MenuItem onClick={() => closeAnd(onCopy)}>⎘ Copy path</MenuItem>
          <MenuItem onClick={() => closeAnd(onDownload)}>⤓ Download</MenuItem>
          <MenuItem onClick={() => closeAnd(onInfo)}>ℹ Info</MenuItem>
          <MenuItem onClick={() => closeAnd(onDelete)} danger>🗑 Delete</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem(
  { onClick, children, danger }:
  { onClick: () => void; children: React.ReactNode; danger?: boolean },
) {
  return (
    <button
      role="menuitem"
      className={`shell-file-menu-item${danger ? " danger" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Re-export for typecheck to keep the symbol alive without unused warnings.
export type { AdbClient };