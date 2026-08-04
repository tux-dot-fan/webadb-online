"use client";

import { useState, type ChangeEvent } from "react";
import type { AdbSession } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

export function ApkInstallPanel({ session }: Props) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!f) return;
    setError(null);
    setLast(null);
    setBusy(true);
    setProgress(`Reading ${f.name} (${formatBytes(f.size)})…`);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      setProgress(`Pushing ${f.name}…`);
      const remotePath = `/data/local/tmp/${f.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      const sync = await session.adb.sync();
      await sync.write({
        filename: remotePath,
        // `file` accepts a Web ReadableStream<MaybeConsumable<Uint8Array>>.
        // The cast is safe: we only ever enqueue Uint8Array (which is the
        // non-Consumable variant of MaybeConsumable).
        file: new ReadableStream({
          start(controller) {
            controller.enqueue(buf);
            controller.close();
          },
        }) as unknown as Parameters<typeof sync.write>[0]["file"],
      });
      setProgress(`Installing via pm install…`);
      const shell = session.adb.subprocess.shellProtocol;
      if (!shell) {
        throw new Error("Device doesn't support Shell V2 protocol");
      }
      const result = await shell.spawnWaitText([
        "pm",
        "install",
        "-r",
        "-t",
        remotePath,
      ]);
      if (!/Success/i.test(result.stdout)) {
        throw new Error(`pm install returned:\n${result.stdout.trim()}`);
      }
      setLast(`Installed ${f.name} → ${result.stdout.trim()}`);
      setProgress(null);
      // Clean up the temp file (best effort).
      shell
        .spawnWaitText(["rm", "-f", remotePath])
        .catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Install APK</h2>
      <p className="panel-desc">
        Pick a <code>.apk</code> from your computer. It streams over USB to{" "}
        <code>/data/local/tmp</code>, then <code>pm install</code> runs on the device.
        Existing apps are replaced (<code>-r</code>) and test-only APKs allowed (<code>-t</code>).
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="primary" style={{
          display: "inline-block",
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
          padding: "8px 14px",
          borderRadius: 6,
          background: "var(--accent)",
          color: "#0b0f17",
          fontWeight: 600,
          border: "1px solid var(--accent)",
        }}>
          {busy ? "Working…" : "Choose APK"}
          <input
            type="file"
            accept=".apk,application/vnd.android.package-archive,application/octet-stream"
            onChange={(e) => void onPick(e)}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
        <span className="muted" style={{ fontSize: 13 }}>
          File never leaves your browser.
        </span>
      </div>

      {progress && (
        <div className="banner info" style={{ margin: 0 }}>
          {progress}
        </div>
      )}
      {error && (
        <div className="banner error" style={{ margin: 0 }}>
          {error}
        </div>
      )}
      {last && (
        <div className="banner info" style={{ margin: 0, color: "var(--success)", borderColor: "rgba(81,216,138,0.3)", background: "rgba(81,216,138,0.08)" }}>
          {last}
        </div>
      )}
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}