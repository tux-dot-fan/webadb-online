"use client";

import { useState } from "react";
import { getAdbClient, type AdbSession } from "@/lib/adb-client";

interface Props {
  state: import("@/lib/adb-client").ConnectionState;
  session: AdbSession | null;
  supported: boolean;
}

export function DevicePanel({ state, session, supported }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConnect() {
    setError(null);
    setBusy(true);
    try {
      await getAdbClient().connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    setBusy(true);
    try {
      await getAdbClient().disconnect();
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="sidebar">
      <div>
        <div className="muted" style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>
          Connection
        </div>
        <StatusPill state={state} />
      </div>

      <div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Device</div>
        <div className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
          {state.kind === "connected"
            ? state.serial || "unknown"
            : "—"}
        </div>
      </div>

      <div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Banner</div>
        <div className="mono" style={{ fontSize: 12, color: "var(--text-dim)", wordBreak: "break-word" }}>
          {state.kind === "connected" ? state.banner : "—"}
        </div>
      </div>

      {error && (
        <div className="banner error" style={{ margin: 0 }}>
          {error}
        </div>
      )}

      <div>
        {state.kind === "connected" && session ? (
          <button onClick={onDisconnect} disabled={busy} style={{ width: "100%" }}>
            Disconnect
          </button>
        ) : (
          <button
            className="primary"
            onClick={onConnect}
            disabled={busy || !supported}
            style={{ width: "100%" }}
          >
            {busy ? stateLabel(state) : "Connect device"}
          </button>
        )}
      </div>

      {!supported && (
        <div className="banner warn" style={{ margin: 0, fontSize: 13 }}>
          WebUSB is not available. Use Chrome, Edge, or Opera on desktop.
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        <strong style={{ color: "var(--text)" }}>Steps:</strong>
        <ol style={{ paddingLeft: 18, margin: "6px 0 0" }}>
          <li>Enable USB debugging on your phone</li>
          <li>Plug into USB</li>
          <li>Click <span className="kbd">Connect device</span></li>
          <li>Tap <em>Allow</em> on the phone prompt</li>
        </ol>
      </div>
    </aside>
  );
}

function StatusPill({ state }: { state: import("@/lib/adb-client").ConnectionState }) {
  if (state.kind === "connected") {
    return (
      <span className="status-pill connected">
        <span className="dot" /> Connected
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="status-pill error">
        <span className="dot" /> Error
      </span>
    );
  }
  if (state.kind === "requesting" || state.kind === "connecting") {
    return (
      <span className="status-pill busy">
        <span className="dot" /> {stateLabel(state)}
      </span>
    );
  }
  return (
    <span className="status-pill">
      <span className="dot" /> Disconnected
    </span>
  );
}

function stateLabel(state: import("@/lib/adb-client").ConnectionState): string {
  switch (state.kind) {
    case "requesting":
      return "Awaiting device…";
    case "connecting":
      return `Connecting to ${state.deviceLabel}…`;
    default:
      return "Working…";
  }
}