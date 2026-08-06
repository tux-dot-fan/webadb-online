"use client";

/**
 * Small pill that shows the current ADB connection state. Used by both
 * the topbar (right-hand status indicators) and any panel that wants to
 * surface connectivity at a glance. Reused in three places so we keep
 * the label / colour rules in one place.
 */

import type { ConnectionState } from "@/lib/adb-client";

export function StatusPill({ state }: { state: ConnectionState }) {
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

export function stateLabel(state: ConnectionState): string {
  switch (state.kind) {
    case "requesting":
      return "Awaiting device…";
    case "connecting":
      return `Connecting to ${state.deviceLabel}…`;
    default:
      return "Working…";
  }
}