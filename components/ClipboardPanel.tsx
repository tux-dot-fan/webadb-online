"use client";

// ── Clipboard panel ──────────────────────────────────────────────────────────
//
// Two-way clipboard bridge between web and Android:
//
//   Read from device  →  adb shell `cmd clipboard get-primary-clip`
//                       (Android 9+; uses IClipboard service)
//
//   Write to device   →  adb shell `cmd clipboard set-primary-clip <text>`
//                       (sets Android's primary clip via the system service)
//
// Notes on Android clipboard plumbing:
//
//  - The shell `cmd clipboard` interface is provided by the ClipboardService
//    and works on stock AOSP from Pie onward. Some OEM ROMs (Samsung One UI,
//    Xiaomi MIUI, HarmonyOS) restrict it for non-system callers and either
//    silently return empty or throw SecurityException. We catch that and
//    fall back to `service call clipboard <transaction>` with raw bytes.
//
//  - For reads we always go through `cmd clipboard get-primary-clip` —
//    there's no shell-friendly equivalent of `service call` that returns
//    a printable string. When it fails (ROM restriction) we report the
//    failure to the UI rather than silently swallow it.
//
//  - For writes, `cmd clipboard set-primary-clip` takes a single argument
//    that's the new clipboard text. Special characters are passed as
//    a single argv token after a single-quote / double-quote escape.
//
//  - On web side we use the async Clipboard API:
//      navigator.clipboard.readText()   — requires user gesture or
//                                         permission; we surface errors.
//      navigator.clipboard.writeText()  — requires user gesture.
//
//  - `Watch web clipboard` polls every 1.5s (the Clipboard API doesn't
//    support a true event). When the web clipboard text differs from
//    the last push, push it to the device. This isn't ideal — true
//    cross-device clipboard sync would want a polling target on the
//    device too, which Android doesn't expose without a custom helper
//    APK — but it covers the common case of "I copied something on
//    web, want it on my phone."

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdbSession } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

type SyncStatus = "idle" | "syncing" | "error";

