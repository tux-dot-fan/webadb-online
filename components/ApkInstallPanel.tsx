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

      // ─────────────────────────────────────────────────────────────────────
      // Strategy: stream the APK into `pm install` over stdin first.
      //
      // `pm install <path>` (the path form) is deprecated. It asks
      // PackageManager — running as system_server — to open the file
      // itself. On modern Android that read is subject to SELinux and
      // to the file's ownership/context, and when it silently yields
      // nothing PackageManager can print "Success" while installing
      // nothing at all. Google's own guidance (issue 80270303,
      // closed as "Intended Behavior") is that the supported forms are
      //   1. host-side `adb install` (streams via install-write /
      //      install-commit), or
      //   2. `cat file.apk | pm install -S <size>` on the device.
      //
      // Form 2 is what we can reach: we pipe the file into pm's stdin
      // and tell pm how many bytes to expect. The read happens in the
      // shell pipeline, so no cross-process file-open permission is
      // involved and no path-based parsing happens at all.
      //
      // We keep the path form as a fallback because some OEM builds
      // still only accept it.
      // ─────────────────────────────────────────────────────────────────────
      const apkSize = buf.byteLength;
      const streamingArgs = [
        "pm", "install",
        "-S", String(apkSize),
        "-r", "-t", "-d", "-g", "--user", "0",
      ];
      let streamFailure = "";
      let streamOut = "";
      let streamErr = "";
      let streamExit: number | null = null;
      try {
        // `shell.spawn()` returns a lazy promise that is BOTH the process
        // (awaitable → AdbShellProtocolProcess with .stdin) and a Wait
        // helper (→ .wait()). Keep the promise so we can use .wait() on
        // it while awaiting it for .stdin.
        const spawnPromise = shell.spawn(streamingArgs);
        const proc = await spawnPromise;
        // Feed the APK into pm's stdin. `pm install -S <n>` reads exactly
        // n bytes from stdin. Writing through the shell protocol's stdin
        // stream means the bytes never touch the filesystem as far as
        // PackageManager is concerned — no SELinux file-read permission
        // required, no path parsing, no truncated-file ambiguity.
        const writer = proc.stdin.getWriter();
        await writer.write(buf);
        await writer.close();
        const streamResult = await spawnPromise.wait().toString();
        streamExit = streamResult.exitCode;
        streamOut = streamResult.stdout ?? "";
        streamErr = streamResult.stderr ?? "";
      } catch (e) {
        streamFailure = e instanceof Error ? e.message : String(e);
      }
      if (streamExit === 0 && /Success/i.test(streamOut)) {
        // `pm install` printing "Success" has not always meant the
        // package landed — verify against the package manager's own
        // listing before we tell the user it worked.
        setProgress("Verifying installation…");
        const pkgName = await readPackageName(shell, remotePath);
        let verified = false;
        if (pkgName) {
          const list = await shell
            .spawn(["pm", "list", "packages", pkgName])
            .wait()
            .toString();
          verified = (list.stdout ?? "").includes(pkgName);
        }
        if (verified) {
          setLast(
            `Installed ${f.name}${pkgName ? ` (${pkgName})` : ""} → ` +
              streamOut.trim(),
          );
        } else {
          setLast(
            `pm install reported "${streamOut.trim()}" but the package ` +
              `was NOT found in the package list afterwards. ` +
              `The APK may be a split/instant app, or the install was ` +
              `rejected silently.`,
          );
        }
        setProgress(null);
        shell.spawn(["rm", "-f", remotePath]).wait().catch(() => {});
        return;
      }
      // Streaming install failed — fall through to the path form and
      // report both results if that fails too.
      if (!streamFailure) {
        streamFailure = (
          streamOut.trim() || streamErr.trim() || "(no output)"
        ).trim();
      }

      // Dump the device's own `pm install --help` once per session. The
      // supported flag set varies across Android versions and OEM skins
      // (HyperOS in particular), and reading it beats guessing. The
      // output is attached to any failure so the user can see exactly
      // which flags their build accepts.
      let helpText = "";
      try {
        // `.wait().toString()` — NOT `.wait()` then `.stdout.toString()`.
        // The former decodes UTF-8 for us; the latter calls
        // Uint8Array.prototype.toString() and yields a comma-separated
        // list of byte values ("83,117,99,99,101,115,115,10" instead of
        // "Success\n").
        const helpRes = await shell
          .spawn(["pm", "install", "--help"])
          .wait()
          .toString();
        helpText = (helpRes.stdout || "").trim();
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
      // `.wait().toString()` gives us decoded UTF-8 strings. See the
      // comment on helpText above for why the order matters.
      const waitResult = await shell.spawn(installArgs).wait().toString();
      let stdout = waitResult.stdout ?? "";
      let stderr = waitResult.stderr ?? "";

      // Some devices reject `--user 0` or `-g` in combination with other
      // flags even though each one is valid on its own. If the full flag
      // set failed, retry with the bare minimum that matches a plain
      // `adb shell pm install -r <path>` on the command line.
      let usedArgs = installArgs;
      if (waitResult.exitCode !== 0 && !/Success/i.test(stdout)) {
        setProgress("Install failed with extended flags — retrying minimally…");
        const fallbackArgs = ["pm", "install", "-r", remotePath];
        const retryResult = await shell
          .spawn(fallbackArgs)
          .wait()
          .toString();
        const retryOut = retryResult.stdout ?? "";
        const retryErr = retryResult.stderr ?? "";
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
            .wait()
            .toString();
          statOut = statRes.stdout ?? "";
        } catch {
          /* best effort */
        }
        throw new Error(
          `pm install failed (exit ${waitResult.exitCode})\n\n` +
            (streamFailure
              ? `Streaming install (pm install -S <size>) also failed:\n${streamFailure}\n\n`
              : "") +
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

/**
 * Best-effort: figure out the package name of a staged APK so we can
 * verify the install actually landed.
 *
 * `aapt2 dump badging` is the proper tool but isn't present on every
 * device (it ships from API 24 and is often missing from OEM images).
 * Fall back to `pm list packages -f` — the `-f` form prints
 * "package:/data/app/.../base.apk=com.example.app", and we can match
 * on the APK's basename. That's imprecise but good enough for a
 * post-install sanity check.
 */
async function readPackageName(
  shell: NonNullable<
    AdbSession["adb"]["subprocess"]["shellProtocol"]
  >,
  remotePath: string,
): Promise<string | null> {
  const base = remotePath.split("/").pop() ?? "";
  const stem = base.replace(/\.apk$/i, "");
  if (!stem) return null;
  try {
    const list = await shell
      .spawn(["pm", "list", "packages", "-f"])
      .wait()
      .toString();
    const out = list.stdout ?? "";
    // Look for a package whose installed APK path contains our stem.
    for (const line of out.split("\n")) {
      const m = line.match(/^package:(.*)=(\S+)$/);
      if (m && m[1].includes(stem)) return m[2];
    }
  } catch {
    /* fall through */
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}