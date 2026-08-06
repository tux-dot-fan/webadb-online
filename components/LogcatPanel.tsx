"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getAdbClient, type AdbSession } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

// ---------------------------------------------------------------------------
// Types

/**
 * A single parsed logcat line.
 *
 * logcat default output (threadtime format):
 *   MM-DD HH:MM:SS.mmm  PID  TID  LEVEL TAG: MESSAGE
 *
 * We only need a small subset to drive filtering and display:
 *   - pid / tid: the producer of the line
 *   - level: V/D/I/W/E/F (verbose / debug / info / warn / error / fatal)
 *   - tag: the component that emitted the line
 *   - pkg: package associated with this pid (best-effort, looked up from
 *     `ps -A` — see packageCacheRef below)
 *   - time: formatted time string (date/month + clock)
 *   - raw: the un-parsed line text (after stripping ANSI)
 *   - message: what comes after `TAG:`
 *   - id: monotonically increasing index so React can key lines stably
 */
interface LogLine {
  id: number;
  raw: string;
  time: string;
  pid: string;
  tid: string;
  level: "V" | "D" | "I" | "W" | "E" | "F" | "?";
  tag: string;
  message: string;
  pkg: string;
}

type FilterKey =
  | { kind: "all" }
  | { kind: "tag"; value: string }
  | { kind: "pid"; value: string }
  | { kind: "tid"; value: string }
  | { kind: "pkg"; value: string }
  | { kind: "level"; value: LogLine["level"] };

/** Capture modes — see `startLive`/`startHistory` below for semantics. */
type Mode = "live" | "tail" | "history";

// ---------------------------------------------------------------------------
// ANSI parser

const FG_COLORS: Record<number, string> = {
  30: "#1c1c1c", 31: "#ff6b6b", 32: "#51d88a", 33: "#ffb547",
  34: "#4ea1ff", 35: "#c678dd", 36: "#56b6c2", 37: "#e6ebf5",
  90: "#5c6370", 91: "#ff8787", 92: "#7ed4a8", 93: "#ffcb6b",
  94: "#7eb8ff", 95: "#e29bf2", 96: "#9bd6e2", 97: "#ffffff",
};
const BG_COLORS: Record<number, string> = {
  40: "#1c1c1c", 41: "#5c1f1f", 42: "#1f3d29", 43: "#5c4a1f",
  44: "#1f335c", 45: "#3d1f5c", 46: "#1f4d4d", 47: "#3d3d3d",
};

function styleForParams(params: number[], prev: React.CSSProperties): React.CSSProperties {
  const style: React.CSSProperties = { ...prev };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) return {};
    else if (p === 1) style.fontWeight = "bold";
    else if (p === 2) style.opacity = 0.6;
    else if (p === 3) style.fontStyle = "italic";
    else if (p === 4) style.textDecoration = "underline";
    else if (p === 22) { style.fontWeight = undefined; style.opacity = undefined; }
    else if (p === 23) style.fontStyle = undefined;
    else if (p === 24) style.textDecoration = undefined;
    else if (p === 39) style.color = undefined;
    else if (p === 49) style.backgroundColor = undefined;
    else if (p >= 30 && p <= 37) style.color = FG_COLORS[p];
    else if (p >= 40 && p <= 47) style.backgroundColor = BG_COLORS[p];
    else if (p >= 90 && p <= 97) style.color = FG_COLORS[p];
    else if (p >= 100 && p <= 107) style.backgroundColor = BG_COLORS[p];
    else if (p === 38 && params[i + 1] === 5) { style.color = ansi256(params[i + 2]); i += 2; }
    else if (p === 48 && params[i + 1] === 5) { style.backgroundColor = ansi256(params[i + 2]); i += 2; }
  }
  return style;
}

