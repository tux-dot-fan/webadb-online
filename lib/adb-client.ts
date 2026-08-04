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

const ADB_VENDOR_FILTERS = mergeDefaultAdbInterfaceFilter([
  { vendorId: 0x18d1 }, // Google
  { vendorId: 0x04e8 }, // Samsung
  { vendorId: 0x22b8 }, // Motorola
  { vendorId: 0x0bb4 }, // HTC
  { vendorId: 0x1004 }, // LG
  { vendorId: 0x12d1 }, // Huawei
  { vendorId: 0x2717 }, // Xiaomi
  { vendorId: 0x2e04 }, // Oppo / OnePlus / Realme
  { vendorId: 0x2c7c }, // Qualcomm (some newer devices)
]);

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
      const device = await this.manager.requestDevice({
        filters: ADB_VENDOR_FILTERS,
      });
      if (!device) {
        // User cancelled the chooser dialog.
        this.setState({ kind: "disconnected" });
        return;
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