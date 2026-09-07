"use client";

/**
 * The landing page shown when no app windows are open. Acts as both
 * the first thing the user sees and the primary SEO-visible content
 * on the page (the surrounding <head> metadata reinforces this for
 * crawlers, but the markup below is what humans actually read).
 *
 * The feature grid is driven by REGISTERED_APPS (filtering out the
 * overlay chrome — Apps / Search / Settings — because they're UI,
 * not user-facing features). Adding a new app with a `description`
 * in lib/app-registry.ts automatically surfaces it here.
 *
 * The big Connect button at the top of the page is the primary CTA
 * for users who arrive without a device already paired.
 */

import { useState } from "react";
import { REGISTERED_APPS } from "@/lib/app-registry";
import { useAdbState, useAdbSession, useAdbSupported } from "@/lib/use-adb";
import { useConnectActions } from "@/lib/use-connect-actions";

interface LandingHeroProps {
  /** Open an app window from the registry (used by the Wi-Fi setup modal). */
  onLaunchApp?: (appId: string) => void;
}

export function LandingHero({ onLaunchApp }: LandingHeroProps = {}) {
  const [wifiModalOpen, setWifiModalOpen] = useState(false);
  const features = REGISTERED_APPS.filter((a) => a.isOverlay !== true);

  return (
    <section className="landing">
      <header className="landing-hero">
        <div className="landing-icon">🧊</div>
        <h1 className="landing-title">WebADB</h1>
        <p className="landing-tagline">
          Run ADB on your Android device entirely from your browser.
          No install, no drivers, no platform-specific tooling.
        </p>
        <p className="landing-sub">
          A full file manager, one-click APK install, a multi-window ADB
          terminal with saved shell shortcuts, a live device screencast
          with mouse control, an instant device screenshot button, live
          logcat with ANSI colors, per-core system monitor, and an
          installed-app manager — all from a single tab in Chrome, Edge,
          or Opera. No install, no drivers, runs entirely over WebUSB.
        </p>
        <div className="landing-cta">
          <a className="landing-cta-link" href="/blog/">
            📝 Read the blog
            <span className="landing-cta-link-arrow" aria-hidden="true">
              →
            </span>
          </a>
          <a
            className="landing-cta-link"
            href="/blog/2026/08/11/How-to-use-webadb-online/"
          >
            🚀 How to use webadb.online
            <span className="landing-cta-link-arrow" aria-hidden="true">
              →
            </span>
          </a>
        </div>
      </header>

      <ConnectCallout onShowWifiModal={() => setWifiModalOpen(true)} />

      <h2 className="landing-section-title">What you can do</h2>
      <ul className="landing-features" aria-label="Features">
        {features.map((app) => (
          <li key={app.id} className="landing-feature">
            <div className="landing-feature-icon" aria-hidden="true">
              {app.icon}
            </div>
            <div className="landing-feature-body">
              <h3 className="landing-feature-name">{app.title}</h3>
              <p className="landing-feature-desc">{app.description}</p>
            </div>
          </li>
        ))}
      </ul>

      <h2 className="landing-section-title">How to connect</h2>
      <ol className="landing-steps">
        <li>
          <strong>Enable USB debugging</strong> on your Android phone
          (<em>Settings → Developer options → USB debugging</em>).
        </li>
        <li>
          <strong>Plug into USB</strong> and pick the &ldquo;File
          transfer / MTP&rdquo; mode on the phone prompt.
        </li>
        <li>
          Hit the big <strong>Connect device</strong> button above, pick
          your phone in the browser dialog, then tap <strong>Allow</strong>{" "}
          on the phone&rsquo;s RSA fingerprint prompt.
        </li>
        <li>
          Pick an app from the <strong>Dock</strong> below
          (<span aria-hidden="true">🧊</span>) — most work with the device
          already plugged in.
        </li>
      </ol>

      <p className="landing-foot">
        WebADB is open source and runs entirely client-side. Your USB
        traffic never leaves the browser; nothing is uploaded to any
        server.
      </p>

      <WifiConnectModal
        open={wifiModalOpen}
        onClose={() => setWifiModalOpen(false)}
      />
    </section>
  );
}

// ── ConnectCallout ────────────────────────────────────────────────────────
//
// The big Connect / Disconnect CTA at the top of the landing page.
// Shows different content depending on the connection state:
//   • disconnected → primary "Connect device" button (large, centered)
//   • requesting / connecting → disabled button with status text
//   • connected → device banner with Disconnect + Switch side-by-side
//   • error → error banner + retry button
//
// `useConnectActions` shares its `busy` / `error` state with the
// topbar so opening two prompts at once is impossible.

interface ConnectCalloutProps {
  onShowWifiModal: () => void;
}

