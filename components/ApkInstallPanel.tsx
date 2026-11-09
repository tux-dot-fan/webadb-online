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
      // Sanitize the filename for the device path and make sure it
      // still ends in .apk — `pm install` is happier with a proper
      // extension, and some devices reject anything else outright.
      const safeName = f.name.replace(/[^A-Za-z0-9._-]/g, "_");
      const remotePath = `/data/local/tmp/${
        safeName.toLowerCase().endsWith(".apk") ? safeName : `${safeName}.apk`
      }`;
      await session.adb.sync.write({
        filename: remotePath,
        // `file` accepts a Web ReadableStream<MaybeConsumable<Uint8Array>>.
        // We wrap our raw Uint8Array in a single-shot stream. The cast is
        // safe: Uint8Array is the non-Consumable variant of MaybeConsumable.
        file: new ReadableStream({
          start(controller) {
            controller.enqueue(buf);
            controller.close();
          },
        }) as unknown as Parameters<typeof session.adb.sync.write>[0]["file"],
      });
      setProgress(`Installing via pm install…`);
      const shell = session.adb.subprocess.shellProtocol;
      if (!shell || !shell.isSupported) {
        throw new Error("Device doesn't support Shell V2 protocol");
      }

      // Dump the device's own `pm install --help` once per session. The
      // supported flag set varies across Android versions and OEM skins
      // (HyperOS in particular), and reading it beats guessing. The
      // output is attached to any failure so the user can see exactly
      // which flags their build accepts.
      let helpText = "";
      try {
        const helpRes = await shell.spawn(["pm", "install", "--help"]).wait();
        helpText = (await helpRes.stdout.toString()).trim();
      } catch {
        /* some builds reject --help outright — fine */
      }

      // Flags:
      //   -r  replace an existing installation (keep data)
      //   -t  allow an APK marked android:testOnly="true"
      //   -d  allow a version downgrade (INSTALL_FAILED_VERSION_DOWNGRADE)
      //   -g  grant every runtime permission at install time
      //   --user 0  install for the primary user
      // Note: we deliberately do NOT pass -s. `-s` means "install on shared
      // storage", which Android 11+ rejects for third-party APKs
      // (INSTALL_FAILED_INVALID_INSTALL_LOCATION) and which puts the app
      // in a place the launcher doesn't index.
      const installArgs = [
        "pm", "install",
        "-r",
        "-t",
        "-d",
        "-g",
        "--user", "0",
        remotePath,
      ];
      const result = shell.spawn(installArgs);
      const waitResult = await result.wait();
      let stdout = await waitResult.stdout.toString();
      let stderr = await waitResult.stderr.toString();

      // Some devices reject `--user 0` or `-g` in combination with other
      // flags even though each one is valid on its own. If the full flag
      // set failed, retry with the bare minimum that matches a plain
      // `adb shell pm install -r <path>` on the command line.
      let usedArgs = installArgs;
      if (waitResult.exitCode !== 0 && !/Success/i.test(stdout)) {
        setProgress("Install failed with extended flags — retrying minimally…");
        const fallbackArgs = ["pm", "install", "-r", remotePath];
        const retry = shell.spawn(fallbackArgs);
        const retryResult = await retry.wait();
        const retryOut = await retryResult.stdout.toString();
        const retryErr = await retryResult.stderr.toString();
        if (retryResult.exitCode === 0 && /Success/i.test(retryOut)) {
          usedArgs = fallbackArgs;
          stdout = retryOut;
          stderr = retryErr;
        } else {
          // Keep the original error but mention the retry also failed.
          stderr =
            `${stderr}\n(retry with ${fallbackArgs.join(" ")} also failed: ` +
            `${(retryOut.trim() || retryErr.trim() || "no output")})`;
        }
      }

      if (waitResult.exitCode !== 0 || !/Success/i.test(stdout)) {
        // `pm install` reports failures on stdout, not stderr, and the
        // useful part is the INSTALL_FAILED_* token. Surface the whole
        // output plus a stat of the staged file so the user can tell
        // "the APK is bad" from "the device can't read the file".
        let statOut = "";
        try {
          const statRes = await shell
            .spawn(["ls", "-lZ", remotePath])
            .wait();
          statOut = await statRes.stdout.toString();
        } catch {
          /* best effort */
        }
        throw new Error(
          `pm install failed (exit ${waitResult.exitCode})\n\n` +
            `Command: ${usedArgs.join(" ")}\n\n` +
            `Output:\n${(stdout.trim() || stderr.trim() || "(no output)")}\n` +
            (statOut.trim() ? `\nStaged file:\n${statOut.trim()}` : "") +
            (helpText
              ? `\n\nThis device supports these pm install flags:\n${helpText}`
              : "") +
            `\n\nIf this says INSTALL_PARSE_FAILED_NO_COLLECTED_CERTIFICATES ` +
            `the staged file may be truncated or unreadable — try a ` +
            `different APK. If it says INSTALL_FAILED_UPDATE_INCOMPATIBLE ` +
            `the signing key differs from the installed app — uninstall ` +
            `it first.`,
        );
      }
      setLast(`Installed ${f.name} → ${stdout.trim()}`);
      setProgress(null);
      // Clean up the temp file (best effort).
      shell.spawn(["rm", "-f", remotePath]).wait().catch(() => {});
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
        Flags used: <code>-r</code> (replace existing, keep data), <code>-t</code>
        (allow test-only APKs), <code>-d</code> (allow downgrade), <code>-g</code>
        (grant runtime permissions), <code>--user 0</code>. If that fails the
        installer retries with a bare <code>pm install -r</code>.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="primary" style={{
          display: "inline-block",
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
          padding: "8px 14px",
          borderRadius: 6,
          background: "var(--accent)",
          color: "var(--on-accent)",
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