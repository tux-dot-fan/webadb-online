"use client";

// ── Clipboard panel ──────────────────────────────────────────────────────────
//
// Push-style clipboard bridge between web and Android. We deliberately do
// NOT watch the browser's clipboard: that requires either a user gesture
// every time the user copies (most browsers revoke clipboard access on
// tab-blur) or a hidden iframe hack that Chrome has been slowly
// patching out. The user pastes into the textarea and explicitly sends.
//
// Direction:
//
//   Web → device:  user pastes/types in the textarea, clicks
//                  "Send to device". We run
//                    cmd clipboard set-primary-clip --user 0 <text>
//                  Newlines collapse to spaces — the shell's argv layer
//                  won't carry raw \n bytes, and 'cmd clipboard' has
//                  no other input mode.
//
//   Device → web:  we poll the device clipboard every 2 s and append
//                  anything new to an in-panel history list. We never
//                  write the device text back into navigator.clipboard
//                  (that would clobber whatever the user just copied
//                  in the browser, which is the opposite of helpful).
//
// Android clipboard plumbing notes:
//
//   - 'cmd clipboard get-primary-clip' is provided by IClipboardService
//     on stock AOSP from Pie onward. It prints the clip's text wrapped
//     in a ClipData debug string:
//        com.android.shell: ClipData{ ... T:text/plain {T:hello} }
//     parseClipboardOutput strips that wrapper and unescapes \n / \r /
//     \t / \\ that the ClipData string format inserts.
//
//   - Some OEM ROMs (Samsung One UI, Xiaomi MIUI, HarmonyOS) restrict
//     non-system callers from reading the clipboard. The read path
//     catches that case and reports it in the panel; we never silently
//     pretend the device has an empty clipboard.
//
//   - Polling at 2 s is fast enough to feel "live" while still being
//     cheap. The screenrecord-style "1-second latency" budget doesn't
//     apply here: clipboard changes aren't continuous like a video
//     stream, and over-polling would hammer Binder transactions on
//     a foreground shell session.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdbSession } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

type Status = "idle" | "syncing" | "error";

interface HistoryEntry {
  /** Origin — what side the text came from. */
  source: "device" | "web";
  /** Wall-clock timestamp the entry was recorded. */
  ts: number;
  /** Text payload. */
  text: string;
}

