"use client";

// ── SystemMonitorPanel ──────────────────────────────────────────────────────
//
// Live device resource monitor — similar to GNOME System Monitor.
//
// Two tabs:
//   • General  — per-core CPU usage bars (sampled twice to compute busy %)
//                and memory water level with available/buffers/cached/swap.
//   • Processes — sortable table of every running process with CPU% /
//                  MEM% / RSS. Auto-refreshes on a configurable interval.
//
// All data comes from /proc/stat, /proc/meminfo, and `ps -A`. We sample
// the device every `intervalMs` (default 2 s) and re-render. CPU% needs
// two consecutive samples so the first tick shows "—".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAdbClient,
  type AdbSession,
  type CpuStats,
  type MemoryInfo,
  type ProcessInfo,
  computeCpuPercents,
} from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

type Tab = "general" | "processes";
type ProcSort = "cpu" | "mem" | "rss" | "pid" | "name";

const INTERVAL_OPTIONS = [
  { ms: 1000, label: "1 s" },
  { ms: 2000, label: "2 s" },
  { ms: 5000, label: "5 s" },
] as const;

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtBytes(kib: number): string {
  if (kib < 1024) return `${kib} KiB`;
  if (kib < 1024 * 1024) return `${(kib / 1024).toFixed(1)} MiB`;
  return `${(kib / 1024 / 1024).toFixed(2)} GiB`;
}

