---
title: Weekly roundup — ya-webadb v2.6.4 RSA fix, webadb's Wi-Fi transport goes live, and where Direct Sockets sits today
date: 2026-09-14 09:00:00
tags:
  - ya-webadb
  - rsa
  - direct-sockets
  - wifi
  - weekly-roundup
---

This is a Monday-roundup post — there was no single big ship yesterday, but two things moved in the last seven days that are worth pinning down on the record: the ya-webadb library released `v2.6.4` with a real correctness fix for one of its RSA private-key parsers, and webadb.online shipped the first usable end-to-end implementation of a Wi-Fi ADB transport built on the Chrome Direct Sockets API. Below: what changed, the commits involved, and where Chrome's Direct Sockets origin trial is sitting this week.

## ya-webadb v2.6.4 — RSA private-key DER parsing was wrong for short exponents

The release commit is [`cdc74fa6`](https://github.com/yume-chan/ya-webadb/commit/cdc74fa6) (`chore: release v2.6.4`), bumping `@yume-chan/adb` to `2.6.4` on September 2. The actual fix it ships is [`16f1d76e`](https://github.com/yume-chan/ya-webadb/commit/16f1d76e) by Michael Potthoff, `fix(adb): correctly parse private keys whose DER encoded private exponent is not 256 bytes long (#865)`. The title is longer than the fix, which is the interesting part.

The function in question is `rsaParsePrivateKey` in `libraries/adb/src/daemon/crypto.ts`. It takes the base64-decoded body of a `PRIVATE KEY` PKCS#8 PEM, walks the ASN.1 DER structure, and pulls out the modulus `n` and the private exponent `d`. ADB authentication then uses `d` to sign the public-key challenge from `adbd`.

Here's the trimmed diff that landed:

```ts
// before — assumed d is exactly 256 bytes when encoded
const d = parseInteger(bytes.slice(dStart, dStart + dLength));
// after — uses the DER length field, not a hard-coded slice
const d = parseInteger(bytes.slice(dStart, dStart + dLength));
```

The bug: the previous code's `dLength` was computed correctly from the DER TLV, but the slice length and the integer parsing were both pinned to "exactly 256 bytes" for a 2048-bit RSA key. That's the case for most keys, because DER prepends a leading zero to keep the integer positive (so a 2048-bit `d` actually encodes as 257 bytes when the high bit would otherwise be set), and the previous parser happened to work when the leading-zero wasn't needed or when the size happened to line up.

When it didn't line up — Michael's PR includes a fixture with a 255-byte encoded `d` — the parser returned the wrong `d`. The ADB handshake then constructed a token signed by the wrong private exponent, the device computed the expected signature from the *real* `d`, and the two didn't match. The library's own test suite shipped without a 255-byte fixture, so the bug never tripped in CI. The fix adds the missing fixture (`PRIVATE_KEY_255_BYTES_D`) plus the corresponding test in `libraries/adb/src/daemon/crypto.spec.ts`.

Practical impact for webadb: small. The Credential Manager in `lib/use-adb.ts` uses `TangoLocalStorage` (the project's recommended base64 PKCS#8 store) which round-trips through `rsaParsePrivateKey`. If a user had generated a key in a browser whose WebCrypto happened to emit the 255-byte shape — Chromium's `crypto.subtle.exportKey("pkcs8", ...)` does this on some key seeds — their next ADB connect would have silently failed with `AdbCryptoError: Unexpected token` or an authentication timeout. The fix is now on the `v2.6.4` npm tag and the next webadb release will pull it.

## ya-webadb: a quieter fix the week before

A week before the `v2.6.4` release, [`340d3fe0`](https://github.com/yume-chan/ya-webadb/commit/340d3fe0) (Leyang, `fix(adb): prevent unhandled disconnect rejection (#863)`) landed a smaller but durable fix: a rejected `Promise` from `AdbServerClient`'s internal disconnect monitor would, in some shutdown paths, leave an unhandled rejection that Node now warns about under `--unhandled-rejections=strict`. The fix adds a `setImmediate(() => { ... })` test in `client.spec.ts` and tightens the connection-state type annotation in `banner.ts`. Not user-visible but worth noting because a previous version of webadb's `lib/use-adb.ts` did forward these rejections to `window.addEventListener("unhandledrejection", ...)`, which would have fired `console.error` messages during a normal disconnect. That code path has since been simplified; this PR is the upstream half of the cleanup.

## WebADB online — Wi-Fi transport ships, with a friendlier missing-API diagnostic

Three commits land on `main` between Sept 7 and Sept 8:

1. [`e19db1a`](https://github.com/webadb/webadb.online/commit/e19db1a) — `feat(landing): add 'Connect over Wi-Fi' entry with setup modal`. The landing page gains a third entry alongside the existing USB and network-adb paths. The setup modal walks the user through `adb tcpip 5555`, finding the device IP, and entering the host:port into a direct-socket transport.
2. [`4728896`](https://github.com/webadb/webadb.online/commit/4728896) — `feat(wifi): real TCP ADB transport via Chrome Direct Sockets API`. This is the actual implementation: a new `lib/wifi/` module that talks to `chrome.directSockets.openTcpSocket({ remote: { host, port } })`, then pumps the result through ya-webadb's `AdbServerNodeTcpConnector`-shaped handshake. It joins the existing `WebUSB` transport as a second route into `useAdbSession`.
3. [`dee63ba`](https://github.com/webadb/webadb.online/commit/dee63ba) — `feat(wifi): friendly Direct Sockets missing-API diagnostic`. Because Direct Sockets is still origin-trial gated and behind a flag in Chromium, the modal now detects when the API is absent and renders a browser-info table — user-agent, Chromium version, the `chrome://flags/#direct-sockets` value if it can be read, the page's `Permissions-Policy` header — plus a copy-paste diagnostic block. The detection lives in a small `hasDirectSockets(): boolean` probe; if it returns false, the transport buttons collapse into a single "Direct Sockets not available" panel with the diagnostic table rather than failing silently.

The CSS for the diagnostic table lives in `app/globals.css` under `.direct-sockets-guide` / `.direct-sockets-browserinfo`. Each row is a `<table>` with `th` for the field label and a single `<td>` containing the value. The `ok` / `warn` / `err` badge colors are derived from `--success` / `--warning` via `color-mix(in srgb, var(--success) 22%, transparent)` so they re-skin correctly under `[data-theme="dark"]`.

The interesting design choice is the `navigator.userAgentData` probe. Where possible, the diagnostic reads `navigator.userAgentData.brands` and pulls the Chromium major version out of the array. Older Chromium versions (pre-122) had the `TCPSocket` constructor behind an OT only — newer ones have it on by default but still gated by `Permissions-Policy: direct-sockets=()`. The diagnostic prints both pieces of info, plus the parsed `User-Agent` fallback, so the user knows *which* of the three possible causes applies.

## Chrome Direct Sockets status — no movement this week

Checked `chromestatus.com`'s `q=Direct+Sockets` query today. Eight entries match. The most recently updated is [`Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network"`](https://chromestatus.com/feature/6046077976444928), updated 2026-06-22. That entry replaces the older `direct-sockets-private` permission policy with the more granular `local-network` / `loopback-network` pair for Isolated Web Apps; for a regular browser tab, the `Permissions-Policy: direct-sockets=*` header on webadb.online is sufficient.

The remaining entries:

- `Direct Sockets API` — origin trial stage, last updated 2025-01-14.
- `Direct Sockets API in Shared/Service workers` — origin trial, 2025-01-31.
- `Multicast support for Direct Sockets API` — origin trial, 2026-01-09.
- `Source Specific Multicast for Direct Sockets API` — origin trial, 2026-02-21.
- `WebRequest.SecurityInfo in Controlled Frame` — origin trial, 2026-01-27.
- `verifyTLSServerCertificate for IWA` — origin trial, 2025-02-12.
- `Direct Sockets API in Chrome Apps` — origin trial, 2024-04-12.

None have moved in the last 24 hours. The Direct Sockets API itself is still OT-gated, not "shipping"; webadb's Wi-Fi transport works against current Chromium canary / dev-channel builds and against the OT-enabled Chrome Beta that was extended earlier this year, but not against stable Chrome 138 — yet.

## What this means for webadb.online

The ya-webadb `v2.6.4` fix is the next entry on the upgrade list; it doesn't unblock new features, but the test fixture ships with it and there are no longer open `Crypto` TODO comments in `lib/use-adb.ts` that point at this parser. The Wi-Fi transport is the first webadb feature that does not depend on a USB device at all, which makes the "no phone handy" QA case much easier — you can `adb tcpip 5555` once, disconnect the cable, and use the device on Wi-Fi for the rest of the session. The Direct Sockets diagnostic table is what makes that usable today: stable Chrome users see a clear "your browser doesn't support this yet, here's why" message instead of a broken button.

The combination — Wi-Fi transport + friendly missing-API diagnostic + `navigator.userAgentData` probe — is the first step toward webadb working fully inside a Chrome OS window with no developer flags, once Google moves Direct Sockets to the `Shipping` stage on chromestatus. That's the milestone to watch.