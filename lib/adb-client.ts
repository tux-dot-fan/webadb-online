/**
 * ADB session — wraps @yume-chan/adb 3.0 + WebUSB transport.
 *
 * Lives entirely client-side. Browser must support WebUSB (Chrome, Edge, Opera
 * on desktop; not Safari/Firefox) and the page must be served cross-origin
 * isolated (COOP/COEP headers, see next.config.mjs).
 *
 * Authentication flow (matches @yume-chan/adb 3.0):
 *   1. manager.requestDevice() → AdbDaemonWebUsbDevice | undefined (user cancel)
 *   2. device.connect() → AdbDaemonConnection (raw byte pair)
 *   3. adbDaemonAuthenticate({ serial, connection, credentialManager })
 *      → fully-negotiated transport (handshake + banner + maxPayloadSize)
 *   4. new Adb(transport) → high-level API
 */

import { Adb, adbDaemonAuthenticate } from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
  AdbDefaultInterfaceFilter,
  mergeDefaultAdbInterfaceFilter,
} from "@yume-chan/adb-daemon-webusb";
import {
  AdbWebCryptoCredentialManager,
  TangoLocalStorage,
} from "@yume-chan/adb-credential-web";

export type ConnectionState =
  | { kind: "disconnected" }
  | { kind: "requesting" }
  | { kind: "connecting"; deviceLabel: string }
  | { kind: "connected"; serial: string; banner: string }
  | { kind: "error"; message: string };

export interface AdbSession {
  readonly adb: Adb;
  readonly device: AdbDaemonWebUsbDevice;
  readonly disconnected: Promise<void>;
}

/**
 * Pass-through: don't filter by vendorId. The ya-webadb `AdbDefaultInterfaceFilter`
 * (classCode=0xFF, subclassCode=0x42, protocolCode=1) is the official Android
 * ADB interface class — it matches every compliant Android device, regardless
 * of OEM. Earlier versions of this file listed ~25 vendor IDs, but every such
 * list is necessarily incomplete (new OEMs appear, carriers rebadge devices
 * under their own USB IDs, debug ROMs use random IDs). Forcing a vendor
 * whitelist silently hides devices from the chooser dialog, which then
 * reports "no compatible devices found" to the user. The browser still
 * requires the user to manually pick a device, so leaving it open is safe.
 */
const ADB_DEFAULT_FILTERS = mergeDefaultAdbInterfaceFilter(undefined);

/**
 * ADB host authentication. The adb protocol requires the host to hold an
 * RSA 2048 private key (the public counterpart is sent to the device during
 * the handshake so the device can verify a later `signature` challenge).
 *
 * webadb.online has no backend, so the key is generated in-browser via Web
 * Crypto and persisted in localStorage. The same key survives across
 * reloads, so the device only prompts the user to approve the host on the
 * FIRST connection. Subsequent reconnects use the stored key and the device
 * trusts it automatically (the user already tapped "Always allow" once).
 *
 * 3.0 implementation: `AdbWebCryptoCredentialManager` from
 * `@yume-chan/adb-credential-web`. It generates a fresh RSA-2048 key on
 * first connect, persists the PKCS#8 PrivateKeyInfo bytes (base64-encoded)
 * to localStorage via `TangoLocalStorage`, and on reconnect reads it back
 * and feeds the whole PKCS#8 buffer to `rsaParsePrivateKey` — which uses
 * fixed offsets (n at byte 38, d at byte 303) that line up exactly with
 * PKCS#8 PrivateKeyInfo for an RSA-2048 key with e=65537.
 *
 * Privacy: the key never leaves the browser. It is stored in localStorage
 * (origin-scoped), not transmitted. Clearing browser storage forces
 * regeneration on the next connection, which will require the user to tap
 * "Allow" on the device dialog again.
 */
const ADB_KEY_STORAGE_KEY = "webadb.online:adbd-rsa-credential";
const ADB_KEY_NAME = "webadb.online";

const CREDENTIAL_MANAGER = new AdbWebCryptoCredentialManager(
  new TangoLocalStorage(ADB_KEY_STORAGE_KEY),
  ADB_KEY_NAME,
);

export class AdbClient {
  private manager: AdbDaemonWebUsbDeviceManager | null = null;
  private session: AdbSession | null = null;
  private listeners = new Set<(s: ConnectionState) => void>();
  private state: ConnectionState = { kind: "disconnected" };

