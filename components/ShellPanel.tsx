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
  /** Shell command to run immediately after the PTY starts (e.g. "cd /sdcard"). */
  initialCommand?: string;
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

export function ShellPanel({ session, initialCommand }: Props) {
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

      // Terminal palette adapts to the page theme so text is always legible.
      // Light page bg = light terminal; dark page bg = dark terminal.
      // We read the current value at setup and watch for flips via
      // MutationObserver so the terminal updates if the user toggles theme.
      function getPageTheme(): "light" | "dark" {
        return (document.documentElement.getAttribute("data-theme") as "light" | "dark") ?? "light";
      }

      const LIGHT_THEME = {
        background: "#ffffff",
        foreground: "#1c2433",
        cursor: "#1c2433",
        selectionBackground: "rgba(37, 99, 235, 0.2)",
        black: "#1c2433",
        red: "#dc2626",
        green: "#15803d",
        yellow: "#b45309",
        blue: "#2563eb",
        magenta: "#7c3aed",
        cyan: "#0891b2",
        white: "#e6ebf5",
        brightBlack: "#5a657a",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#f59e0b",
        brightBlue: "#3b82f6",
        brightMagenta: "#8b5cf6",
        brightCyan: "#06b6d4",
        brightWhite: "#ffffff",
      };

      const DARK_THEME = {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#e6edf3",
        selectionBackground: "rgba(78, 161, 255, 0.25)",
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
      };

      const term = new Terminal({
        fontSize: 14,
        fontFamily:
          '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
        fontWeight: "400",
        fontWeightBold: "700",
        cursorBlink: true,
        cursorStyle: "block",
        theme: getPageTheme() === "dark" ? DARK_THEME : LIGHT_THEME,
        scrollback: 10_000,
        allowTransparency: false,
        convertEol: true,
      });

      // Keep the container bg in sync with the terminal bg, so there's no
      // flash when the theme toggles while the panel is open.
      const containerBg =
        getPageTheme() === "dark" ? "#0d1117" : "#ffffff";
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

      // If an initialCommand was provided, send it after the shell prompt
      // appears (~120ms delay lets the device render its prompt first).
      if (initialCommand) {
        setTimeout(() => {
          const cmd = initialCommand + "\n";
          writer.write(new TextEncoder().encode(cmd)).catch(() => {});
        }, 120);
      }
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
        themeObserver.disconnect();
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
      {/* `key` on the container forces React to fully unmount the div on
          remount, which in turn re-runs the setup effect and opens a
          fresh PTY. This is the simplest reliable restart mechanism. */}
      <div
        key={remountKey}
        ref={containerRef}
        className="xterm-container panel-fill"
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