function ConnectCallout({ onShowWifiModal }: ConnectCalloutProps) {
  const state = useAdbState();
  const session = useAdbSession();
  const supported = useAdbSupported();
  const { busy, error, clearError, connect, disconnect, switchDevice } =
    useConnectActions();

  if (state.kind === "connected" && session) {
    return (
      <div className="connect-callout connected">
        <div className="connect-callout-info">
          <div className="connect-callout-status">✅ Connected</div>
          <div className="connect-callout-device">
            <span className="mono">
              {state.serial || "unknown device"}
            </span>
            {state.banner && (
              <span className="connect-callout-banner">{state.banner}</span>
            )}
          </div>
        </div>
        <div className="connect-callout-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void switchDevice()}
          >
            🔁 Switch device
          </button>
          <button
            className="ghost-danger"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            🔌 Disconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="connect-callout">
      <button
        className="connect-callout-button primary"
        disabled={busy || !supported}
        onClick={() => void connect()}
      >
        {busy ? <BusyLabel state={state} /> : "🔗 Connect device"}
      </button>
      {state.kind === "disconnected" && !busy && (
        <button
          type="button"
          className="connect-callout-wifi-btn"
          onClick={onShowWifiModal}
        >
          📶 Connect over Wi-Fi
        </button>
      )}
      {!supported && (
        <div className="banner warn connect-callout-warn">
          WebUSB is not available in this browser. Use Chrome, Edge, or
          Opera on desktop.
        </div>
      )}
      {error && (
        <div className="banner error connect-callout-error">
          <span>{error}</span>
          <button
            type="button"
            className="banner-dismiss"
            onClick={clearError}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}
      {state.kind === "disconnected" && !error && (
        <p className="connect-callout-hint">
          Plug your phone into USB first, then tap above. Already on the
          same Wi-Fi? Tap <strong>Connect over Wi-Fi</strong> to see
          how to enable wireless debugging.
        </p>
      )}
    </div>
  );
}

function BusyLabel({
  state,
}: {
  state: ReturnType<typeof useAdbState>;
}) {
  if (state.kind === "requesting") return <>Awaiting device…</>;
  if (state.kind === "connecting") return <>Connecting…</>;
  return <>Working…</>;
}

// ── WifiConnectModal ────────────────────────────────────────────────────
//
// Connect to a phone that is already listening for ADB over TCP. Uses
// the Chrome Direct Sockets API (navigator.openTCPSocket) to open a raw
// socket from the browser — no native bridge, no server.
//
// One-time setup on the phone (only required the very first time):
//   1. Enable USB debugging (Developer options).
//   2. Plug into USB once, accept the RSA fingerprint on the phone.
//   3. Enable Wireless debugging (Developer options) on the phone.
//
// After step 3 the phone listens on TCP 5555 by default and the user
// enters the device's IP + port in the form below. From then on
// webadb connects without needing the cable.
//
// Requirements:
//   - Chrome 142+
//   - Direct Sockets flag enabled:
//     chrome://flags/#enable-experimental-web-platform-features
//     (or the Direct Sockets Origin Trial token, or enterprise policy)
//   - The page must already be cross-origin isolated (webadb.online is)

interface WifiConnectModalProps {
  open: boolean;
  onClose: () => void;
}

function WifiConnectModal({ open, onClose }: WifiConnectModalProps) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(5555);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.openTCPSocket === "function";

  if (!open) return null;

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const { getAdbClient } = await import("@/lib/adb-client");
      await getAdbClient().connectOverTcp(host.trim(), port);
      // On success the AppState transitions to connected and the
      // landing page unmounts — no need to close the modal here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wifi-modal-title"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="modal-window wifi-setup-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-titlebar">
          <span className="modal-title-icon" aria-hidden="true">📶</span>
          <span id="wifi-modal-title" className="modal-title">
            Connect over Wi-Fi
          </span>
          <button
            type="button"
            className="window-ctrl window-ctrl-close modal-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          />
        </div>

        <div className="modal-body">
          <p className="wifi-modal-lede">
            Enter the device's IP address and port. The phone must
            already be listening for ADB over TCP — see the
            prerequisites below.
          </p>

          {!supported && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              Direct Sockets is not available in this browser. To use
              ADB over Wi-Fi you need Chrome 142+ with the
              {" "}
              <code>
                chrome://flags/#enable-experimental-web-platform-features
              </code>
              {" "}
              flag enabled.
            </div>
          )}

          <form
            className="wifi-modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (supported && host.trim() && !busy) void handleConnect();
            }}
          >
            <label className="wifi-modal-field">
              <span>IP address</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                placeholder="192.168.1.42"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={!supported || busy}
                required
              />
            </label>
            <label className="wifi-modal-field wifi-modal-field-port">
              <span>Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) =>
                  setPort(Number.parseInt(e.target.value, 10) || 5555)
                }
                disabled={!supported || busy}
                required
              />
            </label>
            <button
              type="submit"
              className="primary wifi-modal-connect-btn"
              disabled={!supported || !host.trim() || busy}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>

          {error && (
            <div className="banner error" style={{ marginTop: 12 }}>
              <span>{error}</span>
              <button
                type="button"
                className="banner-dismiss"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
              >
                ✕
              </button>
            </div>
          )}

          <details className="wifi-modal-prereqs">
            <summary>Prerequisites on the phone</summary>
            <ol>
              <li>
                Enable <strong>USB debugging</strong> in Developer
                options.
              </li>
              <li>
                Plug into USB <strong>once</strong>, accept the RSA
                fingerprint on the phone, and tick{" "}
                <em>Always allow from this computer</em>.
              </li>
              <li>
                Enable <strong>Wireless debugging</strong> in Developer
                options (Xiaomi / HyperOS: under{" "}
                <em>Debugging</em>). The phone will display its IP
                address and a port — usually <code>5555</code>.
              </li>
              <li>
                Unplug the USB cable. The phone keeps listening on
                the wireless-debug port until you toggle it off or
                reboot.
              </li>
            </ol>
          </details>
        </div>
      </div>
    </div>
  );
}