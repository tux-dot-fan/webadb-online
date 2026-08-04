"use client";

import { useEffect, useRef, useState } from "react";
import { getAdbClient, type AdbSession } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

// ---- ANSI parser --------------------------------------------------------

/**
 * Minimal ANSI escape parser. Converts SGR (Select Graphic Rendition) escape
 * sequences to inline styles. logcat rarely uses anything beyond color + bold,
 * so we handle just the common subset:
 *   ESC[0m          reset
 *   ESC[1m          bold
 *   ESC[2m          dim
 *   ESC[3m          italic
 *   ESC[4m          underline
 *   ESC[30-37m      fg color (8 basic)
 *   ESC[90-97m      fg color (bright 8)
 *   ESC[38;5;Nm     fg color (256-color)
 *   ESC[39m         default fg
 *   ESC[40-47m      bg color (8 basic)
 *   ESC[100-107m    bg color (bright 8)
 *   ESC[48;5;Nm     bg color (256-color)
 *   ESC[49m         default bg
 *
 * Any other escape sequence (cursor movement, etc.) is dropped. logcat -v color
 * only emits SGR sequences so this is enough.
 */

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
    if (p === 0) {
      return {};
    } else if (p === 1) {
      style.fontWeight = "bold";
    } else if (p === 2) {
      style.opacity = 0.6;
    } else if (p === 3) {
      style.fontStyle = "italic";
    } else if (p === 4) {
      style.textDecoration = "underline";
    } else if (p === 22) {
      style.fontWeight = undefined;
      style.opacity = undefined;
    } else if (p === 23) {
      style.fontStyle = undefined;
    } else if (p === 24) {
      style.textDecoration = undefined;
    } else if (p === 39) {
      style.color = undefined;
    } else if (p === 49) {
      style.backgroundColor = undefined;
    } else if (p >= 30 && p <= 37) {
      style.color = FG_COLORS[p];
    } else if (p >= 40 && p <= 47) {
      style.backgroundColor = BG_COLORS[p];
    } else if (p >= 90 && p <= 97) {
      style.color = FG_COLORS[p];
    } else if (p >= 100 && p <= 107) {
      style.backgroundColor = BG_COLORS[p];
    } else if (p === 38 && params[i + 1] === 5) {
      // 256-color fg
      const n = params[i + 2];
      if (typeof n === "number") style.color = ansi256(n);
      i += 2;
    } else if (p === 48 && params[i + 1] === 5) {
      // 256-color bg
      const n = params[i + 2];
      if (typeof n === "number") style.backgroundColor = ansi256(n);
      i += 2;
    }
  }
  return style;
}

function ansi256(n: number): string {
  if (n < 8) {
    return ["#1c1c1c", "#ff6b6b", "#51d88a", "#ffb547", "#4ea1ff", "#c678dd", "#56b6c2", "#e6ebf5"][n];
  }
  if (n < 16) {
    return ["#5c6370", "#ff8787", "#7ed4a8", "#ffcb6b", "#7eb8ff", "#e29bf2", "#9bd6e2", "#ffffff"][n - 8];
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor((i / 36) * 51);
  const g = Math.floor(((i / 6) % 6) * 51);
  const b = (i % 6) * 51;
  return `rgb(${r},${g},${b})`;
}

interface AnsiSpan {
  text: string;
  style: React.CSSProperties;
}

/**
 * Parse a single line (no embedded newlines) into styled spans. logcat emits
 * one log line at a time, so we don't need to handle CR/LF inside.
 */
function parseAnsi(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let buf = "";
  let style: React.CSSProperties = {};
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    // ESC = 27, '[' = 91
    if (c === 27 && line.charCodeAt(i + 1) === 91) {
      if (buf) {
        spans.push({ text: buf, style });
        buf = "";
      }
      // Read parameter bytes (digits, ';') until we hit a final byte (0x40-0x7E).
      let j = i + 2;
      while (j < line.length) {
        const cc = line.charCodeAt(j);
        if (cc >= 0x40 && cc <= 0x7e) break;
        j++;
      }
      const params = line
        .slice(i + 2, j)
        .split(";")
        .filter((s) => s.length > 0)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
      // Only consume if we actually saw a final byte.
      if (j < line.length) {
        // Only SGR ('m') matters; everything else (cursor moves) we drop.
        if (line[j] === "m") {
          style = styleForParams(params, style);
        }
        i = j + 1;
        continue;
      }
      // Unterminated escape — emit the raw bytes and stop parsing.
      buf += line.slice(i);
      i = line.length;
      continue;
    }
    buf += line[i];
    i++;
  }
  if (buf) spans.push({ text: buf, style });
  return spans;
}

// ---- Component ----------------------------------------------------------