  isSupported(): boolean {
    return typeof navigator !== "undefined" && "usb" in navigator;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getSession(): AdbSession | null {
    return this.session;
  }

  subscribe(fn: (s: ConnectionState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async connect(): Promise<void> {
    if (!this.isSupported()) {
      throw new Error(
        "WebUSB is not supported in this browser. Use Chrome, Edge, or Opera on desktop.",
      );
    }
    if (this.session) return;

    this.setState({ kind: "requesting" });
    try {
      this.manager ??= new AdbDaemonWebUsbDeviceManager(navigator.usb);
      let device = await this.manager.requestDevice({
        filters: ADB_DEFAULT_FILTERS,
      });
      if (!device) {
        // The chooser dialog reported no matching devices. This can mean
        // three things and the user can't tell which:
        //   1. They cancelled the chooser before picking anything.
        //   2. The device is not yet plugged in.
        //   3. The device is plugged in but USB debugging is off, the cable
        //      is charge-only, or the device is in "PTP / charging" mode
        //      instead of "File transfer / MTP".
        // Try ONE more time WITHOUT filters to see if the device is even
        // answering WebUSB — if it still doesn't show up, it's hardware,
        // not our filter list, and we tell the user exactly what to check.
        device = await this.manager.requestDevice();
        if (!device) {
          this.setState({
            kind: "error",
            message:
              "No compatible devices found. Check:\n" +
              "  • USB debugging enabled (Settings → About → tap Build 7× →\n" +
              "    Developer options → USB debugging)\n" +
              "  • MIUI/HyperOS: also enable 'USB debugging (Security settings)'\n" +
              "    in Developer options (NOT just the regular USB debugging)\n" +
              "  • Phone is unlocked and shows the 'Allow USB debugging'\n" +
              "    prompt — tap Allow, then check 'Always allow from this computer'\n" +
              "  • USB mode is 'File transfer / MTP', not just charging\n" +
              "  • Cable supports data, not charge-only (many cables are charge-only)\n" +
              "  • Device is plugged in BEFORE clicking Connect\n" +
              "  • Try a different USB port on the computer (some hubs don't pass USB 2.0 well)\n" +
              "  • If the device shows up but adb auth fails, unplug, wait 5s, replug —\n" +
              "    MIUI sometimes caches a denied authorization state",
          });
          return;
        }
      }

      const label = device.name || "Android device";
      this.setState({ kind: "connecting", deviceLabel: label });

      const connection = await device.connect();
      const transport = await adbDaemonAuthenticate({
        serial: device.serial,
        connection,
        credentialManager: CREDENTIAL_MANAGER,
      });

      const adb = new Adb(transport);
      const session: AdbSession = {
        adb,
        device,
        disconnected: this.watchDisconnect(device, transport),
      };
      this.session = session;

      this.setState({
        kind: "connected",
        serial: adb.serial,
        banner: `${adb.banner.product} ${adb.banner.model} (${adb.banner.device})`,
      });
    } catch (err) {
      this.session = null;
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ kind: "disconnected" });
      throw new Error(msg);
    }
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = null;
    try {
      await s.adb.close();
    } catch {
      // best-effort
    }
    this.setState({ kind: "disconnected" });
  }

  /**
   * Switch to a different device: tears down the current session, then prompts
   * for a new one. Equivalent to disconnect() + connect() but exposed as a
   * single user-facing operation so the UI can label it correctly.
   */
  async switchDevice(): Promise<void> {
    await this.disconnect();
    return this.connect();
  }

  /**
   * Enable ADB-over-WiFi on the connected device. Returns the IP and port the
   * device will listen on. After this returns, the user can unplug USB and
   * connect via TCP from another adb client using
   *   adb connect <ip>:<port>
   *
   * Note: this only flips the daemon to listen on TCP. It does NOT replace the
   * current WebUSB session — the WebADB session remains USB-based. To switch
   * WebADB to WiFi you'd need a TCP transport, which is out of scope here.
   */
  async enableWifiAdb(port = 5555): Promise<string> {
    const s = this.requireSession();
    return s.adb.tcpip.setPort(port);
  }

  /** Disable ADB-over-WiFi on the device. */
  async disableWifiAdb(): Promise<string> {
    const s = this.requireSession();
    return s.adb.tcpip.disable();
  }

  /**
   * Get the IP address the device is advertising on its interfaces. Runs
   * `ip route` and grabs the default gateway's source address — works on
   * Android without root.
   */
  async getDeviceIp(): Promise<string | null> {
    const s = this.requireSession();
    try {
      const out = await spawnText(s.adb, [
        "sh",
        "-c",
        // `ip -o addr` gives one line per addr; we grep for global IPv4 and
        // grab the local address from the `src` field. Skips loopback.
        "ip -o addr show scope global 2>/dev/null | " +
          "awk '{print $4}' | cut -d/ -f1 | head -n1",
      ]);
      const ip = out.trim();
      // Validate it looks like an IPv4.
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      // Fall through to the legacy approach.
    }
    // Fallback: parse `ip addr` output (older Android).
    try {
      const out = await spawnText(s.adb, ["ip", "addr"]);
      const m = out.match(/inet (\d{1,3}(?:\.\d{1,3}){3})\//);
      if (m) return m[1];
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Run `pm list packages -f` and parse the output. Returns a list of
   * `{packageName, apkPath}` records. Used by the App manager panel.
   *
   * `includeSystem` defaults to true (every app on the device). Pass
   * `false` to restrict to third-party (`-3`) apps only — the legacy
   * behaviour, kept for callers that only care about user-installed apps.
   */
  async listInstalledPackages(opts?: { includeSystem?: boolean }): Promise<PackageInfo[]> {
    const s = this.requireSession();
    const includeSystem = opts?.includeSystem !== false;
    const args = ["pm", "list", "packages", "-f"];
    if (!includeSystem) args.push("-3");
    const out = await spawnText(s.adb, args);
    return parsePackageList(out);
  }

  /**
   * Get a single APK's metadata via `aapt2 dump badging`. Returns `null`
   * if aapt2 is missing or the APK can't be read.
   *
   * `aapt2` is available on virtually every modern Android (since API 24);
   * the `package` service also exposes `cmd package list packages -f` which
   * we already use. On older devices where aapt2 isn't on PATH, callers
   * should fall back to just showing the package name.
   */
  /**
   * Extract the app's launcher icon as raw image bytes (PNG / WebP).
   *
   * Two-stage strategy:
   *   1. `unzip -Z1 <apk> | grep ic_launcher` lists every entry whose
   *      path mentions `ic_launcher` (covers `ic_launcher`,
   *      `ic_launcher_round`, `ic_launcher_foreground`, all DPI buckets).
   *      `-Z1` prints one entry per line with no header — grep-friendly.
   *      This works on every ROM that ships `unzip` (toybox / busybox).
   *      We deliberately do NOT use `aapt2 dump badging` here: aapt2 is
   *      absent from many OEM ROMs (MIUI, ColorOS, OneUI) and on stock
   *      AOSP its path is `/system/bin/aapt2` which isn't on the default
   *      shell PATH.
   *   2. For each candidate (raster first by ascending DPI, XML last)
   *      run `unzip -p <apk> <entry>`. Sniff the magic bytes; if they
   *      look like a raster image, return them. Skip XML adaptive
   *      icons (browsers can't render them).
   *
   * Returns `null` if no candidate yields a raster payload. Callers
   * fall back to the colored-letter avatar in that case.
   */
  async getPackageIcon(apkPath: string): Promise<Uint8Array | null> {
    const s = this.requireSession();
    let candidates: string[];
    try {
      const list = await spawnText(s.adb, [
        "sh", "-c", `unzip -Z1 '${apkPath.replace(/'/g, "'\\''")}' | grep -E 'ic_launcher'`,
      ]);
      candidates = list.split("\n").map((l) => l.trim()).filter(Boolean);
      // Sort: raster first (smallest DPI bucket wins), XML last.
      candidates.sort((a, b) => {
        const aXml = a.endsWith(".xml") ? 1 : 0;
        const bXml = b.endsWith(".xml") ? 1 : 0;
        if (aXml !== bXml) return aXml - bXml;
        // Prefer smaller DPI buckets (mdpi=160) before larger ones.
        const aMdpi = /mipmap-mdpi/.test(a) ? 0 : /mipmap-hdpi/.test(a) ? 1 : /mipmap-xhdpi/.test(a) ? 2 : /mipmap-xxhdpi/.test(a) ? 3 : /mipmap-xxxhdpi/.test(a) ? 4 : 5;
        const bMdpi = /mipmap-mdpi/.test(b) ? 0 : /mipmap-hdpi/.test(b) ? 1 : /mipmap-xhdpi/.test(b) ? 2 : /mipmap-xxhdpi/.test(b) ? 3 : /mipmap-xxxhdpi/.test(b) ? 4 : 5;
        return aMdpi - bMdpi;
      });
    } catch {
      return null;
    }
    if (candidates.length === 0) return null;

    for (const entry of candidates) {
      try {
        const bytes = await spawnBinary(s.adb, ["unzip", "-p", apkPath, entry]);
        if (!bytes || bytes.length === 0) continue;
        if (isRasterImage(bytes)) return bytes;
      } catch {
        // unzip exits non-zero if the entry is absent. Keep trying.
      }
    }
    return null;
  }

  async getPackageMeta(apkPath: string): Promise<PackageMeta | null> {
    const s = this.requireSession();
    try {
      const out = await spawnText(s.adb, [
        "aapt2",
        "dump",
        "badging",
        apkPath,
      ]);
      return parseAaptBadging(out);
    } catch {
      return null;
    }
  }

  /**
   * Detailed package info from `dumpsys package`. Returns parsed fields we
   * care about: version, install/update times, enabled state, granted
   * permissions, target/compile SDK, primary ABI, code path. Unavailable
   * fields are simply absent from the returned object.
   */
  async getPackageDetails(pkg: string): Promise<PackageDetails | null> {
    const s = this.requireSession();
    try {
      const out = await spawnText(s.adb, ["dumpsys", "package", pkg]);
      return parseDumpsysPackage(out, pkg);
    } catch {
      return null;
    }
  }

  /**
   * APK size on disk in bytes. Returns null if we can't determine it
   * (the file may not exist for disabled/system-stub packages).
   */
  async getPackageSize(apkPath: string): Promise<number | null> {
    const s = this.requireSession();
    try {
      // `stat -c %s <path>` prints just the size.
      const out = await spawnText(s.adb, ["stat", "-c", "%s", apkPath]);
      const n = Number.parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Clear all data for a package (`pm clear`). Returns true on success.
   */
  async clearAppData(packageName: string): Promise<boolean> {
    const s = this.requireSession();
    try {
      const out = await spawnText(s.adb, ["pm", "clear", packageName]);
      return /Success/i.test(out);
    } catch {
      return false;
    }
  }

  /**
   * Enable / disable a package. `state` is "user" (default), "default",
   * or one of the android.content.pm.ComponentPackageState values. Most
   * users just want true / false — pass "default" or "user" to enable.
   */
  async setPackageEnabled(
    packageName: string,
    enabled: boolean,
  ): Promise<boolean> {
    const s = this.requireSession();
    const args = enabled
      ? ["pm", "enable", packageName]
      : ["pm", "disable-user", packageName];
    try {
      const out = await spawnText(s.adb, args);
      return !/error|failure/i.test(out);
    } catch {
      return false;
    }
  }

  /**
   * Read `/proc/stat` — single sample. Returns per-CPU stats and an
   * aggregate "cpu" line. Used by the System Monitor General tab to draw
   * usage bars.
   *
   * Format of `/proc/stat`:
   *   cpu  user nice system idle iowait irq softirq steal guest guest_nice
   *   cpu0 user nice system idle iowait irq softirq steal guest guest_nice
   *   cpu1 ...
   *   cpusum is the aggregate (the first unnumbered "cpu" line).
   * Times are in "USER_HZ" units (typically 100 = 1 sec on Android).
   */
  async getCpuStats(): Promise<CpuStats> {
    const s = this.requireSession();
    const out = await spawnText(s.adb, ["cat", "/proc/stat"]);
    return parseProcStat(out);
  }

  /**
   * Read `/proc/meminfo` and return parsed totals. Used by the System
   * Monitor General tab to draw the memory bar and the available /
   * buffers / cached / swap line items.
   *
   * Note: `MemAvailable` only exists on kernel 3.14+; on older kernels
   * we approximate it as `MemFree + Buffers + Cached`.
   */
  async getMemoryInfo(): Promise<MemoryInfo> {
    const s = this.requireSession();
    const out = await spawnText(s.adb, ["cat", "/proc/meminfo"]);
    return parseMeminfo(out);
  }

  /**
   * Snapshot of every running process. Uses toybox `ps` on Android.
   *
   *   ps -A -o PID,USER,NAME,%CPU,%MEM,RSS
   *
   * - `-A`        → all processes (not just current session)
   * - `-o …`      → explicit columns, no truncation surprises
   * - `RSS` is in KB (resident set size)
   * - `%CPU` is normalized across all cores on toybox 1.28+; on older
   *   versions it can exceed 100 for multi-threaded processes — we just
   *   show whatever the device reports.
   *
   * The `name` column (P.NAME = process/cmdline) is the field we use to
   * match against installed apps. On Android, processes are typically
   * named after their main package (e.g. `com.android.chrome`).
   */
  async getProcessList(): Promise<ProcessInfo[]> {
    const s = this.requireSession();
    let out: string;
    try {
      out = await spawnText(s.adb, [
        "ps",
        "-A",
        "-o",
        "PID,USER,NAME,%CPU,%MEM,RSS",
      ]);
    } catch {
      // Older toybox may not support the RSS column. Fall back to the
      // smaller set so we still get *something* usable.
      out = await spawnText(s.adb, [
        "ps",
        "-A",
        "-o",
        "PID,USER,NAME,%CPU,%MEM",
      ]);
      return parseProcessList(out, false);
    }
    return parseProcessList(out, true);
  }

  /**
   * Grant or revoke a runtime permission. Only works for permissions
   * classified as "runtime" or "dangerous" by the OS (Android 6+).
   * Returns true on success, false if the device refused (e.g. trying
   * to revoke a permission the app declared as "install-time only").
   */
  async setPermission(
    packageName: string,
    permission: string,
    grant: boolean,
  ): Promise<boolean> {
    const s = this.requireSession();
    const verb = grant ? "grant" : "revoke";
    try {
      const out = await spawnText(s.adb, [
        "pm",
        verb,
        packageName,
        permission,
      ]);
      // `pm grant` is silent on success; `pm revoke` prints nothing or
      // an error. Treat absence of error keywords as success.
      return !/error|exception|unknown|not granted/i.test(out);
    } catch {
      return false;
    }
  }

  /** Uninstall an app by package name. Returns true on success. */
  async uninstallPackage(packageName: string): Promise<boolean> {
    const s = this.requireSession();
    const out = await spawnText(s.adb, ["pm", "uninstall", packageName]);
    return /Success/i.test(out);
  }

  /**
   * Resolve the main launch activity for a package and launch it. Returns the
   * Activity Manager output (typically "Starting: Intent { ... }").
   */
  async launchPackage(packageName: string): Promise<string> {
    const s = this.requireSession();
    // `cmd package resolve-activity --brief <pkg>` prints the activity name on
    // the last line (e.g. "com.example/.MainActivity"). Using -c android.intent
    // .category.LAUNCHER restricts to launcher activities.
    const resolved = await spawnText(s.adb, [
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      packageName,
    ]);
    const activity = resolved.trim().split("\n").pop()?.trim() ?? "";
    if (!activity || !activity.includes("/")) {
      throw new Error(
        `Couldn't resolve launch activity for ${packageName}. Resolved: "${activity}"`,
      );
    }
    return spawnText(s.adb, ["am", "start", "-n", activity]);
  }

  /**
   * Launch a specific activity of a package via `am start -n <pkg>/<class>`.
   * Used by the App Manager's component list to deep-link straight to a
   * specific sub-activity (e.g. Settings → ConfigureNotificationSettingsActivity)
   * instead of always opening the app's launcher entry point.
   *
   * `className` may be fully qualified ("com.foo/.Bar") or relative to
   * the package ("com.foo/.Bar" or ".Bar" relative to the pkg). We pass
   * it through verbatim — `am start` handles both forms.
   */
  async launchActivity(packageName: string, className: string): Promise<string> {
    const s = this.requireSession();
    // `am start -n` wants `componentName` in `<pkg>/<class>` form. The
    // dumpsys output is already in this format ("com.foo/.Bar"), so a
    // straight pass-through is correct. If a caller ever passed just a
    // class (".Bar"), we'd need to prepend the package — that's a future
    // case, not this one.
    return spawnText(s.adb, [
      "am",
      "start",
      "-n",
      `${packageName}/${className}`,
    ]);
  }

  /**
   * Start a `logcat` process. Caller is responsible for consuming the stream
   * and killing the process. Used by the Logcat panel — it spawns, pipes
   * stdout into the UI, and kills on unmount.
   *
   * Returns the process (with `stdout` as a `ReadableStream<Uint8Array>` and
   * a `kill()` method). The caller can `for await` over `process.stdout` after
   * adapting it to an async iterable, or pipe it through a `TextDecoderStream`.
   */
  async startLogcat(args: string[] = []): Promise<{
    kill(): void;
    stdout: ReadableStream<Uint8Array>;
  }> {
    const s = this.requireSession();
    // Shell V2 protocol gives us separate stdout/stderr and an exit code,
    // which is what logcat needs (otherwise a long-running process would
    // never finish and we'd hang waiting for it).
    const shell = s.adb.subprocess.shellProtocol;
    if (!shell || !shell.isSupported) {
      throw new Error("Device doesn't support Shell V2 protocol");
    }
    const proc = await shell.spawn(["logcat", ...args]);
    return {
      kill: () => {
        try {
          void proc.kill();
        } catch {
          // ignore
        }
      },
      stdout: proc.stdout as ReadableStream<Uint8Array>,
    };
  }

  /**
   * Clear the on-device logcat ring buffer (`logcat -c`). Non-fatal if the
   * device refuses — older Androids without root may reject this.
   */
  async clearLogcatBuffer(): Promise<void> {
    const s = this.requireSession();
    try {
      await spawnText(s.adb, ["logcat", "-c"]);
    } catch (e) {
      // Surface a friendlier message but don't throw — the UI still works.
      throw new Error(
        `Couldn't clear logcat buffer: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Dump recent logcat history (one-shot). Wraps `logcat -d` — exits when
   * done. Returns the raw stdout text. The caller is expected to parse and
   * feed it into the panel's line buffer.
   *
   * Useful when the user wants to load a chunk of history without starting
   * a live stream. Common flags:
   *   -d           dump and exit (no follow)
   *   -t <N>       only print the last N lines (most recent first)
   *   -T <N>       only print the last N lines (most recent first; unlike
   *                -t it counts elapsed-time/log-time boundaries too)
   *   -s <spec>    tag filter, e.g. "MyTag:V *:E"
   */
  async dumpLogcat(args: string[]): Promise<string> {
    const s = this.requireSession();
    const shell = s.adb.subprocess.shellProtocol;
    if (!shell || !shell.isSupported) {
      throw new Error("Device doesn't support Shell V2 protocol");
    }
    const proc = await shell.spawn(["logcat", "-d", ...args]);
    const stream = proc.stdout as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
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
    return out;
  }

  /**
   * Start an interactive PTY (pseudo-terminal) shell. The returned object
   * exposes a `WritableStream` (`input`) for bytes the terminal sends and a
   * `ReadableStream` (`output`) for bytes the device sends back — the
   * standard xterm.js pipe contract.
   *
   * Requires Shell V2 protocol (the only one that exposes a true PTY with
   * window-resize support). The shell is started as `sh -i` (interactive).
   * The returned `resize(rows, cols)` lets the terminal notify the device
   * when the viewport changes.
   *
   * `kill()` tears down both streams. The caller is expected to pipe
   * `output` into xterm.js and write `xterm.onData` bytes into `input`.
   */
  async startShellPty(args: string[] = ["sh"]): Promise<{
    input: WritableStream<Uint8Array>;
    output: ReadableStream<Uint8Array>;
    resize(rows: number, cols: number): Promise<void>;
    sigint(): Promise<void>;
    kill(): void;
  }> {
    const s = this.requireSession();
    const shell = s.adb.subprocess.shellProtocol;
    if (!shell || !shell.isSupported) {
      throw new Error(
        "Interactive shell requires Shell V2 protocol — not supported on this device",
      );
    }
    // `pty()` opens the ADB shell service in PTY mode: the device allocates
    // a real pty with line discipline, so things like Ctrl+C (SIGINT),
    // arrow-key editing in `readline`, and `vim` actually work. Plain
    // `shellProtocol.spawn(["sh"])` runs in cooked mode and skips the
    // line discipline, which makes it unusable as a terminal.
    const pty = await shell.pty({ command: args, terminalType: "xterm-256color" });
    // Cast stream-extra WritableStream to a standard WritableStream so
    // xterm.js can write directly into it. The runtime contract is the
    // standard WHATWG streams one.
    const input = pty.input as unknown as WritableStream<Uint8Array>;
    const output = pty.output as unknown as ReadableStream<Uint8Array>;
    return {
      input,
      output,
      resize: (rows, cols) => pty.resize(rows, cols),
      sigint: () => pty.sigint(),
      kill: () => {
        try {
          void pty.kill();
        } catch {
          // ignore — may already be dead
        }
      },
    };
  }

  // ─── Device file ops used by the Terminal sidebar ──────────────────────
  //
  // We push user-uploaded scripts/binaries to `/data/local/tmp/webadb/`
  // because:
  //   - `/data/local/tmp/` is writable by the adb shell user without root
  //   - it's a real ext4 mount, so `chmod +x` bits stick (they wouldn't
  //     on /sdcard, which is emulated F2FS/FAT)
  //   - the tmp dir is auto-cleared on reboot, which is desirable for
  //     ephemeral tooling

  /**
   * Push raw bytes to a device path via the sync service. Throws if the
   * device rejects the write (e.g. read-only mount, permission denied,
   * no space left). Returns the bytes written so callers can sanity-check.
   */
  async pushBytes(remotePath: string, data: Uint8Array): Promise<number> {
    const s = this.requireSession();
    // sync.write takes a ReadableStream<MaybeConsumable<Uint8Array>>; the
    // standard ReadableStream<Uint8Array> we build is structurally
    // compatible at runtime but TypeScript can't unify the generic param
    // because MaybeConsumable adds a Symbol.asyncIterator override.
    // The same cast pattern is used by TextEditorApp and FileManagerPanel.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    await s.adb.sync.write({
      filename: remotePath,
      file: stream as unknown as Parameters<typeof s.adb.sync.write>[0]["file"],
    });
    return data.byteLength;
  }

  /**
   * Read raw bytes from a device path. Throws if the file doesn't exist
   * or the caller lacks read permission. Used for "Download" actions in
   * the sidebar — pulls the on-device copy back to the browser as a Blob.
   *
   * Note: sync.read is a streaming API that may yield multiple chunks
   * for files larger than the chunk size. We concatenate them all into
   * one Uint8Array so callers can treat the result as a single buffer.
   */
  async pullBytes(remotePath: string): Promise<Uint8Array> {
    const s = this.requireSession();
    // sync.read is typed as the stream-extra ReadableStream, but at
    // runtime it's the standard WHATWG ReadableStream<Uint8Array>, which
    // is what `getReader()` + `read()` return. We cast through `unknown`
    // to bridge the two declarations without paying for a manual copy.
    const stream = s.adb.sync.read(remotePath) as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (total === 0) throw new Error(`Empty file: ${remotePath}`);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  /**
   * `rm -f` a path. Non-zero exit is swallowed (matches -f semantics) so
   * callers don't have to wrap try/catch for cleanup paths.
   */
  async shellRm(remotePath: string): Promise<void> {
    const s = this.requireSession();
    try {
      await spawnText(s.adb, ["rm", "-f", remotePath]);
    } catch {
      // rm -f exits non-zero if the file doesn't exist; that's fine.
    }
  }

  /**
   * `chmod <mode> <path>`. We only ever use this to set +x after upload.
   */
  async shellChmod(remotePath: string, mode: string): Promise<void> {
    const s = this.requireSession();
    await spawnText(s.adb, ["chmod", mode, remotePath]);
  }

  /**
   * `test -e <path>` — returns true if the path exists, false otherwise.
   * We use this to verify a script/binary is still on the device after a
   * reconnect (the tmp dir survives USB reconnects — only a reboot
   * clears it).
   */
  async shellExists(remotePath: string): Promise<boolean> {
    const s = this.requireSession();
    try {
      const quoted = `'${remotePath.replace(/'/g, "'\\''")}'`;
      const out = await spawnText(s.adb, [
        "sh",
        "-c",
        `test -e ${quoted} && echo y || echo n`,
      ]);
      return out.trim() === "y";
    } catch {
      return false;
    }
  }

  /**
   * Ensure a directory exists (`mkdir -p`). Needed before the first push
   * because `/data/local/tmp/webadb/{scripts,bin}/` won't exist on a
   * fresh device.
   */
  async shellMkdirP(remotePath: string): Promise<void> {
    const s = this.requireSession();
    try {
      await spawnText(s.adb, ["mkdir", "-p", remotePath]);
    } catch {
      // mkdir -p is idempotent; only EACCES or ENOSPC matter and those
      // surface from spawnText itself. Swallowing here would mask real
      // failures, so we let exceptions propagate.
      throw new Error(`mkdir -p ${remotePath} failed`);
    }
  }

  private requireSession(): AdbSession {
    if (!this.session) {
      throw new Error("Not connected to a device");
    }
    return this.session;
  }

  private watchDisconnect(
    device: AdbDaemonWebUsbDevice,
    transport: { disconnected: Promise<void> },
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        navigator.usb.removeEventListener("disconnect", onUsbDisconnect);
        this.session = null;
        this.setState({ kind: "disconnected" });
        resolve();
      };
      const onUsbDisconnect = (e: USBConnectionEvent) => {
        if (e.device === device.raw) finish();
      };
      navigator.usb.addEventListener("disconnect", onUsbDisconnect);
      transport.disconnected.then(finish, finish);
    });
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }
}

let _instance: AdbClient | null = null;
export function getAdbClient(): AdbClient {
  if (!_instance) _instance = new AdbClient();
  return _instance;
}

export { AdbDefaultInterfaceFilter };
export type { AdbSession as AdbSessionType };

// ---------- Helpers ----------

export interface PackageInfo {
  /** e.g. "com.example.app" — last path component of the APK path. */
  packageName: string;
  /** Absolute path to the installed APK on the device. */
  apkPath: string;
}

/**
 * Parses `pm list packages -f` output. Each line looks like:
 *   package:/data/app/~~xyz==/com.example.app==/base.apk com.example.app
 * The first token is "package:" (with a leading "package:" prefix that some
 * Android versions include), then the path, then a space, then the package
 * name. We pull out the path and the package name; the package name is
 * duplicated in the path's basename in many builds, but the trailing token is
 * authoritative.
 */
function parsePackageList(text: string): PackageInfo[] {
  const out: PackageInfo[] = [];
  for (const line of text.split("\n")) {
    // `pm list packages -f` emits one entry per line:
    //   package:/path/to/base.apk=com.example.app
    // Older devices / Android versions omit the `package:` prefix, but
    // the `=` separator is universal. Split on `=` so we don't depend on
    // the prefix (or on whitespace, which never appears in this output
    // and is what the previous regex assumed — bug: every line failed to
    // match, so the app list came back empty).
    const idx = line.lastIndexOf("=");
    if (idx < 0) continue;
    const apkPath = line.slice(0, idx).replace(/^package:/, "").trim();
    const packageName = line.slice(idx + 1).trim();
    if (!apkPath || !packageName.includes(".")) continue; // sanity check
    out.push({ packageName, apkPath });
  }
  return out;
}

/**
 * Run a short-lived command and collect its full stdout as text. Tries the
 * Shell V2 protocol first (so we get separate stderr and a real exit code),
 * but falls back to the legacy "none" protocol if V2 isn't supported.
 *
 * On 3.0, `spawn` returns a process with a `wait()` method (lazy) that
 * accumulates stdout/stderr. This is a thin convenience wrapper.
 */
async function spawnText(adb: Adb, command: readonly string[]): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (shell && shell.isSupported) {
    // `shell.spawn(...)` returns a lazy `Promise<AdbShellProtocolProcess>`
    // that also implements `Wait<WaitResult<Uint8Array>, WaitResult<string>>`.
    // That means we have TWO ways to get the result:
    //   • `await procPromise.wait()`            → `WaitResult<Uint8Array>`
    //                                              (raw bytes; `result.stdout` is a Uint8Array)
    //   • `await procPromise.wait().toString()` → `WaitResult<string>`
    //                                              (decoded UTF-8; `result.stdout` is a string)
    //
    // Calling `.toString()` directly on `result.stdout` (a Uint8Array) is
    // a footgun: `Uint8Array.prototype.toString()` returns a comma-separated
    // list of byte values, not the bytes interpreted as text. Every parser
    // downstream (parseProcStat, parseMeminfo, parsePackageList, …) would
    // then see garbage like "112,97,99,107,97,103,101,58,..." and return
    // empty results — which is why the AppManager and SystemMonitor panels
    // came up empty even on a real device.
    //
    // The fix is to ask the spawner to give us the *decoded* form by
    // calling `.toString()` on the lazy promise (not on the Uint8Array).
    const procPromise = shell.spawn(command);
    const result = await procPromise.wait().toString();
    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed (exit ${result.exitCode}): ${command.join(" ")}\n` +
          (result.stderr || result.stdout),
      );
    }
    return result.stdout;
  }
  // Fallback: none-protocol has no `wait()` helper, so we accumulate
  // output manually.
  const proc = await adb.subprocess.noneProtocol.spawn(command);
  const decoder = new TextDecoder();
  let text = "";
  const reader = proc.output.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  await proc.exited;
  return text;
}

/**
 * Like `spawnText`, but returns stdout as raw `Uint8Array` instead of
 * a decoded UTF-8 string. Used for binary extraction (icons, APKs).
 *
 * Throws on non-zero exit so callers can distinguish "command failed"
 * from "command succeeded with empty output" — the icon-extraction
 * caller treats both as "no icon" but the type system should keep the
 * two paths separate.
 */
async function spawnBinary(adb: Adb, command: readonly string[]): Promise<Uint8Array> {
  const shell = adb.subprocess.shellProtocol;
  if (shell && shell.isSupported) {
    const procPromise = shell.spawn(command);
    const result = await procPromise.wait();
    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed (exit ${result.exitCode}): ${command.join(" ")}\n` +
          (result.stderr ? new TextDecoder().decode(result.stderr) : ""),
      );
    }
    return result.stdout;
  }
  // Fallback: none-protocol streams raw chunks; concat into one Uint8Array.
  const proc = await adb.subprocess.noneProtocol.spawn(command);
  const chunks: Uint8Array[] = [];
  const reader = proc.output.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  await proc.exited;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * Magic-byte sniff for raster image formats Android actually uses for
 * launcher icons. Anything else (XML adaptive icons, raw drawables,
 * 9-patch text headers) is useless to a browser `<img>`.
 *
 *  • PNG  : 89 50 4E 47 0D 0A 1A 0A
 *  • WebP : 52 49 46 46 ?? ?? ?? ?? 57 45 42 50 ("RIFF....WEBP")
 *  • JPEG : FF D8 FF
 */
function isRasterImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
  // JPEG
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
  // WebP ("RIFF" .... "WEBP")
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return true;
  return false;
}

// ── Package metadata types + parsers ───────────────────────────────────────

/** Result of `aapt2 dump badging <apk>`. */
export interface PackageMeta {
  /** Human-readable app label, e.g. "Settings" or "📱 Files". */
  label: string;
  /** versionName, e.g. "14". */
  versionName: string | null;
  /** versionCode as a number, e.g. 12345. */
  versionCode: number | null;
  /** minSdkVersion, e.g. 24. */
  minSdk: number | null;
  /** targetSdkVersion, e.g. 34. */
  targetSdk: number | null;
  /**
   * Icon resource paths from `aapt2 dump badging`, sorted by extraction
   * preference. PNG / WebP / JPEG raster entries come first (smallest
   * density preferred), followed by XML adaptive-icon entries as a
   * last-resort fallback (currently unusable — browsers can't render
   * adaptive-icon XML — but kept so future code can render them).
   *
   * Empty if the APK declares no icon at all (rare).
   */
  iconCandidates: string[];
  /** Whether the APK declares `android:debuggable="true"`. */
  debuggable: boolean;
}

/**
 * A single Android component (Activity / Service / Receiver / Provider)
 * declared in the package's manifest, as surfaced by `dumpsys package`.
 *
 * The className is fully qualified (e.g. `com.foo.bar/.MainActivity`).
 * `intentActions` only lists action names declared via `<intent-filter>`;
 * we don't surface categories, data spec, or authorities — those are
 * noisier and rarely useful for the "what can this app actually do?"
 * question we're answering here.
 */