function ansi256(n: number): string {
  if (n < 8) return ["#1c1c1c","#ff6b6b","#51d88a","#ffb547","#4ea1ff","#c678dd","#56b6c2","#e6ebf5"][n];
  if (n < 16) return ["#5c6370","#ff8787","#7ed4a8","#ffcb6b","#7eb8ff","#e29bf2","#9bd6e2","#ffffff"][n - 8];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  const r = Math.floor((i / 36) * 51);
  const g = Math.floor(((i / 6) % 6) * 51);
  const b = (i % 6) * 51;
  return `rgb(${r},${g},${b})`;
}

interface AnsiSpan { text: string; style: React.CSSProperties; }

function parseAnsi(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let buf = ""; let style: React.CSSProperties = {}; let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 27 && line.charCodeAt(i + 1) === 91) {
      if (buf) { spans.push({ text: buf, style }); buf = ""; }
      let j = i + 2;
      while (j < line.length && (line.charCodeAt(j) < 0x40 || line.charCodeAt(j) > 0x7e)) j++;
      const params = line.slice(i + 2, j).split(";")
        .filter((s) => s.length > 0).map(Number).filter(Number.isFinite);
      if (j < line.length) {
        if (line[j] === "m") style = styleForParams(params, style);
        i = j + 1; continue;
      }
      buf += line.slice(i); i = line.length; continue;
    }
    buf += line[i]; i++;
  }
  if (buf) spans.push({ text: buf, style });
  return spans;
}

/** Strip ANSI escape sequences — used before regex parsing. */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Line parsing

const LINE_RE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]+):\s?(.*)$/;

function parseLine(raw: string, id: number, pkgFor: (pid: string) => string): LogLine {
  const clean = stripAnsi(raw);
  const m = LINE_RE.exec(clean);
  if (!m) {
    return {
      id, raw,
      time: "", pid: "", tid: "",
      level: "?", tag: "", message: clean, pkg: "",
    };
  }
  const [, time, pid, tid, levelStr, tag, message] = m;
  const level = levelStr as LogLine["level"];
  return {
    id, raw,
    time, pid, tid, level,
    tag: tag.trim(), message,
    pkg: pkgFor(pid),
  };
}

// ---------------------------------------------------------------------------
// Severity helpers

const LEVEL_ORDER: LogLine["level"][] = ["F", "E", "W", "I", "D", "V", "?"];
const LEVEL_LABEL: Record<LogLine["level"], string> = {
  F: "FATAL", E: "ERROR", W: "WARN", I: "INFO", D: "DEBUG", V: "VERBOSE", "?": "??",
};
const LEVEL_COLOR: Record<LogLine["level"], string> = {
  F: "#ff6b6b", E: "#ff6b6b", W: "#ffb547", I: "#51d88a", D: "#4ea1ff", V: "#5c6370", "?": "#5c6370",
};

// ---------------------------------------------------------------------------
// Component

const BUFFER_SIZE_OPTIONS = [2000, 5000, 8000, 20000] as const;
type BufferSize = (typeof BUFFER_SIZE_OPTIONS)[number];

