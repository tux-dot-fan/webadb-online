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

      <WifiSetupModal
        open={wifiModalOpen}
        onClose={() => setWifiModalOpen(false)}
        onOpenPanel={() => {
          setWifiModalOpen(false);
          onLaunchApp?.("wifi");
        }}
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

// ── WifiSetupModal ───────────────────────────────────────────────────────
//
// Step-by-step instructions for getting wireless ADB working. WebADB
// itself only talks to devices over WebUSB (a USB cable is required
// for the initial trust handshake), so the modal explains the only
// path that actually works today: plug in once via USB, grant the RSA
// fingerprint, enable Wireless Debugging on the phone, then use the
// Wi-Fi ADB panel to read back the device's IP + port.
//
// Once the user has the IP + port, they can either:
//   • keep the USB cable plugged in and use webadb normally (current
//     recommendation), or
//   • disconnect USB and use `adb connect <ip>:<port>` from the host
//     (this only re-routes the host-side adb daemon; webadb will not
//     connect over the network).

interface WifiSetupModalProps {
  open: boolean;
  onClose: () => void;
  onOpenPanel: () => void;
}

function WifiSetupModal({ open, onClose, onOpenPanel }: WifiSetupModalProps) {
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wifi-modal-title"
      onClick={onClose}
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
            aria-label="Close"
          />
        </div>

        <div className="modal-body">
          <p className="wifi-modal-lede">
            WebADB speaks to your phone over a USB cable (WebUSB). To use
            it without a cable you'll need to do a one-time setup on the
            phone itself. Once enabled, the Wi-Fi ADB panel will show the
            device's IP address and port for reference.
          </p>

          <ol className="wifi-modal-steps">
            <li>
              <strong>Enable USB debugging</strong> on your phone.
              <br />
              <span className="wifi-modal-step-detail">
                Settings → <em>Developer options</em> → <em>USB
                debugging</em>. (If Developer options is hidden, tap
                <em> Build number</em> seven times.)
              </span>
            </li>
            <li>
              <strong>Plug into USB once</strong> and tap the big
              <em> Connect device</em> button at the top of this page.
              <br />
              <span className="wifi-modal-step-detail">
                Approve the RSA fingerprint dialog on the phone. Tick
                <em> Always allow from this computer</em> so you don't
                have to confirm every time.
              </span>
            </li>
            <li>
              <strong>Enable Wireless debugging</strong> on the phone.
              <br />
              <span className="wifi-modal-step-detail">
                Same Developer options screen → <em>Wireless
                debugging</em>. On Xiaomi / HyperOS the toggle is named
                <em> Wireless debugging</em> under
                <em> Debugging</em>. Toggle it on; the phone will show
                an IP address and a port (usually <code>5555</code>) —
                note them down.
              </span>
            </li>
            <li>
              <strong>Open the Wi-Fi ADB panel</strong> from the dock
              (📶 icon) or click the button below.
              <br />
              <span className="wifi-modal-step-detail">
                The panel reads back the phone's current IP and active
                port, so you can confirm the setup worked. From this
                point on you can unplug the cable if you like — but note
                that webadb's WebUSB transport still needs the cable to
                be plugged in to keep the session alive. The IP and
                port are most useful as a reference for the host-side
                <code>adb</code> command, e.g.
                <code>adb connect &lt;ip&gt;:&lt;port&gt;</code>.
              </span>
            </li>
          </ol>

          <div className="wifi-modal-footnote">
            <strong>Heads-up:</strong> webadb's WebUSB transport can't
            open a fresh connection over the network by itself — the
            initial handshake always requires USB. The Wi-Fi ADB panel
            is therefore a <em>read-back / verification</em> tool
            rather than a true wireless entry point. Full wireless
            support is on the roadmap.
          </div>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="ghost"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="primary"
            onClick={onOpenPanel}
          >
            Got it — open Wi-Fi ADB panel
          </button>
        </div>
      </div>
    </div>
  );
}