export interface AppComponent {
  /** Fully qualified class name (e.g. `com.foo/.MainActivity`). */
  className: string;
  /** Required permission to use this component, or null if unprotected. */
  permission: string | null;
  /**
   * Whether the component is exported (i.e. callable from outside the
   * app). Derived from the dumpsys entry: components without a
   * `Permission: null` are typically exported, and components with
   * `android:permission` on the tag are gated. We treat "no permission
   * required" as exported for the user's mental model — a non-exported
   * component requires a permission to reach, so the absence of one is
   * the common case and matches the platform's default.
   */
  exported: boolean;
  /** Action names declared via <intent-filter>, in declaration order. */
  intentActions: string[];
}

export interface PackageDetails {
  /** Component enabled state: "enabled", "disabled", "default". */
  enabled: boolean;
  /** First install time as ISO string, or null if unknown. */
  firstInstallTime: string | null;
  /** Last update time as ISO string, or null if unknown. */
  lastUpdateTime: string | null;
  /** Permissions currently granted to the app (runtime + install-time). */
  grantedPermissions: string[];
  /** All permissions the app declared in its manifest. */
  requestedPermissions: string[];
  /** Primary CPU ABI, e.g. "arm64-v8a". */
  primaryCpuAbi: string | null;
  /** The path the package was loaded from. */
  codePath: string | null;
  /** User 0 install location flag (0=auto, 1=internal, 2=external). */
  installLocation: number | null;
  /** Activities declared in the manifest (parsed from dumpsys). */
  activities: AppComponent[];
  /** Services declared in the manifest (parsed from dumpsys). */
  services: AppComponent[];
  /** Broadcast receivers declared in the manifest (parsed from dumpsys). */
  receivers: AppComponent[];
  /** Content providers declared in the manifest (parsed from dumpsys). */
  providers: AppComponent[];
}