export function LogcatPanel({ session }: Props) {
  // -- state ---------------------------------------------------------------
  const [mode, setMode] = useState<Mode>("live");
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [tagSpec, setTagSpec] = useState("");
  const [historyLines, setHistoryLines] = useState(2000);
  const [filter, setFilter] = useState<FilterKey>({ kind: "all" });
  const [textFilter, setTextFilter] = useState("");
  const [regexMode, setRegexMode] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [bufferSize, setBufferSize] = useState<BufferSize>(8000);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Lines accumulate in a ref so streaming bytes don't trigger React renders
  // on every chunk. We flush via forceRender in batches.
  const linesRef = useRef<LogLine[]>([]);
  const nextIdRef = useRef(0);
  const [, forceRender] = useState(0);
  const outRef = useRef<HTMLDivElement>(null);
  const procRef = useRef<{ kill(): void; stdout: ReadableStream<Uint8Array> } | null>(null);

  // PID → package lookup.
  const pkgCacheRef = useRef<Map<string, string>>(new Map());
  const pkgLookupRunning = useRef(false);

  // -- effects -------------------------------------------------------------

  useEffect(() => {
    const el = outRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      // Only update stickiness when autoScroll is enabled — the user has
      // explicitly opted into manual scrolling otherwise.
      if (autoScroll) (el as HTMLElement).dataset.atBottom = atBottom ? "1" : "0";
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [autoScroll]);

  useEffect(() => {
    if (autoScroll && outRef.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
  });

  // Cleanup on unmount or session change.
  useEffect(() => {
    return () => {
      procRef.current?.kill();
      procRef.current = null;
    };
  }, [session]);

  // -- helpers -------------------------------------------------------------

  function pkgFor(pid: string): string {
    if (!pid) return "";
    return pkgCacheRef.current.get(pid) ?? "";
  }

  /** Push parsed lines into the buffer. */
  function ingest(raws: string[]) {
    if (raws.length === 0) return;
    const out: LogLine[] = [];
    for (const r of raws) {
      if (!r) continue;
      out.push(parseLine(r, nextIdRef.current++, pkgFor));
    }
    if (out.length === 0) return;
    linesRef.current.push(...out);
    // Cap memory: drop oldest beyond bufferSize.
    if (linesRef.current.length > bufferSize) {
      linesRef.current = linesRef.current.slice(-bufferSize);
    }
    forceRender((n) => n + 1);
    if (autoScroll && outRef.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
  }

  /** Background lookup: populate PID → package cache. */
  async function refreshPkgCache() {
    if (pkgLookupRunning.current) return;
    pkgLookupRunning.current = true;
    try {
      const client = getAdbClient();
      const procs = await client.getProcessList();
      const m = pkgCacheRef.current;
      for (const p of procs) {
        if (!p.pid) continue;
        const looksLikePkg = p.name.includes(".");
        if (looksLikePkg) m.set(String(p.pid), p.name);
      }
      // Re-tag existing lines if any now have a package.
      for (const line of linesRef.current) {
        if (!line.pkg && line.pid) {
          const pkg = m.get(line.pid);
          if (pkg) line.pkg = pkg;
        }
      }
      forceRender((n) => n + 1);
    } catch {
      // Non-fatal — pkg lookup is best-effort.
    } finally {
      pkgLookupRunning.current = false;
    }
  }

  // -- start / stop --------------------------------------------------------

  function clearBuffers() {
    linesRef.current = [];
    nextIdRef.current = 0;
    pkgCacheRef.current.clear();
    setFilter({ kind: "all" });
    setTextFilter("");
    forceRender((n) => n + 1);
  }

  async function start() {
    setError(null);
    setInfo(null);
    clearBuffers();
    setPaused(false);

    const client = getAdbClient();

    // The `mode` field controls what `logcat` command we actually run:
    //   live    — `logcat -v color`         (continuous stream)
    //   tail    — `logcat -v color -T 1`    (stream from "now" forward)
    //   history — `logcat -v color -d`      (dump ring buffer & exit)
    //
    // For `history` we don't keep the process alive — we let it finish, then
    // read stdout to completion, ingest, and auto-stop.
    const extraArgs: string[] = [];
    if (mode === "tail") extraArgs.push("-T", "1");
    if (mode === "history") {
      extraArgs.push("-d", "-T", String(Math.max(1, historyLines)));
    }

    try {
      const proc = await client.startLogcat([
        "-v",
        "color",
        ...extraArgs,
        ...(tagSpec ? ["-s", tagSpec] : []),
      ]);
      procRef.current = proc;
      setRunning(true);

      // Kick off a one-shot package lookup so PIDs resolve to package names.
      void refreshPkgCache();

      const decoder = new TextDecoder("utf-8", { fatal: false });
      let carry = "";
      (async () => {
        const stream = proc.stdout as unknown as ReadableStream<Uint8Array>;
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const parts = (carry + text).split("\n");
            carry = parts.pop() ?? "";
            if (!paused) ingest(parts);
          }
          if (carry) ingest([carry]);
        } catch {
          // Stream closed or errored — that's normal on kill/disconnect.
        } finally {
          reader.releaseLock();
        }
        // For `history`, the process exits naturally once the ring buffer
        // is drained — flip back to idle so the user can re-run or filter.
        if (mode === "history") {
          procRef.current = null;
          setRunning(false);
          setInfo(`Captured ${linesRef.current.length} line(s) from device history.`);
        }
      })();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  function stop() {
    procRef.current?.kill();
    procRef.current = null;
    setRunning(false);
  }

  function togglePause() {
    setPaused((p) => !p);
  }

  function clearAll() {
    clearBuffers();
    setInfo(null);
  }

  /** Clear the *device-side* ring buffer (logcat -c). */
  async function clearDeviceBuffer() {
    try {
      await getAdbClient().clearLogcatBuffer();
      setInfo("Device log buffer cleared.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Save the currently visible (filtered) lines to a downloadable file. */
  function exportVisible(visible: LogLine[]) {
    if (visible.length === 0) return;
    const text = visible.map((l) => l.raw).join("\n") + "\n";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `logcat-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setInfo(`Exported ${visible.length} line(s).`);
  }

  async function copyLine(line: LogLine) {
    try {
      await navigator.clipboard.writeText(line.raw);
      setCopiedId(line.id);
      setTimeout(() => setCopiedId((id) => (id === line.id ? null : id)), 600);
    } catch {
      // Clipboard denied — fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = line.raw;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  // -- filter derivation ---------------------------------------------------

  /**
   * Filter the captured lines. Both running and stopped streams can be
   * filtered; the filter only affects display, never the underlying capture.
   */
  const visibleLines = useMemo(() => {
    const f = filter;
    const tf = textFilter.trim();
    let re: RegExp | null = null;
    if (tf) {
      try {
        re = regexMode ? new RegExp(tf, "i") : null;
      } catch {
        re = null;
      }
    }
    return linesRef.current.filter((line) => {
      if (f.kind === "tag" && line.tag !== f.value) return false;
      if (f.kind === "pid" && line.pid !== f.value) return false;
      if (f.kind === "tid" && line.tid !== f.value) return false;
      if (f.kind === "pkg" && line.pkg !== f.value) return false;
      if (f.kind === "level" && line.level !== f.value) return false;
      if (tf) {
        const hay = line.raw;
        if (re) {
          if (!re.test(hay)) return false;
        } else {
          if (!hay.toLowerCase().includes(tf.toLowerCase())) return false;
        }
      }
      return true;
    });
    // We intentionally depend on `linesRef.current.length` (the React-rendered
    // tick counter) so we recompute when the buffer changes — the ref itself
    // isn't tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(linesRef.current as unknown as { length: number }).length, filter, textFilter, regexMode]);

  const chipUniverse = useMemo(() => {
    return deriveUniverse(linesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(linesRef.current as unknown as { length: number }).length]);

  // -- render --------------------------------------------------------------

  return (
    <section className="panel">
      <h2>Logcat</h2>
      <p className="panel-desc">
        Stream the device log. Choose a capture mode, then filter by tag /
        process / thread / package / severity using the buttons below.
        Filters apply to captured data even after stopping.
      </p>

      {/* Row 1: mode + start / stop / pause / clear */}
      <div className="row" style={{ marginBottom: 8, gap: 12 }}>
        <div className="seg-control" role="tablist" aria-label="Capture mode">
          <button
            className={"seg" + (mode === "live" ? " active" : "")}
            onClick={() => !running && setMode("live")}
            disabled={running}
            title="Stream live logcat output"
            role="tab"
            aria-selected={mode === "live"}
          >
            Live
          </button>
          <button
            className={"seg" + (mode === "tail" ? " active" : "")}
            onClick={() => !running && setMode("tail")}
            disabled={running}
            title="Stream only new lines from now on (-T 1)"
            role="tab"
            aria-selected={mode === "tail"}
          >
            Tail
          </button>
          <button
            className={"seg" + (mode === "history" ? " active" : "")}
            onClick={() => !running && setMode("history")}
            disabled={running}
            title="Dump the device's log ring buffer, then stop (-d)"
            role="tab"
            aria-selected={mode === "history"}
          >
            History
          </button>
        </div>

        {!running ? (
          <button onClick={() => void start()} className="primary">
            ▶ Start
          </button>
        ) : (
          <>
            <button onClick={togglePause}>
              {paused ? "▶ Resume" : "⏸ Pause"}
            </button>
            <button onClick={stop} className="danger">
              ■ Stop
            </button>
          </>
        )}
        <button onClick={clearAll} disabled={running && !paused}>
          ✕ Clear
        </button>
        <button onClick={() => void clearDeviceBuffer()} disabled={running}>
          ⚠ Clear device
        </button>
      </div>

      {/* Row 1.5: tag spec + buffer size */}
      <div className="row" style={{ marginBottom: 8, gap: 12 }}>
        <input
          value={tagSpec}
          onChange={(e) => setTagSpec(e.target.value)}
          placeholder="tag spec (e.g. *:E MyTag:V) — applied at start"
          disabled={running}
          style={{ flex: 1, minWidth: 200, fontFamily: "var(--mono)" }}
        />
        <label className="row-label">
          Buffer
          <select
            value={bufferSize}
            onChange={(e) => setBufferSize(Number(e.target.value) as BufferSize)}
            disabled={running}
            className="num-input"
            style={{ fontFamily: "var(--mono)" }}
          >
            {BUFFER_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n >= 1000 ? `${n / 1000}k` : n}
              </option>
            ))}
          </select>
        </label>
        <label
          className="row-label"
          style={{
            opacity: mode === "history" ? 1 : 0.4,
            pointerEvents: mode === "history" ? "auto" : "none",
          }}
          title="How many recent lines to dump in History mode"
        >
          Lines
          <input
            type="number"
            min={50}
            max={100000}
            step={100}
            value={historyLines}
            disabled={mode !== "history" || running}
            onChange={(e) =>
              setHistoryLines(Math.max(50, Number(e.target.value) || 50))
            }
            className="num-input"
            style={{ width: 90, fontFamily: "var(--mono)" }}
          />
        </label>
      </div>

      {error && (
        <div className="banner error" style={{ margin: "0 0 12px" }}>
          {error}
        </div>
      )}
      {info && !error && (
        <div className="banner info" style={{ margin: "0 0 12px" }}>
          {info}
        </div>
      )}

      {/* Row 2: filter chips */}
      <FilterBar filter={filter} onChange={setFilter} universe={chipUniverse} />

      {/* Row 3: free-text search + view options */}
      <div className="row" style={{ marginBottom: 10, gap: 12 }}>
        <input
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder={
            regexMode ? "regex (case-insensitive)" : "Filter message text…"
          }
          style={{ flex: 1, minWidth: 200, fontFamily: "var(--mono)" }}
        />
        <label className="row-label">
          <input
            type="checkbox"
            checked={regexMode}
            onChange={(e) => setRegexMode(e.target.checked)}
          />
          regex
        </label>
        <label className="row-label">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
          />
          wrap
        </label>
        <label className="row-label">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
        <button
          onClick={() => exportVisible(visibleLines)}
          disabled={visibleLines.length === 0}
        >
          ⤓ Export
        </button>
      </div>

      {/* Output */}
      <div
        ref={outRef}
        className="shell-output"
        style={{
          minHeight: 360,
          maxHeight: 600,
          whiteSpace: wrap ? "pre-wrap" : "pre",
        }}
      >
        {linesRef.current.length === 0 && !running && (
          <div className="muted">Press Start to begin streaming.</div>
        )}
        {linesRef.current.length === 0 && running && (
          <div className="muted">Waiting for log lines…</div>
        )}
        {visibleLines.map((line) => (
          <LogRow
            key={line.id}
            line={line}
            hlText={textFilter && !regexMode ? textFilter.trim() : ""}
            copied={copiedId === line.id}
            onClick={() => void copyLine(line)}
          />
        ))}
        {visibleLines.length === 0 && linesRef.current.length > 0 && (
          <div className="muted">
            No lines match the current filter ({linesRef.current.length}{" "}
            hidden).
          </div>
        )}
      </div>

      <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
        {visibleLines.length} of {linesRef.current.length} line
        {linesRef.current.length === 1 ? "" : "s"}
        {paused && running && (
          <> · paused (new lines are being discarded)</>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Filter bar

function FilterBar({
  filter,
  onChange,
  universe,
}: {
  filter: FilterKey;
  onChange: (f: FilterKey) => void;
  universe: ReturnType<typeof deriveUniverse>;
}) {
  const sections: Array<{
    label: string;
    chipKind: FilterKey["kind"];
    items: Array<{ value: string; label: string; sub?: string }>;
  }> = [
    { label: "Tag", chipKind: "tag", items: universe.tags },
    { label: "Process (PID)", chipKind: "pid", items: universe.pids },
    { label: "Thread (TID)", chipKind: "tid", items: universe.tids },
    { label: "Package", chipKind: "pkg", items: universe.pkgs },
    { label: "Level", chipKind: "level", items: universe.levels },
  ];

  return (
    <div className="filter-bar" style={{ marginBottom: 10 }}>
      <button
        className={"chip" + (filter.kind === "all" ? " active" : "")}
        onClick={() => onChange({ kind: "all" })}
      >
        All
        <span className="chip-count">{universe.totalCount}</span>
      </button>

      {sections.map((sec) => {
        const active =
          filter.kind === sec.chipKind
            ? (filter as { kind: string; value: string }).value
            : null;
        return (
          <div key={sec.chipKind} className="chip-section">
            <span className="chip-label">{sec.label}</span>
            {sec.items.length === 0 && <span className="chip-empty">—</span>}
            {sec.items.map((it) => {
              const isActive = active === it.value;
              return (
                <button
                  key={`${sec.chipKind}:${it.value}`}
                  className={
                    "chip" +
                    (isActive ? " active" : "") +
                    (sec.chipKind === "level" ? " level-chip" : "")
                  }
                  onClick={() =>
                    onChange({
                      kind: sec.chipKind as FilterKey["kind"],
                      value: it.value,
                    } as FilterKey)
                  }
                  style={
                    sec.chipKind === "level"
                      ? { borderColor: LEVEL_COLOR[it.value as LogLine["level"]] }
                      : undefined
                  }
                >
                  {it.label}
                  {it.sub && <span className="chip-count">{it.sub}</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row

function LogRow({
  line,
  hlText,
  copied,
  onClick,
}: {
  line: LogLine;
  hlText: string;
  copied: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={"log-row" + (copied ? " copied" : "")}
      onClick={onClick}
      title="Click to copy this line"
      style={{
        fontFamily: "var(--mono)",
        fontSize: 12,
        display: "grid",
        gridTemplateColumns: "auto auto auto auto 1fr",
        columnGap: 8,
        alignItems: "baseline",
      }}
    >
      <span style={{ color: "#5c6370" }}>{line.time || "··"}</span>
      <span
        style={{
          color: LEVEL_COLOR[line.level],
          fontWeight: "bold",
          minWidth: 28,
        }}
      >
        {LEVEL_LABEL[line.level]}
      </span>
      <span
        style={{ color: "#4ea1ff" }}
        title={line.pkg ? `${line.pkg} (${line.pid})` : `pid ${line.pid}`}
      >
        {line.pkg || line.pid || "··"}
      </span>
      <span style={{ color: "#c678dd" }}>{line.tid || "··"}</span>
      <HighlightedText line={line} hlText={hlText} />
    </div>
  );
}

function HighlightedText({ line, hlText }: { line: LogLine; hlText: string }) {
  const spans = parseAnsi(line.raw);
  // If we have a plain-text highlight, split the raw line on case-insensitive
  // matches and wrap each occurrence in <span class="log-hl">. We disable
  // highlighting when the user is in regex mode (the regex itself controls
  // what's kept; highlighting every char class match is noisy).
  if (hlText) {
    const re = new RegExp(
      `(${hlText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "ig",
    );
    if (re.test(line.raw)) {
      re.lastIndex = 0;
      const parts = line.raw.split(re);
      return (
        <>
          {parts.map((p, i) =>
            i % 2 === 1 ? (
              <span key={i} className="log-hl">
                {p}
              </span>
            ) : (
              <span key={i}>{p}</span>
            ),
          )}
        </>
      );
    }
  }
  // Fallback: render ANSI spans + a parsed tag/message breakdown.
  return (
    <>
      {spans.map((s, j) => (
        <span key={j} style={s.style}>
          {s.text}
        </span>
      ))}
      {spans.length <= 1 && (
        <>
          <span style={{ color: "#51d88a" }}>{line.tag || "··"}</span>
          <span style={{ color: "#e6ebf5" }}>: {line.message}</span>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Universe

interface ChipUniverse {
  totalCount: number;
  tags: Array<{ value: string; label: string; sub?: string }>;
  pids: Array<{ value: string; label: string; sub?: string }>;
  tids: Array<{ value: string; label: string; sub?: string }>;
  pkgs: Array<{ value: string; label: string; sub?: string }>;
  levels: Array<{ value: string; label: string; sub?: string }>;
}

function deriveUniverse(lines: LogLine[]): ChipUniverse {
  const tagCounts = new Map<string, number>();
  const pidCounts = new Map<string, number>();
  const tidCounts = new Map<string, number>();
  const pkgCounts = new Map<string, number>();
  const levelCounts = new Map<LogLine["level"], number>();
  let total = 0;
  for (const l of lines) {
    total++;
    if (l.tag) tagCounts.set(l.tag, (tagCounts.get(l.tag) ?? 0) + 1);
    if (l.pid) pidCounts.set(l.pid, (pidCounts.get(l.pid) ?? 0) + 1);
    if (l.tid) tidCounts.set(l.tid, (tidCounts.get(l.tid) ?? 0) + 1);
    if (l.pkg) pkgCounts.set(l.pkg, (pkgCounts.get(l.pkg) ?? 0) + 1);
    levelCounts.set(l.level, (levelCounts.get(l.level) ?? 0) + 1);
  }
  const top = <T,>(m: Map<T, number>, n: number): Array<[T, number]> =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  return {
    totalCount: total,
    tags: top(tagCounts, 12).map(([k, c]) => ({ value: k, label: k, sub: String(c) })),
    pids: top(pidCounts, 8).map(([k, c]) => ({
      value: k, label: `pid ${k}`, sub: String(c),
    })),
    tids: top(tidCounts, 8).map(([k, c]) => ({
      value: k, label: `tid ${k}`, sub: String(c),
    })),
    pkgs: top(pkgCounts, 8).map(([k, c]) => ({ value: k, label: k, sub: String(c) })),
    levels: LEVEL_ORDER
      .filter((lv) => (levelCounts.get(lv) ?? 0) > 0)
      .map((lv) => ({
        value: lv, label: LEVEL_LABEL[lv], sub: String(levelCounts.get(lv) ?? 0),
      })),
  };
}