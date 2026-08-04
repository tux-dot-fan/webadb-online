"use client";

import { useState, useEffect, useRef } from "react";
import type { AdbSession } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

/**
 * Screen capture via adb shell `screencap -p` which returns a PNG. We use the
 * shell protocol because framebuffer() returns the raw RGBA bytes (no PNG
 * header, no compression) — decoding those on the canvas requires per-device
 * color-space handling. Screencap is one stream pipe and works on every
 * Android version.
 */
export function ScreenshotPanel({ session }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the last object URL so we can revoke it on next capture.
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, []);

  async function capture() {
    setBusy(true);
    setError(null);
    try {
      const shell = session.adb.subprocess.shellProtocol;
      if (!shell) {
        throw new Error("Device doesn't support Shell V2 protocol");
      }
      // spawnWaitText would decode as text — we need raw bytes.
      const proc = await shell.spawn(["screencap", "-p"]);
      // Read stdout as a stream and accumulate to a Blob.
      const reader = proc.stdout.getReader();
      const parts: BlobPart[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) parts.push(value as BlobPart);
      }
      const blob = new Blob(parts, { type: "image/png" });
      const obj = URL.createObjectURL(blob);
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      lastUrl.current = obj;
      setUrl(obj);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Screenshot</h2>
      <p className="panel-desc">
        Captures the current display via <code>screencap -p</code>. PNG is
        rendered entirely from device-side compression — no framebuffer server
        needed.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" onClick={() => void capture()} disabled={busy}>
          {busy ? "Capturing…" : "Capture"}
        </button>
        {url && (
          <a href={url} download={`screenshot-${Date.now()}.png`}>
            <button>Download PNG</button>
          </a>
        )}
      </div>

      {error && (
        <div className="banner error" style={{ margin: "0 0 12px" }}>
          {error}
        </div>
      )}

      {url && (
        <img
          src={url}
          alt="device screenshot"
          style={{
            maxWidth: "100%",
            border: "1px solid var(--border)",
            borderRadius: 8,
            display: "block",
          }}
        />
      )}
    </section>
  );
}