/**
 * Parse `aapt2 dump badging <apk>` output. Example:
 *   package: name='com.android.settings' versionCode='36' versionName='14'
 *   sdkVersion:'24'
 *   targetSdkVersion:'34'
 *   application-label:'Settings'
 *   application-label-ar:'الإعدادات'
 *   application-icon-160:'res/mipmap-anydpi/ic_launcher.xml'
 *   application: label='Settings' icon='res/...' debuggable
 *
 * `aapt2 dump badging` is very chatty (every locale gets its own label
 * line), so we just take the first `application-label:` and the smallest
 * `application-icon-*` resource (smallest density is the most portable).
 */
function parseAaptBadging(text: string): PackageMeta | null {
  let label: string | null = null;
  /** Every `application-icon-<dpi>: '<res>'` entry, in encounter order. */
  const iconEntries: Array<{ dpi: number; res: string }> = [];
  let versionName: string | null = null;
  let versionCode: number | null = null;
  let minSdk: number | null = null;
  let targetSdk: number | null = null;
  let debuggable = false;

  for (const line of text.split("\n")) {
    if (!label) {
      const m = line.match(/^application-label:\s*'((?:[^'\\]|\\.)*)'/);
      if (m) label = unescapeAaptString(m[1]);
    }
    const icon = line.match(/^application-icon-(\d+):\s*'([^']+)'/);
    if (icon) {
      const dpi = Number.parseInt(icon[1], 10);
      const res = icon[2];
      if (Number.isFinite(dpi)) iconEntries.push({ dpi, res });
    }
    const verLine = line.match(/^package:\s*name='[^']+'\s+versionCode='([^']+)'\s+versionName='([^']+)'/);
    if (verLine && versionName === null) {
      versionCode = Number.parseInt(verLine[1], 10);
      versionName = verLine[2];
    }
    const sdkLine = line.match(/^sdkVersion:\s*'(\d+)'/);
    if (sdkLine) minSdk = Number.parseInt(sdkLine[1], 10);
    const targetLine = line.match(/^targetSdkVersion:\s*'(\d+)'/);
    if (targetLine) targetSdk = Number.parseInt(targetLine[1], 10);
    // `application: label='…' icon='…' debuggable` → check for `debuggable`.
    if (/^application:/.test(line) && /\bdebuggable\b/.test(line)) {
      debuggable = true;
    }
  }

  if (label === null && versionName === null) return null;

  // Sort icon candidates: raster first (smallest DPI), then XML adaptive.
  // Smaller DPI = lower resolution = the most portable render target.
  iconEntries.sort((a, b) => {
    const aXml = a.res.endsWith(".xml") ? 1 : 0;
    const bXml = b.res.endsWith(".xml") ? 1 : 0;
    if (aXml !== bXml) return aXml - bXml;
    return a.dpi - b.dpi;
  });
  const iconCandidates = iconEntries.map((e) => e.res);

  return {
    label: label ?? "",
    versionName,
    versionCode: Number.isFinite(versionCode) ? versionCode : null,
    minSdk,
    targetSdk,
    iconCandidates,
    debuggable,
  };
}

