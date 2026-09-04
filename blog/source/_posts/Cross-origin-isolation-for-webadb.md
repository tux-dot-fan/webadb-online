---
title: Cross-origin isolation for webadb.online — COEP, COOP, and the GA4 fix
date: 2026-08-25 14:20:00
tags:
  - coep
  - coop
  - cross-origin-isolation
  - mse
  - sharedarraybuffer
  - deep-dive
---

webadb.online's screencast stream uses `MediaSource` to feed the
video element. `MediaSource` requires the page to be cross-origin
isolated. So does `SharedArrayBuffer`. So does `OffscreenCanvas`
with a worker. So do most of the high-performance browser APIs
that turn the browser into a real runtime rather than a document
viewer.

Cross-origin isolation is gated by **two HTTP response headers**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The browser will set `window.crossOriginIsolated === true` only
when both are present, and the COEP policy is **recursive** — every
resource you load has to opt in. If you forget one script tag, one
iframe, one stylesheet, one image, **the whole page goes into a
half-isolated state where MediaSource mysteriously throws**.

This post is the writeup of how we get isolation on without
breaking Google Analytics, which is a same-origin script but
originates cross-origin assets.

## What "isolated" actually means

`crossOriginIsolated` is the property. When it's `true`:

- `SharedArrayBuffer` works (otherwise throws on construction).
- `Atomics.wait()` / `Atomics.notify()` work.
- High-resolution timers (`performance.now()` ≥ 5μs instead of
  100μs).
- `MediaSource` and `WebCodecs` work without throwing
  `Cannot use MediaSource on this document`.
- `performance.measureUserAgentSpecificMemory()` works.

The screencast panel needs `MediaSource`. The logcat panel needs
high-res timers to estimate line rates without drifting. The file
manager's progress UI wants `SharedArrayBuffer` to share state
across the worker that streams uploads and the React thread that
paints. So we want isolation on, by default.

## The headers, where they live

`next.config.mjs`:

```js
headers: [
  {
    source: "/:path*",
    headers: [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ],
  },
  {
    // GA4's analytics.js is loaded with crossorigin="anonymous" in
    // <script> tags, but the static analytics endpoint serves a
    // different set of resources that don't send CORP headers
    // we can rely on. Pre-validate them via the Credentialless
    // tier.
    source: "/_next/static/:path*",
    headers: [
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    ],
  },
],
```

Two policies in play:

- **COOP** (`same-origin`): my page may only share a browsing
  context with same-origin pages. If a popup opened by my page
  navigates elsewhere, the popup gets a fresh context. This is
  fine for webadb — no popups at all.
- **COEP** (`require-corp`): every resource my page loads must
  send `Cross-Origin-Resource-Policy: same-origin` / `same-site`
  / `cross-origin`, **or** be a same-origin load. There is no
  default-deny in older browsers but Chromium enforces it.

## The GA4 problem

GA4 is loaded with this snippet:

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

Two cross-origin requests happen:

1. The script tag loads `gtag/js`. Google **does** send
   `Cross-Origin-Resource-Policy: cross-origin` on this, so it
   passes.
2. The script itself then loads measurement resources from
   `*.analytics.google.com`, `*.googletagmanager.com`, and
   sometimes a third-party endpoint. Some of those **don't**
   send a CORP header that passes the `require-corp` check.

The cleanest fix that doesn't break GA4 is to flip the script
to `crossorigin="anonymous"` and rely on the GA endpoints that
*do* send CORP. That gets us 95% of cases.

The remaining 5% is the times GA loads a tag-manager config from
a third-party endpoint that hasn't been CORP'd yet. When that
happens, the page still loads (the request succeeds), but the
response is **opaque** — GA can't read the body. We don't get
analytics for that request. The page still works, MediaSource
still works, the user doesn't see anything.

The CDO (Cross-Origin-Opener-Policy-Report-Only) endpoint
pattern lets us collect reports on which subresources fail CORP
without breaking the page. We don't have it set up yet — adding
it is on the list.

## Why not `credentialless`

COEP has a `credentialless` mode that relaxes the CORP
requirement: any cross-origin resource is allowed as long as it
doesn't carry credentials (no cookies, no client certs). This is
a strict relaxation — Google Analytics works because it doesn't
need credentials for measurement requests.

```html
<meta http-equiv="Cross-Origin-Embedder-Policy" content="credentialless" />
```

We tried this in staging and saw two regressions:

1. **WebUSB device picker stops working.** The picker is itself
   a Chrome-internal page (`chrome://device-internals/`) that
   runs with credentials in some configurations. Credentialless
   pages can't talk to it.
2. **Some WebUSB drivers' WebUSB backend pages** also start
   requiring credentials for the device-init handshake.

So `require-corp` is what we ship. The tradeoff is that GA4's
fan-in endpoints sometimes go opaque; we accept that.

## The dev-server gotcha

`next dev` doesn't apply headers from `next.config.mjs` to its
dev server. They only get applied on `next build` + the static
export. This bites everyone the first time: dev server
isolation looks fine, prod doesn't. Fix is in
`scripts/dev-server-headers.mjs` if you need it during local
development.

## Verifying isolation is on

Three things to check after any change:

```js
// From the browser console on webadb.online
window.crossOriginIsolated          // → true
typeof SharedArrayBuffer             // → 'function'
new MediaSource() instanceof MediaSource // → true (no throw)
```

If any of these fails, the headers didn't reach the page. The
usual causes are:

- The headers were added to `next.config.mjs` but `next build`
  wasn't run, so they're still in the dev server (which
  ignores them).
- A new external resource was added (analytics endpoint,
  third-party widget) and it doesn't send CORP.
- A service-worker script (which has its own origin handling)
  is interfering.

We have a Playwright test in `tests/isolation.spec.ts` that hits
the production URL and asserts all three of the above, plus
that the screencast panel can actually open a MediaSource
without throwing. It runs on every deploy.

## What isolation enables on webadb

Just to enumerate the things that depend on it, since the list
is non-obvious:

| API                          | Used by                                       |
|------------------------------|-----------------------------------------------|
| `MediaSource`                | screencast video element                       |
| `SharedArrayBuffer`          | logcat ring buffer shared with a worker        |
| `Atomics.wait`               | logcat worker's backpressure signal            |
| High-res `performance.now()` | screencast frame-rate estimation, logcat QPS   |
| `WebCodecs` (queued)         | future video encoder for screencast recording  |

If you're building on the codebase, run the test before you
merge anything that adds an external resource — every new
external host has to play ball with COEP, and the failure mode
is "everything looks fine locally, prod mysteriously breaks".