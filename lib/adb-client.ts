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
    const m = line.match(/^(?:package:)?(\S+)\s+(\S+)/);
    if (!m) continue;
    const apkPath = m[1];
    const packageName = m[2];
    if (!packageName.includes(".")) continue; // sanity check
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
    // `shell.spawn(...)` returns a lazy promise that's also a `Wait` helper:
    //   - `await proc` → AdbShellProtocolProcess (with stdio streams)
    //   - `proc.wait()` → { stdout, stderr, exitCode } | string-via-.toString()
    // We want the wait helper to collect everything and decode the buffers.
    const procPromise = shell.spawn(command);
    const result = await procPromise.wait();
    const stdout = await result.stdout.toString();
    if (result.exitCode !== 0) {
      const stderr = await result.stderr.toString();
      throw new Error(
        `Command failed (exit ${result.exitCode}): ${command.join(" ")}\n` +
          (stderr || stdout),
      );
    }
    return stdout;
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
   * Best-effort icon resource identifier from `application-icon-*` lines.
   * Example: "res/mipmap-anydpi-v26/ic_launcher.xml". `null` if no icon
   * is declared. Used to extract a real icon from the APK on demand.
   */
  iconRes: string | null;
  /** Whether the APK declares `android:debuggable="true"`. */
  debuggable: boolean;
}

/** Result of `dumpsys package <pkg>`. */
export interface PackageDetails {
  /** `true` for system packages (under `/system/app`, `/system/priv-app`). */
  isSystem: boolean;
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
  let iconRes: string | null = null;
  let versionName: string | null = null;
  let versionCode: number | null = null;
  let minSdk: number | null = null;
  let targetSdk: number | null = null;
  let debuggable = false;

  // Pick the smallest-density icon (mdpi=160dpi) for portability, fall
  // back to whatever density is present.
  let iconDpi = Number.POSITIVE_INFINITY;

  for (const line of text.split("\n")) {
    if (!label) {
      const m = line.match(/^application-label:\s*'((?:[^'\\]|\\.)*)'/);
      if (m) label = unescapeAaptString(m[1]);
    }
    const icon = line.match(/^application-icon-(\d+):\s*'([^']+)'/);
    if (icon) {
      const dpi = Number.parseInt(icon[1], 10);
      if (Number.isFinite(dpi) && dpi < iconDpi) {
        iconDpi = dpi;
        iconRes = icon[2];
      }
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

  return {
    label: label ?? "",
    versionName,
    versionCode: Number.isFinite(versionCode) ? versionCode : null,
    minSdk,
    targetSdk,
    iconRes,
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
    isSystem: false,
    enabled: true,
    firstInstallTime: null,
    lastUpdateTime: null,
    grantedPermissions: [],
    requestedPermissions: [],
    primaryCpuAbi: null,
    codePath: null,
    installLocation: null,
  };

  let inRequested = false;
  let inInstall = false;

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

    if (/^System app:/.test(line) || /^Flags=.*SYSTEM/.test(line)) {
      result.isSystem = true;
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
    // Anything else ends a permission list section.
    if (
      inRequested && !/^\s+android\./.test(line) && !/^\s+com\./.test(line)
    ) {
      inRequested = false;
    }
    if (inInstall && line === "") inInstall = false;

    if (inRequested) {
      const m = line.match(/^\s+(android\.[\w.]+|[a-z][\w.]*\.[\w.]+)/);
      if (m) result.requestedPermissions.push(m[1]);
    }
    if (inInstall) {
      const m = line.match(/^\s+(android\.[\w.]+|[a-z][\w.]*\.[\w.]+):\s+granted=true/);
      if (m && !result.grantedPermissions.includes(m[1])) {
        result.grantedPermissions.push(m[1]);
      }
    }
  }

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
