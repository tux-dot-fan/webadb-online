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

import { REGISTERED_APPS } from "@/lib/app-registry";
import { useAdbState, useAdbSession, useAdbSupported } from "@/lib/use-adb";
import { useConnectActions } from "@/lib/use-connect-actions";

export function LandingHero() {
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
          Open a real PTY shell, push and install APKs, browse and edit files
          on the device, stream logcat, take screenshots, manage installed
          apps, and switch to wireless ADB — all from a single tab in
          Chrome, Edge, or Opera.
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

      <ConnectCallout />

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

function ConnectCallout() {
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
          Plug your phone into USB first, then tap above.
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