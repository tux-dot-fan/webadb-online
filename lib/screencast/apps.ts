// ── Screencast app helpers ───────────────────────────────────────────────────
//
// App discovery + launching, factored out of ScreencastPanel so the
// panel itself stays focused on UI state. The panel receives an
// `AdbSession` (ya-webadb wrapper), not an `AdbClient`, so these
// helpers shell out to the underlying shellProtocol directly — same
// pattern as pipeline.ts.

import type { AdbSession } from "@/lib/adb-client";

/**
 * Parse `pm list packages -f` output. Each line looks like:
 *   package:/data/app/~~xyz/com.example.app-1/base.apk=com.example.app
 * Returns just the package names, sorted.
 *
 * `includeSystem` controls the `-3` flag (third-party only).
 */
function parsePmListPackages(out: string): string[] {
  const pkgs: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^package:\S+=(\S+)$/.exec(line.trim());
    if (m) pkgs.push(m[1]);
  }
  return pkgs;
}

/**
 * Run `pm list packages` and return the matching package names.
 *
 * Defaults to user-installed apps only (the `-3` flag). Pass
 * `includeSystem: true` to enumerate every package on the device —
 * used by AppManagerPanel. The screencast picker defaults to
 * third-party because that's almost always what users want to launch.
 */
export async function listInstalledPackages(
  session: AdbSession,
  opts: { includeSystem?: boolean } = {},
): Promise<string[]> {
  const shell = session.adb.subprocess.shellProtocol;
  if (!shell || !shell.isSupported) {
    throw new Error("Device doesn't support Shell V2 protocol");
  }
  const args = ["pm", "list", "packages", "-f"];
  if (opts.includeSystem !== true) args.push("-3");
  const proc = await shell.spawn(args);
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
    try { void proc.kill(); } catch { /* ignore */ }
  }
  return parsePmListPackages(out);
}

/**
 * Launch a package via `cmd package resolve-activity` + `am start`.
 *
 * Returns the activity name that was started (e.g.
 * `com.android.settings/.Settings`). Throws if the package can't be
 * resolved to a launcher activity.
 */
export async function launchPackage(
  session: AdbSession,
  packageName: string,
): Promise<string> {
  const shell = session.adb.subprocess.shellProtocol;
  if (!shell || !shell.isSupported) {
    throw new Error("Device doesn't support Shell V2 protocol");
  }
  // Resolve to a launcher activity.
  const resolveProc = await shell.spawn([
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    packageName,
  ]);
  const rReader = (resolveProc.stdout as unknown as ReadableStream<Uint8Array>)
    .getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let resolved = "";
  try {
    while (true) {
      const { done, value } = await rReader.read();
      if (done) break;
      resolved += decoder.decode(value, { stream: true });
    }
    resolved += decoder.decode();
  } finally {
    rReader.releaseLock();
    try { void resolveProc.kill(); } catch { /* ignore */ }
  }
  const activity = resolved.trim().split("\n").pop()?.trim() ?? "";
  if (!activity || !activity.includes("/")) {
    throw new Error(
      `Couldn't resolve launch activity for ${packageName}. ` +
        `Resolved: "${activity}"`,
    );
  }
  // Fire the start. We don't wait for it; the panel just sleeps
  // a moment for the app to render its first frame.
  const startProc = await shell.spawn(["am", "start", "-n", activity]);
  try { void startProc.kill(); } catch { /* ignore */ }
  return activity;
}