/** Unescape aapt2's backslash-escaped strings (`\\'`, `\\n`, etc.). */
function unescapeAaptString(s: string): string {
  return s
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

/**
 * Parse `dumpsys package <pkg>` output. Only the fields we display in
 * the App Manager UI are extracted — there's a lot of internal
 * machinery in this dump that we ignore.
 */
function parseDumpsysPackage(text: string, pkg: string): PackageDetails {
  const lines = text.split("\n");
  const result: PackageDetails = {
    enabled: true,
    firstInstallTime: null,
    lastUpdateTime: null,
    grantedPermissions: [],
    requestedPermissions: [],
    primaryCpuAbi: null,
    codePath: null,
    installLocation: null,
    activities: [],
    services: [],
    receivers: [],
    providers: [],
  };

  let inRequested = false;
  let inInstall = false;

  /*
   * Component extraction state.
   *
   * `dumpsys package` formats each of the four "Resolver Tables" the
   * same way:
   *
   *   <Kind> Resolver Table:
   *     Non-Data Actions:
   *       <action-name>:
   *         <hash> <pkg>/<className> filter <hash>
   *         Action: "<action-name>"
   *         Category: "..."
   *         ...
   *         Class Name: "<fully-qualified-name>"
   *         Permission: "<perm>"  (or "null")
   *
   * The action-name header line appears BEFORE the
   * "<hash> ... filter" line that opens a filter group, so we
   * buffer the most recent action name in `pendingAction` and
   * attach it to the pending entry as soon as that entry is
   * created.
   */
  type CompKind = "activity" | "service" | "receiver" | "provider";
  let currentKind: CompKind | null = null;
  let pending: AppComponent | null = null;
  let pendingKind: CompKind | null = null;
  let inActions = false;
  let pendingAction: string | null = null;

  /** Push the pending entry into the right bucket, then reset. */
  const flush = () => {
    if (pending && pendingKind) {
      // Kind → array key. "activity" → "activities", etc. We can't use
      // `<kind>s` because "activity" + "s" = "activitys" (no auto-e
      // insertion) and "service" + "s" is fine but we want one source
      // of truth anyway.
      const bucketKey: keyof Pick<
        PackageDetails, "activities" | "services" | "receivers" | "providers"
      > = pendingKind === "activity" ? "activities"
        : pendingKind === "service" ? "services"
        : pendingKind === "receiver" ? "receivers"
        : "providers";
      result[bucketKey].push(pending);
    }
    pending = null;
    pendingKind = null;
    // NB: do NOT reset pendingAction here — callers that flush() right
    // before creating a new pending need to consume pendingAction
    // afterward. The new pending's intentActions: [pendingAction]
    // assignment clears it.
  };

  for (const raw of lines) {
    const line = raw.trim();

    // Detect the per-package header to know we're inside the right section.
    // (Some dumps include multiple packages' info — `dumpsys package`
    // returns just one but `dumpsys package packages` returns all.)
    if (new RegExp(`\\bPackage\\b.*\\b${escapeRegex(pkg)}\\b`).test(line)) {
      // continue — still inside our package
    }

    const codePath = line.match(/^codePath=([^\s]+)/);
    if (codePath) result.codePath = codePath[1];

    if (/^primaryCpuAbi=/.test(line)) {
      const m = line.match(/^primaryCpuAbi=(\S+)/);
      if (m) result.primaryCpuAbi = m[1];
    }

    if (/^\[Pkg\] firstInstallTime=/.test(line)) {
      const m = line.match(/firstInstallTime=(-?\d+)/);
      if (m) result.firstInstallTime = new Date(Number.parseInt(m[1], 10)).toISOString();
      const lu = line.match(/lastUpdateTime=(-?\d+)/);
      if (lu) result.lastUpdateTime = new Date(Number.parseInt(lu[1], 10)).toISOString();
    }

    const en = line.match(/^enabled=(\d+)/);
    if (en) result.enabled = en[1] !== "0";

    if (/^installLocation=/.test(line)) {
      const m = line.match(/^installLocation=(\d+)/);
      if (m) result.installLocation = Number.parseInt(m[1], 10);
    }

    // Section header for the requested-permissions list.
    if (/^requested permissions:/.test(line)) {
      inRequested = true;
      continue;
    }
    // Section header for the install permissions list.
    if (/^install permissions:/.test(line)) {
      inRequested = false;
      inInstall = true;
      continue;
    }
    // Anything else ends a permission list section. We test against
    // `raw` (not `line`) because the permission-list lines are
    // indented and `line = raw.trim()` has dropped that whitespace.
    if (
      inRequested && !/^\s+android\./.test(raw) && !/^\s+com\./.test(raw)
    ) {
      inRequested = false;
    }
    if (inInstall && line === "") inInstall = false;

    if (inRequested) {
      const m = raw.match(/^\s+(android\.[\w.]+|[a-z][\w.]*\.[\w.]+)/);
      if (m) result.requestedPermissions.push(m[1]);
    }
    if (inInstall) {
      const m = raw.match(/^\s+(android\.[\w.]+|[a-z][\w.]*\.[\w.]+):\s+granted=true/);
      if (m && !result.grantedPermissions.includes(m[1])) {
        result.grantedPermissions.push(m[1]);
      }
    }

    // ── Component tables ─────────────────────────────────────────────
    // Top-level header for one of the four tables. Flush any pending
    // entry from the previous table and switch the bucket.
    if (/^Activity Resolver Table:/.test(line)) {
      flush();
      currentKind = "activity";
      inActions = false;
      continue;
    }
    if (/^Service Resolver Table:/.test(line)) {
      flush();
      currentKind = "service";
      inActions = false;
      continue;
    }
    if (/^Receiver Resolver Table:/.test(line)) {
      flush();
      currentKind = "receiver";
      inActions = false;
      continue;
    }
    if (/^Provider Resolver Table:/.test(line)) {
      flush();
      currentKind = "provider";
      inActions = false;
      continue;
    }

    // A blank line ends the current filter group (and any pending entry
    // we haven't yet promoted via Class Name:).
    if (line === "") {
      flush();
      inActions = false;
      continue;
    }

    // Non-Data Actions sub-header — we're entering the list of intent
    // filters for the current component kind.
    if (/^Non-Data Actions:/.test(line) || /^Actions:/.test(line)) {
      inActions = true;
      continue;
    }

    // The "<hash> <pkg>/<className> filter <hash>" line that opens each
    // filter group. We capture the className here, and finalize the
    // entry when we hit the Class Name: line that follows. The
    // `pendingAction` captured from the preceding action header is
    // attached here and cleared so the next filter group starts fresh.
    //
    // The hash is always lowercase hex (typically 8 chars); we anchor
    // it with `\s+` after to avoid confusing it with an action header
    // like `android.intent.action.MAIN:` that also contains dots and
    // letters.
    if (
      inActions && currentKind &&
      /^\s+[0-9a-f]{6,}\s+\S+\/[\w$.]+\s+filter\s+[0-9a-f]+/.test(raw)
    ) {
      // Flush the previous entry (different className starts here).
      flush();
      const m = raw.match(/^\s+[0-9a-f]+\s+(\S+)\s+filter\s+[0-9a-f]+/);
      if (m) {
        pending = {
          className: m[1],
          permission: null,
          // `exported` is computed below from the Permission: line
          // (no permission required → exported; required perm →
          // gated but still exported behind that perm).
          exported: true,
          intentActions: pendingAction ? [pendingAction] : [],
        };
        pendingKind = currentKind;
        pendingAction = null;
      }
      continue;
    }

    // The action name itself (e.g. "android.intent.action.MAIN:")
    // appears as a header line within Non-Data Actions. The header
    // comes BEFORE the "<hash> ... filter" line that opens the filter
    // group, so we buffer it in `pendingAction` (declared outside the
    // loop so it survives across iterations) and consume it on the
    // "hash filter" line below. Blank lines reset `inActions` to false,
    // but a new action header re-opens it.
    if (/^\s+[\w.]+:\s*$/.test(raw)) {
      pendingAction = line.replace(/:\s*$/, "").trim();
      inActions = true;
      continue;
    }

    // Final form: `Class Name: "com.foo/.Bar"`. dumpsys reprints the
    // FQCN under this key even though the header line above already
    // contained it; we trust this one because it's the canonical
    // representation (handles inner-class `$` mangling consistently).
    if (pending && /^Class Name:\s+"?/.test(line)) {
      const m = line.match(/^Class Name:\s+"?([^"]+)"?/);
      if (m) pending.className = m[1];
      continue;
    }

    // Permission gating the component. "Permission: null" means
    // unprotected (i.e. exported).
    if (pending && /^Permission:/.test(line)) {
      if (/^Permission:\s+null\b/.test(line)) {
        pending.permission = null;
        pending.exported = true;
      } else {
        const m = line.match(/^Permission:\s+(\S+)/);
        if (m) {
          pending.permission = m[1];
          // Components with a `android:permission` are still exported,
          // just gated. Dumpsys doesn't give us a separate "is this
          // android:exported=true" signal cleanly, so we treat the
          // presence of a permission as "still callable, but only
          // by callers holding that permission".
          pending.exported = true;
        }
      }
      continue;
    }

    // `Not exported:` marker (newer Android versions explicitly mark
    // non-exported components).
    if (pending && /^\s*Not exported/.test(raw)) {
      pending.exported = false;
      continue;
    }
  }

  // Final flush — the last component in the file may not be followed by
  // a blank line.
  flush();

  // Fallback: if install permissions section wasn't seen, mark all
  // requested perms as granted (older Android / system apps).
  if (result.grantedPermissions.length === 0 && result.requestedPermissions.length > 0) {
    result.grantedPermissions = [...result.requestedPermissions];
  }

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── System monitor types + parsers ────────────────────────────────────────

/** Per-CPU stats from `/proc/stat`. Times are in USER_HZ (typically 100/s). */
export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
  guest: number;
  guestNice: number;
}