export function LogcatPanel({ session }: Props) {
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [lineCount, setLineCount] = useState(0);

  // Lines accumulate in a ref so we don't trigger React renders for every chunk.
  const linesRef = useRef<string[]>([]);
  // When paused, we still capture into a separate buffer so the user can review.
  const pausedBufferRef = useRef<string[]>([]);
  // Force a re-render when we want to flush.
  const [, forceRender] = useState(0);
  const outRef = useRef<HTMLDivElement>(null);
  const procRef = useRef<{ kill(): void } | null>(null);
  // Auto-scroll only if user is already at the bottom.
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = outRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      stickToBottom.current = atBottom;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on new lines when sticking.
  useEffect(() => {
    if (stickToBottom.current && outRef.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
  }, [lineCount]);

  // Cleanup on unmount or session change.
  useEffect(() => {
    return () => {
      procRef.current?.kill();
      procRef.current = null;
    };
  }, [session]);

  function flush() {
    forceRender((n) => n + 1);
    setLineCount(linesRef.current.length);
  }

  async function start() {
    setError(null);
    setRunning(true);
    setPaused(false);
    linesRef.current = [];
    pausedBufferRef.current = [];
    setLineCount(0);
    flush();

    try {
      const proc = await getAdbClient().startLogcat(
        filter ? ["-s", filter] : [],
      );
      procRef.current = proc;

      // Spawn a consumer task that pulls bytes off the stream, splits on
      // newlines, and either appends to the live list (if not paused) or to
      // the paused buffer.
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let carry = "";
      (async () => {
        try {
          for await (const chunk of proc.stream) {
            const text = decoder.decode(chunk, { stream: true });
            const parts = (carry + text).split("\n");
            carry = parts.pop() ?? ""; // last incomplete line
            if (paused) {
              pausedBufferRef.current.push(...parts);
            } else {
              linesRef.current.push(...parts);
              // Cap at 5000 lines so memory doesn't blow up on a chatty device.
              if (linesRef.current.length > 5000) {
                linesRef.current = linesRef.current.slice(-5000);
              }
              flush();
            }
          }
        } catch (e) {
          // Stream closed or errored — that's normal on kill/disconnect.
          if (carry) {
            (paused ? pausedBufferRef.current : linesRef.current).push(carry);
          }
          flush();
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
    if (!paused) {
      // Move buffered lines into paused buffer.
      pausedBufferRef.current.push(...linesRef.current);
      linesRef.current = [];
      setPaused(true);
      flush();
    } else {
      linesRef.current = pausedBufferRef.current;
      pausedBufferRef.current = [];
      setPaused(false);
      flush();
    }
  }

  function clear() {
    linesRef.current = [];
    pausedBufferRef.current = [];
    flush();
  }

  return (
    <section className="panel">
      <h2>Logcat</h2>
      <p className="panel-desc">
        Live device log stream. Tag filter (e.g. <code>*:E</code> for errors only,
        or <code>MyTag:V</code> to follow a specific tag).
      </p>

      <div className="row" style={{ marginBottom: 10 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="*:S MyTag:V  (logcat tag spec)"
          disabled={running}
          style={{ flex: 1, minWidth: 200, fontFamily: "var(--mono)" }}
        />
        {!running ? (
          <button onClick={() => void start()} className="primary">
            Start
          </button>
        ) : (
          <>
            <button onClick={togglePause} disabled={!running}>
              {paused ? "Resume" : "Pause"}
            </button>
            <button onClick={stop} disabled={!running}>
              Stop
            </button>
          </>
        )}
        <button onClick={clear} disabled={running && !paused}>
          Clear
        </button>
      </div>

      {error && (
        <div className="banner error" style={{ margin: "0 0 12px" }}>
          {error}
        </div>
      )}

      <div
        ref={outRef}
        className="shell-output"
        style={{ minHeight: 360, maxHeight: 600 }}
      >
        {linesRef.current.length === 0 && !running && (
          <div className="muted">Press Start to begin streaming.</div>
        )}
        {linesRef.current.length === 0 && running && !paused && (
          <div className="muted">Waiting for log lines…</div>
        )}
        {linesRef.current.length === 0 && paused && (
          <div className="muted">
            Paused. {pausedBufferRef.current.length} line(s) buffered.
          </div>
        )}
        {linesRef.current.map((line, i) => {
          const spans = parseAnsi(line);
          return (
            <div key={i} style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              {spans.map((s, j) => (
                <span key={j} style={s.style}>
                  {s.text}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
        {linesRef.current.length} line{linesRef.current.length === 1 ? "" : "s"}
        {paused && pausedBufferRef.current.length > 0 && (
          <> · {pausedBufferRef.current.length} buffered while paused</>
        )}
      </div>
    </section>
  );
}