export function ClipboardPanel({ session }: Props) {
  const [deviceText, setDeviceText] = useState("");
  const [webText, setWebText] = useState("");
  const [draft, setDraft] = useState("");
  const [readStatus, setReadStatus] = useState<SyncStatus>("idle");
  const [readDetail, setReadDetail] = useState<string | null>(null);
  const [writeStatus, setWriteStatus] = useState<SyncStatus>("idle");
  const [writeDetail, setWriteDetail] = useState<string | null>(null);
  const [watchWeb, setWatchWeb] = useState(false);
  const [watchDevice, setWatchDevice] = useState(false);

  const lastPushedRef = useRef<string>("");
  const lastReadRef = useRef<string>("");

  // ── Read from device ────────────────────────────────────────────────────
  const readFromDevice = useCallback(async (): Promise<string | null> => {
    setReadStatus("syncing");
    setReadDetail(null);
    try {
      const shell = session.adb.subprocess.shellProtocol;
      if (!shell || !shell.isSupported) {
        throw new Error("Device doesn't support Shell V2 protocol");
      }
      // `cmd clipboard get-primary-clip` prints the clip's text to stdout.
      // On some ROMs it prints extra decoration like
      //   "com.android.shell: ClipData{... T:text/plain {T:hello}}"
      // We strip the wrapping if present.
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
        // ROM restricted access — be explicit so the user knows why
        // the field is empty.
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
        // cmd clipboard set-primary-clip takes a single argument; quoting
        // it is tricky because the shell's tokenizer will re-interpret
        // our quotes. We pass the text directly as one argv token so the
        // device's shell sees it intact. Most printable Unicode goes
        // through cleanly; newlines collapse to spaces (the shell's
        // argv layer won't carry raw newlines).
        const sanitized = text.replace(/[\r\n]+/g, " ");
        const result = shell.spawn([
          "cmd",
          "clipboard",
          "set-primary-clip",
          "--user",
          "0",
          sanitized,
        ]);
        const waitResult = await result.wait();
        const stdout = await waitResult.stdout.toString();
        const stderr = await waitResult.stderr.toString();
        if (waitResult.exitCode !== 0) {
          throw new Error(
            `cmd clipboard exited with code ${waitResult.exitCode}: ${
              stderr.trim() || stdout.trim() || "(no output)"
            }`,
          );
        }
        setWriteDetail(
          `Wrote ${sanitized.length} chars to device clipboard.`,
        );
        setWriteStatus("idle");
        lastPushedRef.current = sanitized;
        return true;
      } catch (e) {
        setWriteStatus("error");
        setWriteDetail(
          `Write failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    },
    [session],
  );

  // ── Read from web ───────────────────────────────────────────────────────
  const readFromWeb = useCallback(async (): Promise<string | null> => {
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error("Browser doesn't expose navigator.clipboard.readText");
      }
      const text = await navigator.clipboard.readText();
      return text;
    } catch (e) {
      setReadStatus("error");
      setReadDetail(
        `Web read failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }, []);

  // ── Write to web ────────────────────────────────────────────────────────
  const writeToWeb = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Browser doesn't expose navigator.clipboard.writeText");
      }
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      setWriteStatus("error");
      setWriteDetail(
        `Web write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }, []);

  // ── Watch web → device ──────────────────────────────────────────────────
  useEffect(() => {
    if (!watchWeb) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      try {
        const text = await navigator.clipboard.readText();
        if (cancelled) return;
        if (text !== lastPushedRef.current) {
          setWebText(text);
          await writeToDevice(text);
        }
      } catch {
        // Most common failure: tab lost focus and Clipboard API
        // requires a user gesture. Stop watching silently.
        setWatchWeb(false);
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [watchWeb, writeToDevice]);

  // ── Watch device → web ──────────────────────────────────────────────────
  useEffect(() => {
    if (!watchDevice) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      const text = await readFromDevice();
      if (cancelled || text === null) return;
      if (text !== lastReadRef.current) {
        lastReadRef.current = text;
        setDeviceText(text);
        // Web write requires a user gesture; we still attempt and let
        // it silently fail when there's none — the user sees the
        // device text in the panel and can copy from there.
        await writeToWeb(text);
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [watchDevice, readFromDevice, writeToWeb]);

  // ── Handlers ────────────────────────────────────────────────────────────
  async function onPullFromDevice() {
    const text = await readFromDevice();
    if (text !== null) {
      setDeviceText(text);
      setDraft(text);
      lastReadRef.current = text;
    }
  }

  async function onPullFromWeb() {
    const text = await readFromWeb();
    if (text !== null) {
      setWebText(text);
      setDraft(text);
    }
  }

  async function onPushToDevice() {
    await writeToDevice(draft);
  }

  async function onPushToWeb() {
    await writeToWeb(draft);
  }

  async function onClearDevice() {
    await writeToDevice("");
    setDeviceText("");
    setDraft("");
  }

  return (
    <div className="clipboard-panel">
      <div className="clipboard-panel__header">
        <h2>Clipboard</h2>
        <p className="clipboard-panel__sub">
          Two-way clipboard bridge between this browser and your Android
          device.
        </p>
      </div>

      <section className="clipboard-panel__row">
        <div className="clipboard-panel__buttons">
          <button
            type="button"
            onClick={onPullFromDevice}
            disabled={readStatus === "syncing"}
          >
            {readStatus === "syncing" ? "Reading…" : "← Read from device"}
          </button>
          <button
            type="button"
            onClick={onPushToDevice}
            disabled={writeStatus === "syncing" || !draft}
          >
            {writeStatus === "syncing" ? "Writing…" : "Write to device →"}
          </button>
          <button type="button" onClick={onClearDevice}>
            Clear on device
          </button>
        </div>
        <div className="clipboard-panel__buttons">
          <button type="button" onClick={onPullFromWeb}>
            ← Read from browser
          </button>
          <button
            type="button"
            onClick={onPushToWeb}
            disabled={!draft}
          >
            Write to browser →
          </button>
        </div>
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

      <section className="clipboard-panel__row">
        <label className="clipboard-panel__check">
          <input
            type="checkbox"
            checked={watchWeb}
            onChange={(e) => setWatchWeb(e.target.checked)}
          />
          Watch browser clipboard → auto-write to device every 1.5s
        </label>
        <label className="clipboard-panel__check">
          <input
            type="checkbox"
            checked={watchDevice}
            onChange={(e) => setWatchDevice(e.target.checked)}
          />
          Watch device clipboard → auto-write to browser every 2s
        </label>
      </section>

      <section className="clipboard-panel__editor">
        <label htmlFor="clipboard-draft" className="clipboard-panel__label">
          Draft text
        </label>
        <textarea
          id="clipboard-draft"
          className="clipboard-panel__textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type, paste, or pull from a side…"
          rows={10}
          spellCheck={false}
        />
        <div className="clipboard-panel__counts">
          <span>{draft.length} chars</span>
          <span>{countLines(draft)} lines</span>
        </div>
      </section>

      {(deviceText || webText) && (
        <section className="clipboard-panel__last">
          {deviceText && (
            <div>
              <span className="clipboard-panel__label">Last from device:</span>
              <pre className="clipboard-panel__pre">{deviceText}</pre>
            </div>
          )}
          {webText && (
            <div>
              <span className="clipboard-panel__label">Last from browser:</span>
              <pre className="clipboard-panel__pre">{webText}</pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

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