/** A single CPU line from `/proc/stat` (either aggregate or per-core). */
export interface CpuSample {
  /** "cpu" for aggregate, "cpu0", "cpu1", … for per-core. */
  label: string;
  /** Times broken down by category. */
  times: CpuTimes;
}

/** Result of parsing `/proc/stat`. */
export interface CpuStats {
  /** Aggregate across all cores (the "cpu" line). */
  total: CpuSample;
  /** One entry per logical CPU (cpu0, cpu1, …). */
  perCpu: CpuSample[];
}

/**
 * Memory figures from `/proc/meminfo`. All values are in kibibytes (KiB).
 *
 * `available` is either `MemAvailable` (kernel 3.14+) or a fallback
 * estimate of `MemFree + Buffers + Cached` for older kernels.
 */
export interface MemoryInfo {
  total: number;
  free: number;
  available: number;
  buffers: number;
  cached: number;
  swapTotal: number;
  swapFree: number;
  dirty: number;
  /** Where `available` came from — useful for the UI tooltip. */
  availableSource: "MemAvailable" | "fallback";
}

/** Single row from `ps -A`. */
export interface ProcessInfo {
  pid: number;
  /** Process owner (e.g. "u0_a42", "system", "root"). */
  user: string;
  /** Process / command name (often the package name on Android). */
  name: string;
  /** CPU percentage as reported by the device — may exceed 100 for
   *  multi-threaded processes on older toybox. */
  cpuPercent: number;
  /** Memory percentage of total RAM. */
  memPercent: number;
  /** Resident set size in KiB. Null if the device's toybox doesn't
   *  support the RSS column (rare; we fall back to no-RSS in that case). */
  rssKb: number | null;
}

