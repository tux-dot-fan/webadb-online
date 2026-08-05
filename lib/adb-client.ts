/**
 * ADB session — wraps @yume-chan/adb + WebUSB transport.
 *
 * Lives entirely client-side. Browser must support WebUSB (Chrome, Edge, Opera
 * on desktop; not Safari/Firefox) and the page must be served cross-origin
 * isolated (COOP/COEP headers, see next.config.mjs).
 *
 * Authentication flow (matches @yume-chan/adb 2.6.x):
 *   1. manager.requestDevice() → AdbDaemonWebUsbDevice | undefined (user cancel)
 *   2. device.connect() → AdbDaemonConnection (raw bytes)
 *   3. AdbDaemonTransport.authenticate({ serial, connection, credentialStore })
 *      → fully-negotiated transport (handshake + banner + maxPayloadSize)
 *   4. new Adb(transport) → high-level API
 */

import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
  AdbDefaultInterfaceFilter,
  mergeDefaultAdbInterfaceFilter,
} from "@yume-chan/adb-daemon-webusb";

export type ConnectionState =
  | { kind: "disconnected" }
  | { kind: "requesting" }
  | { kind: "connecting"; deviceLabel: string }
  | { kind: "connected"; serial: string; banner: string }
  | { kind: "error"; message: string };

export interface AdbSession {
  readonly adb: Adb;
  readonly transport: AdbDaemonTransport;
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

// Auth credentials are intentionally not stored — webadb.online never sees a
// private key. If a device requires RSA authentication, the user must tap
// "Always allow from this computer" on the phone the first time, after which
// the device remembers the public key for the host and re-auth is skipped.
// If the device still demands auth (no stored key on its side), this empty
// store lets the handshake fail loudly instead of pretending to be authenticated.
const NO_CREDENTIAL_STORE = {
  generateKey: async () => {
    throw new Error(
      "RSA auth not supported by this build. Tap 'Always allow' on the device dialog.",
    );
  },
  iterateKeys: () => [].values(),
} satisfies import("@yume-chan/adb").AdbCredentialStore;

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
      const transport = await AdbDaemonTransport.authenticate({
        serial: device.serial,
        connection,
        credentialStore: NO_CREDENTIAL_STORE,
      });

      const adb = new Adb(transport);
      const session: AdbSession = {
        adb,
        transport,
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
      const out = await s.adb.subprocess.noneProtocol.spawnWaitText([
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
      const out = await s.adb.subprocess.noneProtocol.spawnWaitText([
        "ip",
        "addr",
      ]);
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
   */
  async listInstalledPackages(): Promise<PackageInfo[]> {
    const s = this.requireSession();
    const out = await s.adb.subprocess.noneProtocol.spawnWaitText([
      "pm",
      "list",
      "packages",
      "-f",
      "-3", // -3 = third-party (user-installed) only
    ]);
    return parsePackageList(out);
  }

  /** Uninstall an app by package name. Returns true on success. */
  async uninstallPackage(packageName: string): Promise<boolean> {
    const s = this.requireSession();
    const out = await s.adb.subprocess.noneProtocol.spawnWaitText([
      "pm",
      "uninstall",
      packageName,
    ]);
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
    const resolved = await s.adb.subprocess.noneProtocol.spawnWaitText([
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
    return s.adb.subprocess.noneProtocol.spawnWaitText([
      "am",
      "start",
      "-n",
      activity,
    ]);
  }

  /**
   * Start a `logcat` process. Caller is responsible for consuming the stream
   * and killing the process. Used by the Logcat panel — it spawns, pipes
   * stdout into the UI, and kills on unmount.
   *
   * Returns a getter for the async iterable (lazy: calling it starts the
   * reader). The reader is a single-shot AsyncIterable — create a new one if
   * you need to consume the stream again.
   */
  async startLogcat(args: string[] = []): Promise<{
    kill(): void;
    stream: AsyncIterableIterator<Uint8Array>;
  }> {
    const s = this.requireSession();
    const shell = s.adb.subprocess.shellProtocol;
    if (!shell) {
      throw new Error("Device doesn't support Shell V2 protocol");
    }
    const proc = await shell.spawn(["logcat", ...args]);
    // Wrap the native ReadableStream into our AsyncIterableIterator helper.
    // We do the conversion eagerly here so the caller can simply `for await`
    // over `stream` without having to call a function.
    const iterable = streamFromAsyncIterable(
      proc.stdout as unknown as ReadableStream<Uint8Array>,
    );
    const killFn = () => {
      try {
        void proc.kill();
      } catch {
        // ignore
      }
    };
    return {
      kill: killFn,
      stream: iterable,
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
    transport: AdbDaemonTransport,
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
 * Convert a Web ReadableStream<Uint8Array> to an async iterable. Used for
 * logcat streaming — React effects can't consume streams directly, but they
 * can `for await` over async iterables.
 */
async function* streamFromAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}