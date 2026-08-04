"use client";

import { useEffect, useState } from "react";
import { getAdbClient, type AdbSession } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

export function WiFiAdbPanel({ session: _session }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [ip, setIp] = useState<string | null>(null);
  const [port, setPort] = useState(5555);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const session = getAdbClient().getSession();
      if (!session) {
        setEnabled(false);
        return;
      }
      const addr = await session.adb.tcpip.getListenAddresses();
      // `servicePort` (set via tcpip setPort) overrides persistPort — if either
      // is non-zero, WiFi ADB is on.
      const activePort = addr.servicePort ?? addr.persistPort;
      setEnabled(activePort !== undefined);
      if (activePort) setPort(activePort);
      const devIp = await getAdbClient().getDeviceIp();
      setIp(devIp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const result = await getAdbClient().enableWifiAdb(port);
      setStatus(`Enabled. ${result.trim()}`);
      setEnabled(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await getAdbClient().disableWifiAdb();
      setStatus("Disabled.");
      setEnabled(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyEndpoint() {
    if (!ip) return;
    const text = `${ip}:${port}`;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`Copied "${text}" to clipboard.`);
    } catch {
      setStatus(`Endpoint: ${text} (clipboard write failed)`);
    }
  }

  return (
    <section className="panel">
      <h2>Wi-Fi ADB</h2>
      <p className="panel-desc">
        Enable ADB over TCP on the device. After enabling, you can unplug USB
        and connect from <code>adb connect &lt;ip&gt;:&lt;port&gt;</code> on another
        machine. The current WebADB session stays on USB.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="status-pill">
          <span className="dot" style={{ background: enabled ? "var(--success)" : "var(--text-dim)" }} />
          {enabled ? "Enabled" : "Disabled"}
        </span>
        {ip && (
          <code style={{ background: "var(--bg)", padding: "4px 8px", borderRadius: 4 }}>
            {ip}:{port}
          </code>
        )}
        <button onClick={() => void copyEndpoint()} disabled={!enabled || !ip}>
          Copy endpoint
        </button>
        <button onClick={() => void refresh()} disabled={busy} title="Refresh">
          ⟳
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          Port
          <input
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 5555)}
            disabled={busy || enabled}
            style={{ width: 100 }}
          />
        </label>
        {enabled ? (
          <button onClick={() => void disable()} disabled={busy}>
            Disable Wi-Fi ADB
          </button>
        ) : (
          <button onClick={() => void enable()} disabled={busy} className="primary">
            {busy ? "Working…" : `Enable on port ${port}`}
          </button>
        )}
      </div>

      {status && (
        <div className="banner info" style={{ margin: "0 0 12px" }}>
          {status}
        </div>
      )}
      {error && (
        <div className="banner error" style={{ margin: "0 0 12px" }}>
          {error}
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
        <strong style={{ color: "var(--text)" }}>Notes:</strong>
        <ul style={{ paddingLeft: 18, margin: "6px 0 0" }}>
          <li>The device and computer must be on the same Wi-Fi network.</li>
          <li>
            Wi-Fi ADB is unauthenticated by default on the TCP port — anyone on
            the LAN can connect. Disable when not in use.
          </li>
          <li>
            Toggle survives until the device reboots; after reboot, repeat this
            step.
          </li>
        </ul>
      </div>
    </section>
  );
}