export function ClipboardPanel({ session }: Props) {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [readStatus, setReadStatus] = useState<Status>("idle");
  const [readDetail, setReadDetail] = useState<string | null>(null);
  const [writeStatus, setWriteStatus] = useState<Status>("idle");
  const [writeDetail, setWriteDetail] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  /** Last device-clipboard value we observed, used to dedupe. */
  const lastDeviceTextRef = useRef<string>("");
  /** Tracks whether the read-on-mount attempt has been kicked off. */
  const bootstrappedRef = useRef(false);

  // ── Read from device ────────────────────────────────────────────────────
  const readFromDevice = useCallback(async (): Promise<string | null> => {
    setReadStatus("syncing");
    setReadDetail(null);
    try {
      const shell = session.adb.subprocess.shellProtocol;
      if (!shell || !shell.isSupported) {
        throw new Error("Device doesn't support Shell V2 protocol");
      }
      // `cmd clipboard get-primary-clip` prints the clip to stdout.
      // Some ROMs print extra decoration like
      //   "com.android.shell: ClipData{... T:text/plain {T:hello}}"
      // parseClipboardOutput strips the wrapper.
      const proc = await shell.spawn([
        "cmd",
        "clipboard",
        "get-primary-clip",
        "--user",
        "0",
      ]);
      const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>)
        .getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let out = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
      } finally {
        reader.releaseLock();
        try {
          void proc.kill();
        } catch {
          /* ignore */
        }
      }
      const text = parseClipboardOutput(out);
      if (text === null) {
        setReadDetail(
          "Device returned no clipboard text. The ROM may restrict " +
            "non-system apps from reading the clipboard.",
        );
      } else {
        setReadDetail(`Read ${text.length} chars from device.`);
      }
      setReadStatus("idle");
      return text;
    } catch (e) {
      setReadStatus("error");
      setReadDetail(
        `Read failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }, [session]);

  // ── Write to device ─────────────────────────────────────────────────────
  const writeToDevice = useCallback(
    async (text: string): Promise<boolean> => {
      setWriteStatus("syncing");
      setWriteDetail(null);
      try {
        const shell = session.adb.subprocess.shellProtocol;
        if (!shell || !shell.isSupported) {
          throw new Error("Device doesn't support Shell V2 protocol");
        }
        // Newlines collapse to spaces because the shell's argv layer
        // won't carry raw \n bytes — a limitation of the cmd clipboard
        // interface, not us.
        const sanitized = text.replace(/[\r\n]+/g, " ");

        // ── Strategy ─────────────────────────────────────────────────
        // 1. cmd clipboard set-primary-clip --user 0 <text>   (AOSP 9+)
        // 2. cmd clipboard set-primary-clip <text>            (older)
        // 3. cmd clipboard set <text>                          (legacy)
        // 4. service call clipboard 2 ...                      (raw Binder,
        //    hex-encoded payload — works on every Android but is fragile)
        // ──────────────────────────────────────────────────────
        const attempts: Array<{
          label: string;
          argv: string[];
        }> = [
          {
            label: "cmd clipboard set-primary-clip --user 0",
            argv: [
              "cmd",
              "clipboard",
              "set-primary-clip",
              "--user",
              "0",
              sanitized,
            ],
          },
          {
            label: "cmd clipboard set-primary-clip",
            argv: ["cmd", "clipboard", "set-primary-clip", sanitized],
          },
          {
            label: "cmd clipboard set",
            argv: ["cmd", "clipboard", "set", sanitized],
          },
        ];

        let lastError = "";
        for (const attempt of attempts) {
          const r = shell.spawn(attempt.argv);
          const waitResult = await r.wait();
          const stdout = await waitResult.stdout.toString();
          const stderr = await waitResult.stderr.toString();
          if (waitResult.exitCode === 0) {
            setWriteDetail(
              `Wrote ${sanitized.length} chars to device clipboard ` +
                `(via ${attempt.label}).`,
            );
            setWriteStatus("idle");
            setHistory((prev) =>
              appendEntry(prev, {
                source: "web",
                ts: Date.now(),
                text: sanitized,
              }),
            );
            return true;
          }
          lastError = `${attempt.label} → exit ${waitResult.exitCode}: ${
            stderr.trim() || stdout.trim() || "(no output)"
          }`;
        }

        throw new Error(
          `All write strategies failed. Last error: ${lastError}`,
        );
      } catch (e) {
        setWriteStatus("error");
        setWriteDetail(
          `Write failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    },
    [],
  );

  // ── Bootstrap: read device clipboard once when the panel mounts ────────
  // We don't auto-show it (the user might want to keep their existing
  // history clean), but we record the baseline so subsequent polls can
  // detect changes.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void (async () => {
      const text = await readFromDevice();
      if (text !== null) {
        lastDeviceTextRef.current = text;
        // Seed the history with the current device content so the
        // first thing the user sees is "what's already on the phone".
        setHistory((prev) =>
          appendEntry(prev, {
            source: "device",
            ts: Date.now(),
            text,
          }),
        );
        setReadDetail(
          `Read ${text.length} chars from device (initial snapshot).`,
        );
      }
    })();
  }, [readFromDevice]);

  // ── Poll device clipboard ──────────────────────────────────────────────
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      const text = await readFromDevice();
      if (cancelled || text === null) return;
      if (text !== lastDeviceTextRef.current) {
        lastDeviceTextRef.current = text;
        setHistory((prev) =>
          appendEntry(prev, {
            source: "device",
            ts: Date.now(),
            text,
          }),
        );
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [polling, readFromDevice]);

  // ── Handlers ────────────────────────────────────────────────────────────
  async function onSend() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const ok = await writeToDevice(trimmed);
    if (ok) {
      // Clear the draft on success — the text is now in device
      // history, no need to keep it in the input.
      setDraft("");
    }
  }

  async function onPullDevice() {
    const text = await readFromDevice();
    if (text !== null) {
      lastDeviceTextRef.current = text;
      setHistory((prev) =>
        appendEntry(prev, {
          source: "device",
          ts: Date.now(),
          text,
        }),
      );
    }
  }

  function onPasteFromWeb() {
    // Use the Clipboard API but require a user gesture (this is
    // called from a button click, so it satisfies the policy).
    if (!navigator.clipboard?.readText) {
      setReadStatus("error");
      setReadDetail("Browser doesn't expose navigator.clipboard.readText");
      return;
    }
    navigator.clipboard.readText()
      .then((text) => {
        setDraft(text);
        setHistory((prev) =>
          appendEntry(prev, {
            source: "web",
            ts: Date.now(),
            text: `[copied locally, ${text.length} chars]`,
          }),
        );
      })
      .catch((e) => {
        setReadStatus("error");
        setReadDetail(
          `Web paste failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  function onClearHistory() {
    setHistory([]);
  }

  return (
    <div className="clipboard-panel">
      <div className="clipboard-panel__header">
        <h2>Clipboard</h2>
        <p className="clipboard-panel__sub">
          Paste from the browser, send to the device. Or watch the device
          clipboard for changes and capture them into history.
        </p>
      </div>

      <section className="clipboard-panel__row">
        <div className="clipboard-panel__buttons">
          <button type="button" onClick={onPasteFromWeb}>
            Paste from browser
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={writeStatus === "syncing" || !draft.trim()}
            className="clipboard-panel__primary"
          >
            {writeStatus === "syncing" ? "Sending…" : "Send to device"}
          </button>
          <button
            type="button"
            onClick={onPullDevice}
            disabled={readStatus === "syncing"}
          >
            {readStatus === "syncing" ? "Reading…" : "Pull from device"}
          </button>
        </div>
        <label className="clipboard-panel__check">
          <input
            type="checkbox"
            checked={polling}
            onChange={(e) => setPolling(e.target.checked)}
          />
          Watch device clipboard (every 2s, append new entries to history)
        </label>
        {(readDetail || writeDetail) && (
          <div className="clipboard-panel__status">
            {readStatus === "error" && (
              <span className="clipboard-panel__error">{readDetail}</span>
            )}
            {readStatus === "idle" && readDetail && (
              <span>{readDetail}</span>
            )}
            {writeStatus === "error" && (
              <span className="clipboard-panel__error">{writeDetail}</span>
            )}
            {writeStatus === "idle" && writeDetail && (
              <span>{writeDetail}</span>
            )}
          </div>
        )}
      </section>

      <section className="clipboard-panel__editor">
        <label htmlFor="clipboard-draft" className="clipboard-panel__label">
          Send to device
        </label>
        <textarea
          id="clipboard-draft"
          className="clipboard-panel__textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Paste here, then press Send to device."
          rows={6}
          spellCheck={false}
        />
        <div className="clipboard-panel__counts">
          <span>{draft.length} chars</span>
          <span>{countLines(draft)} lines</span>
        </div>
      </section>

      <section className="clipboard-panel__history">
        <div className="clipboard-panel__history-header">
          <span className="clipboard-panel__label">
            History ({history.length})
          </span>
          <button
            type="button"
            onClick={onClearHistory}
            disabled={history.length === 0}
            className="clipboard-panel__clear"
          >
            Clear
          </button>
        </div>
        <div className="clipboard-panel__history-list">
          {history.length === 0 ? (
            <p className="clipboard-panel__empty">No history yet.</p>
          ) : (
            history.map((entry, idx) => (
              <HistoryItem key={`${entry.ts}-${idx}`} entry={entry} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function HistoryItem({ entry }: { entry: HistoryEntry }) {
  const time = new Date(entry.ts);
  const ago = relativeTime(entry.ts);
  return (
    <div
      className={
        entry.source === "device"
          ? "clipboard-panel__history-item clipboard-panel__history-item--device"
          : "clipboard-panel__history-item clipboard-panel__history-item--web"
      }
    >
      <div className="clipboard-panel__history-meta">
        <span className="clipboard-panel__history-source">
          {entry.source === "device" ? "← device" : "→ device"}
        </span>
        <span className="clipboard-panel__history-time" title={time.toLocaleString()}>
          {ago}
        </span>
        <span className="clipboard-panel__history-len">
          {entry.text.length} chars
        </span>
      </div>
      <pre className="clipboard-panel__history-text">{entry.text}</pre>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip the `cmd clipboard` wrapper from a get-primary-clip output.
 *
 * The shell output on most ROMs looks like:
 *   com.android.shell: ClipData{ ... T:text/plain {T:hello world} }
 *
 * On other ROMs it's just the raw text. We try to find the trailing
 * `{T:...}` block; if absent we return the trimmed whole output.
 * Returns null when the device reports "no clip" so the UI can show
 * a helpful hint rather than a fake empty string.
 */
function parseClipboardOutput(out: string): string | null {
  const trimmed = out.trim();
  if (!trimmed) return null;
  if (trimmed === "(null)" || /^no clip/i.test(trimmed)) return null;

  // Last `{T:...}` is the leaf text payload per android.content.ClipData.
  const match = /\{T:([\s\S]*)\}\s*$/.exec(trimmed);
  if (match) {
    // ClipData's text representation escapes newlines as `\n` literals,
    // not real \n bytes.
    return match[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }

  // No ClipData wrapping — assume the whole output is the text.
  // Strip a leading "com.android.shell: " if present.
  return trimmed.replace(/^com\.android\.shell:\s*/, "");
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split(/\r\n|\r|\n/).length;
}

/**
 * Append an entry to history. Caps history at 50 entries (newest last)
 * so a long polling session doesn't grow unbounded. The 50-entry cap
 * matches what fits on screen without pagination.
 */
function appendEntry(
  prev: HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  const next = [...prev, entry];
  if (next.length > 50) return next.slice(next.length - 50);
  return next;
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "now";
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  return `${Math.round(diffMs / 3_600_000)}h ago`;
}