/** Sum of all non-idle times; useful for the "compute usage" denominator. */
function cpuTotal(t: CpuTimes): number {
  return t.user + t.nice + t.system + t.idle + t.iowait
    + t.irq + t.softirq + t.steal + t.guest + t.guestNice;
}

/** Idle time only (idle + iowait). */
function cpuIdle(t: CpuTimes): number {
  return t.idle + t.iowait;
}

/**
 * Parse `/proc/stat` output. Each line begins with "cpu" or "cpuN" then
 * 10 space-separated integers. Lines we don't recognise are skipped.
 */
function parseProcStat(text: string): CpuStats {
  let total: CpuSample | null = null;
  const perCpu: CpuSample[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("cpu")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 11) continue;
    const label = parts[0];
    // Skip lines like `cpu` (aggregate) and `cpu0`/`cpu1`/...; ignore
    // `cpufreq`, `cpu_dma_latency`, etc.
    if (label !== "cpu" && !/^cpu\d+$/.test(label)) continue;
    const nums = parts.slice(1, 11).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const times: CpuTimes = {
      user: nums[0],
      nice: nums[1],
      system: nums[2],
      idle: nums[3],
      iowait: nums[4],
      irq: nums[5],
      softirq: nums[6],
      steal: nums[7],
      guest: nums[8],
      guestNice: nums[9],
    };
    const sample: CpuSample = { label, times };
    if (label === "cpu") total = sample;
    else perCpu.push(sample);
  }

  if (!total) {
    // Empty /proc/stat — return zeros so the UI doesn't crash.
    const zero: CpuTimes = {
      user: 0, nice: 0, system: 0, idle: 0, iowait: 0,
      irq: 0, softirq: 0, steal: 0, guest: 0, guestNice: 0,
    };
    return {
      total: { label: "cpu", times: zero },
      perCpu: [],
    };
  }
  return { total, perCpu };
}

/**
 * Parse `/proc/meminfo`. Lines look like:
 *   MemTotal:        7654320 kB
 *   MemFree:          234567 kB
 *   MemAvailable:    3456789 kB    ← only on newer kernels
 *   Buffers:          123456 kB
 *   Cached:          1234567 kB
 *   SwapTotal:             0 kB
 *   SwapFree:              0 kB
 *   Dirty:             1234 kB
 *
 * `MemAvailable` is the modern, kernel-estimated free memory; on older
 * kernels we fall back to `MemFree + Buffers + Cached`.
 */
function parseMeminfo(text: string): MemoryInfo {
  const fields: Record<string, number> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^(\w+):\s+(\d+)/);
    if (m) fields[m[1]] = Number.parseInt(m[2], 10);
  }
  const total = fields["MemTotal"] ?? 0;
  const free = fields["MemFree"] ?? 0;
  const buffers = fields["Buffers"] ?? 0;
  const cached = fields["Cached"] ?? 0;
  const dirty = fields["Dirty"] ?? 0;
  const swapTotal = fields["SwapTotal"] ?? 0;
  const swapFree = fields["SwapFree"] ?? 0;
  let available: number;
  let availableSource: "MemAvailable" | "fallback";
  if (fields["MemAvailable"] !== undefined) {
    available = fields["MemAvailable"];
    availableSource = "MemAvailable";
  } else {
    available = free + buffers + cached;
    availableSource = "fallback";
  }
  return {
    total, free, available, buffers, cached,
    swapTotal, swapFree, dirty, availableSource,
  };
}

/**
 * Parse `ps -A -o PID,USER,NAME,%CPU,%MEM,RSS` output. The first line is
 * the header (we skip it). RSS is optional; pass `hasRss=false` for the
 * fallback path that doesn't request RSS.
 *
 * toybox's `ps` truncates NAME to 15 chars by default; we don't widen
 * it because most Android process names fit. If you need full cmdlines
 * you'd add `-w` but the resulting strings get noisy in a UI column.
 */
function parseProcessList(text: string, hasRss: boolean): ProcessInfo[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const out: ProcessInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // First line is the header "PID USER …"; skip it.
    if (i === 0 && /^PID\s/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = Number.parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) continue;
    const user = parts[1];
    // NAME is the 3rd column; %CPU the 4th; %MEM the 5th; RSS the 6th.
    // The NAME itself may contain spaces in some shells, but toybox
    // truncates to 15 chars with no spaces, so a simple split works.
    const name = parts[2];
    const cpuPercent = Number.parseFloat(parts[3]);
    const memPercent = Number.parseFloat(parts[4]);
    let rssKb: number | null = null;
    if (hasRss && parts.length >= 6) {
      const rss = Number.parseInt(parts[5], 10);
      rssKb = Number.isFinite(rss) ? rss : null;
    }
    out.push({
      pid,
      user,
      name,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
      memPercent: Number.isFinite(memPercent) ? memPercent : 0,
      rssKb,
    });
  }
  return out;
}

/**
 * Compute per-CPU busy percentage (0-100) from two consecutive samples.
 * Returns an array the same length as `perCpu`; `null` entries mean we
 * don't have enough data yet (the first tick).
 */
export function computeCpuPercents(
  prev: CpuStats | null,
  next: CpuStats,
): (number | null)[] {
  if (!prev) return next.perCpu.map(() => null);
  return next.perCpu.map((cur, i) => {
    const old = prev.perCpu[i];
    if (!old) return null;
    const dTotal = cpuTotal(cur.times) - cpuTotal(old.times);
    const dIdle = cpuIdle(cur.times) - cpuIdle(old.times);
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
  });
}

/** Convenience re-export of the internal idle/total helpers. */
export const _cpuHelpers = { cpuTotal, cpuIdle };
