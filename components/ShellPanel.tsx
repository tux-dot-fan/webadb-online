"use client";

/**
 * Interactive shell panel — a full xterm.js terminal wired up to an ADB
 * PTY session. The earlier implementation ran one-shot commands via
 * `subprocess.shellProtocol.spawn()` and accumulated the output as text —
 * which means `vim`, `top`, arrow-key editing, Ctrl+C, Tab completion,
 * etc. all didn't work.
 *
 * This version opens a true PTY (`shellProtocol.pty()`), which allocates
 * a real pseudo-terminal on the device with full line discipline, so:
 *   - arrow keys for history / line edit
 *   - Ctrl+C to interrupt a running process
 *   - Tab completion
 *   - 256-color output from programs like `ls --color` or `htop`
 *   - window resize when the user drags the terminal edge
 *
 * Tradeoffs: xterm.js adds ~120 kB gzipped to the bundle (one-time cost
 * — only loaded when this panel actually mounts) and needs the browser
 * to hand a font to the canvas glyph renderer. We lazy-load it via
 * dynamic import so it doesn't bloat the home-page bundle.
 */

import { useEffect, useRef, useState } from "react";
import type { AdbSession } from "@/lib/adb-client";
import { getAdbClient, type AdbClient } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

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

export function ShellPanel({ session }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TermHandle | null>(null);
  // Bumping this key on the container <div> forces React to unmount +
  // remount, which in turn re-runs our setup effect and re-opens a
  // fresh PTY. Used by the Restart button and by device-switch.
  const [remountKey, setRemountKey] = useState(0);
  const [status, setStatus] = useState<"starting" | "running" | "stopped">(
    "starting",
  );

  const serial = session.adb.serial;

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

      // Terminal font: JetBrains Mono is legible at small sizes, has good
      // distinction between 0/O and 1/l/I, and includes box-drawing chars.
      // CJK users may prefer a system CJK monospace — let the OS pick.
      const fontFamily =
        '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace';

      const term = new Terminal({
        fontSize: 14,
        fontFamily,
        fontWeight: "400",
        fontWeightBold: "700",
        cursorBlink: true,
        cursorStyle: "block",
        // Dark background — no conflict with light/dark page theme. The
        // terminal always stays dark so white/green text pops clearly.
        theme: {
          background: "#0d1117",
          foreground: "#e6edf3",
          cursor: "#e6edf3",
          // Selection / highlight
          selectionBackground: "rgba(78, 161, 255, 0.25)",
          // ANSI 16-color palette — GitHub Dark palette (familiar to devs,
          // high contrast on dark background, not garish neon).
          black: "#0d1117",
          red: "#ff7b72",
          green: "#3fb950",
          yellow: "#d29922",
          blue: "#58a6ff",
          magenta: "#bc8cff",
          cyan: "#39c5cf",
          white: "#e6edf3",
          brightBlack: "#484f58",
          brightRed: "#ffa198",
          brightGreen: "#56d364",
          brightYellow: "#e3b341",
          brightBlue: "#79c0ff",
          brightMagenta: "#d2a8ff",
          brightCyan: "#56d4dd",
          brightWhite: "#ffffff",
        },
        scrollback: 10_000,
        allowTransparency: false,
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);
      fit.fit();

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

      // Device → terminal pump. xterm.write() takes a Uint8Array and
      // handles UTF-8 decoding internally, so we hand it the raw bytes
      // straight from the stream.
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
          // The .finally() below updates the status badge.
        }
      })();

      // Terminal → device pump. Reuse one writer across all onData
      // events (creating a fresh writer per keystroke would add latency).
      const writer = pty.input.getWriter();
      const dataDisp = term.onData((data) => {
        writer.write(new TextEncoder().encode(data)).catch(() => {});
      });

      // Sync terminal dimensions to the device whenever the panel resizes
      // (window resize, sidebar collapse, etc.). xterm in `fit.fit()`
      // re-measures the pixel size and reports new cols/rows.
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
        dataDisp.dispose();
        try {
          pty.kill();
        } catch {
          /* already dead */
        }
        writer.releaseLock();
        reader.cancel().catch(() => {});
        term.dispose();
      };
      handle = { term, fit, pty, writer, reader, cleanup };
      handleRef.current = handle;
      setStatus("running");

      // If the PTY dies (device unplugged, adb daemon stopped, etc.),
      // surface that to the user so they know to hit Restart.
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
    <section className="panel">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h2 style={{ margin: 0 }}>Shell</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={status} />
          {status === "stopped" && (
            <button onClick={() => setRemountKey((k) => k + 1)} className="primary">
              Restart
            </button>
          )}
        </div>
      </div>
      <p className="panel-desc" style={{ marginBottom: 10 }}>
        Interactive shell on the device. Ctrl+C, arrow keys, and Tab
        completion work — anything that needs a real terminal.
      </p>
      {/* `key` on the container forces React to fully unmount the div on
          remount, which in turn re-runs the setup effect and opens a
          fresh PTY. This is the simplest reliable restart mechanism. */}
      <div
        key={remountKey}
        ref={containerRef}
        className="xterm-container"
        style={{
          height: 480,
          // Always dark — contrast with both light/dark page themes.
          background: "#0d1117",
          border: "1px solid var(--border)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      />
    </section>
  );
}

function StatusBadge({ status }: { status: "starting" | "running" | "stopped" }) {
  const map = {
    starting: { color: "var(--warning)", text: "starting" },
    running: { color: "var(--success)", text: "connected" },
    stopped: { color: "var(--danger)", text: "disconnected" },
  } as const;
  const { color, text } = map[status];
  return (
    <span
      style={{
        fontSize: 12,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
        }}
      />
      {text}
    </span>
  );
}