function fmtPercent(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

// ── Component ───────────────────────────────────────────────────────────────

export function SystemMonitorPanel({ session: _session }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const [intervalMs, setIntervalMs] = useState<number>(2000);
  const [paused, setPaused] = useState(false);

  const [cpu, setCpu] = useState<CpuStats | null>(null);
  const [cpuPct, setCpuPct] = useState<(number | null)[] | null>(null);
  const [mem, setMem] = useState<MemoryInfo | null>(null);
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  // ── Tick: fetch cpu, mem, procs in parallel ──────────────────────────────
  const prevCpuRef = useRef<CpuStats | null>(null);

  const tick = useCallback(async () => {
    const client = getAdbClient();
    try {
      const [nextCpu, nextMem, nextProcs] = await Promise.all([
        client.getCpuStats(),
        client.getMemoryInfo(),
        client.getProcessList(),
      ]);
      const pcts = computeCpuPercents(prevCpuRef.current, nextCpu);
      prevCpuRef.current = nextCpu;
      setCpu(nextCpu);
      setCpuPct(pcts);
      setMem(nextMem);
      setProcs(nextProcs);
      setLastUpdate(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // ── Refresh interval ─────────────────────────────────────────────────────
  useEffect(() => {
    if (paused) return;
    // Fire one tick immediately so the UI isn't blank for 2 s on first paint.
    void tick();
    const id = window.setInterval(() => { void tick(); }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, paused, tick]);

  // ── Process table sort + search ──────────────────────────────────────────
  const [procSort, setProcSort] = useState<ProcSort>("cpu");
  const [procSearch, setProcSearch] = useState("");

  const sortedProcs = useMemo(() => {
    const needle = procSearch.trim().toLowerCase();
    const filtered = needle
      ? procs.filter((p) =>
          p.name.toLowerCase().includes(needle)
          || p.user.toLowerCase().includes(needle)
          || String(p.pid).includes(needle),
        )
      : procs;
    const arr = [...filtered];
    arr.sort((a, b) => {
      switch (procSort) {
        case "cpu": return b.cpuPercent - a.cpuPercent;
        case "mem": return b.memPercent - a.memPercent;
        case "rss": return (b.rssKb ?? -1) - (a.rssKb ?? -1);
        case "pid": return a.pid - b.pid;
        case "name": return a.name.localeCompare(b.name);
      }
    });
    return arr;
  }, [procs, procSort, procSearch]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="monitor">
      <header className="monitor-tabs">
        <div className="monitor-tab-list" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "general"}
            className={`monitor-tab${tab === "general" ? " is-active" : ""}`}
            onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "processes"}
            className={`monitor-tab${tab === "processes" ? " is-active" : ""}`}
            onClick={() => setTab("processes")}
          >
            Processes ({procs.length})
          </button>
        </div>
        <div className="monitor-toolbar">
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            aria-label="Refresh interval"
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            title={paused ? "Resume polling" : "Pause polling"}
          >
            {paused ? "▶" : "❚❚"}
          </button>
          <button
            type="button"
            onClick={() => void tick()}
            title="Refresh now"
          >
            ↻
          </button>
          <span className="monitor-stamp" title={lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "—"}>
            {lastUpdate ? `${Math.max(0, Math.round((Date.now() - lastUpdate) / 1000))}s ago` : "—"}
          </span>
        </div>
      </header>

      {error && (
        <div className="banner error" style={{ margin: "0 0 8px" }}>
          {error}
        </div>
      )}

      {tab === "general" && (
        <GeneralTab
          cpu={cpu}
          cpuPct={cpuPct}
          mem={mem}
        />
      )}
      {tab === "processes" && (
        <ProcessesTab
          procs={sortedProcs}
          sort={procSort}
          onSortChange={setProcSort}
          search={procSearch}
          onSearchChange={setProcSearch}
        />
      )}
    </div>
  );
}

// ── General tab ─────────────────────────────────────────────────────────────

interface GeneralTabProps {
  cpu: CpuStats | null;
  cpuPct: (number | null)[] | null;
  mem: MemoryInfo | null;
}

function GeneralTab({ cpu, cpuPct, mem }: GeneralTabProps) {
  const memUsedPct = mem && mem.total > 0
    ? Math.max(0, Math.min(100, ((mem.total - mem.available) / mem.total) * 100))
    : 0;

  return (
    <div className="monitor-general">
      <section className="monitor-section">
        <h3>CPU ({cpu ? cpu.perCpu.length : "—"}{cpu ? "" : ""})</h3>
        {!cpu && (
          <p className="muted">Sampling…</p>
        )}
        {cpu && cpu.perCpu.length === 0 && (
          <p className="muted">No per-core stats available.</p>
        )}
        <ul className="monitor-cpu-list">
          {cpu?.perCpu.map((core, i) => {
            const pct = cpuPct?.[i] ?? null;
            return (
              <li key={core.label} className="monitor-cpu-row">
                <span className="monitor-cpu-label">{core.label.replace(/^cpu/, "CPU ")}</span>
                <div className="monitor-bar">
                  <div
                    className="monitor-bar-fill"
                    style={{ width: pct === null ? "0%" : `${pct}%` }}
                    data-level={pct === null ? "idle" : pct >= 80 ? "high" : pct >= 50 ? "mid" : "low"}
                  />
                </div>
                <span className="monitor-cpu-pct">{fmtPercent(pct)}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="monitor-section">
        <h3>Memory</h3>
        {!mem ? (
          <p className="muted">Sampling…</p>
        ) : (
          <>
            <div className="monitor-mem-header">
              <span>
                <strong>{fmtBytes(mem.total - mem.available)}</strong>
                <span className="muted"> / {fmtBytes(mem.total)} used</span>
              </span>
              <span className="muted">{memUsedPct.toFixed(1)}%</span>
            </div>
            <div className="monitor-bar">
              <div
                className="monitor-bar-fill"
                style={{ width: `${memUsedPct}%` }}
                data-level={
                  memUsedPct >= 90 ? "high"
                  : memUsedPct >= 70 ? "mid"
                  : "low"
                }
              />
            </div>
            <dl className="monitor-mem-meta">
              <dt>Available</dt>
              <dd>
                {fmtBytes(mem.available)}
                {mem.availableSource === "fallback" && (
                  <span className="muted" title="Older kernel — fallback estimate"> (est.)</span>
                )}
              </dd>
              <dt>Free</dt>
              <dd>{fmtBytes(mem.free)}</dd>
              <dt>Buffers</dt>
              <dd>{fmtBytes(mem.buffers)}</dd>
              <dt>Cached</dt>
              <dd>{fmtBytes(mem.cached)}</dd>
              <dt>Dirty</dt>
              <dd>{fmtBytes(mem.dirty)}</dd>
              <dt>Swap</dt>
              <dd>
                {fmtBytes(mem.swapTotal - mem.swapFree)} / {fmtBytes(mem.swapTotal)}
              </dd>
            </dl>
          </>
        )}
      </section>
    </div>
  );
}

// ── Processes tab ───────────────────────────────────────────────────────────

interface ProcessesTabProps {
  procs: ProcessInfo[];
  sort: ProcSort;
  onSortChange: (s: ProcSort) => void;
  search: string;
  onSearchChange: (s: string) => void;
}

function ProcessesTab({ procs, sort, onSortChange, search, onSearchChange }: ProcessesTabProps) {
  return (
    <div className="monitor-procs">
      <div className="monitor-procs-toolbar">
        <input
          type="search"
          placeholder="Filter by name, user, or PID…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <span className="muted">
          {procs.length} process{procs.length === 1 ? "" : "es"}
        </span>
      </div>
      <div className="monitor-procs-table-wrap">
        <table className="monitor-procs-table">
          <thead>
            <tr>
              <SortHeader field="pid" current={sort} onClick={onSortChange} align="right">PID</SortHeader>
              <SortHeader field="name" current={sort} onClick={onSortChange}>Name</SortHeader>
              <SortHeader field="name" current={sort} onClick={onSortChange}>User</SortHeader>
              <SortHeader field="cpu" current={sort} onClick={onSortChange} align="right">CPU %</SortHeader>
              <SortHeader field="mem" current={sort} onClick={onSortChange} align="right">MEM %</SortHeader>
              <SortHeader field="rss" current={sort} onClick={onSortChange} align="right">RSS</SortHeader>
            </tr>
          </thead>
          <tbody>
            {procs.map((p) => (
              <tr key={p.pid}>
                <td className="num">{p.pid}</td>
                <td className="name" title={p.name}>{p.name}</td>
                <td className="user">{p.user}</td>
                <td className="num">
                  <Bar value={p.cpuPercent} />
                  <span className="monitor-pct">{p.cpuPercent.toFixed(1)}%</span>
                </td>
                <td className="num">
                  <Bar value={p.memPercent} />
                  <span className="monitor-pct">{p.memPercent.toFixed(1)}%</span>
                </td>
                <td className="num">{p.rssKb === null ? "—" : fmtBytes(p.rssKb)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  field, current, onClick, align, children,
}: {
  field: ProcSort;
  current: ProcSort;
  onClick: (s: ProcSort) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const active = field === current;
  return (
    <th
      className={`${align === "right" ? "right" : ""}${active ? " is-active" : ""}`}
      onClick={() => onClick(field)}
      role="button"
      aria-sort={active ? "ascending" : "none"}
    >
      {children}{active && <span className="sort-arrow"> ↓</span>}
    </th>
  );
}

function Bar({ value }: { value: number }) {
  // Clamp to 0-100 for the bar fill; display label uses the raw value.
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="monitor-row-bar">
      <div
        className="monitor-row-bar-fill"
        style={{ width: `${v}%` }}
        data-level={v >= 80 ? "high" : v >= 50 ? "mid" : "low"}
      />
    </div>
  );
}