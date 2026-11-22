---
title: "Chrome 159 ships the WebTransport stack that ADB-over-network needs"
date: 2026-11-22 01:05:00 UTC
tags:
  - webadb
  - chromium
  - webtransport
  - adb
  - webusb
---

Chrome 159 is on the Beta channel at `159.0.8154.13` (branch position `r1739869`, branched November 9, Stable scheduled for **December 8, 2026**), and its release notes are, for this project, the most consequential ones in a while: the **WebTransport** section carries six separate shipped features — datagram writable streams with priority groups, send groups with `sendOrder` prioritisation, per-stream and per-group send statistics, a congestion-control knob, `exportKeyingMaterial()`, and a standardised `WebTransportReceiveStream` interface with per-stream byte counters. Meanwhile both USB-adjacent specs have quietly graduated to the WHATWG living-standard track, and ya-webadb's own wireless-debugging issue now names **Direct Sockets** as the transport path in production.

None of this changes webadb's default path — WebUSB over a USB cable still is the product. But it changes what the *edges* of the product can become, and for once the three stories (Chromium transport work, spec-track migration, ya-webadb issue history) all point the same direction.

## The WebTransport wave, and why it is the ADB story

Chrome 159's WebTransport entries are not cosmetic. Let me lay out what actually shipped, from the [Chrome 159 release notes](https://chromestatus.com/release-notes/159):

**Datagram writable streams and prioritisation** ([feature 5183354944225280](https://chromestatus.com/feature/5183354944225280), tracking bug [#547572475](https://issues.chromium.org/issues/547572475)) — `WebTransportDatagramDuplexStream.createWritable()` produces independent `WebTransportDatagramsWritable` streams, each with mutable `sendGroup` and `sendOrder` attributes that express relative priority among queued datagrams in the same group.

**Send groups and send-stream prioritisation** ([feature 5235261159112704](https://chromestatus.com/feature/5235261159112704), bug [#568825278](https://crbug.com/568825278)) — outgoing *streams* can also be assigned to send groups and prioritised within them, with sending statistics for streams and groups.

**WebTransport receive stream** ([feature 5109912169480192](https://chromestatus.com/feature/5109912169480192), bug [#568317222](https://issues.chromium.org/issues/568317222)) — a standardised `WebTransportReceiveStream` interface (a `ReadableStream` subclass) whose `getStats()` distinguishes `bytesReceived` (from the network) from `bytesRead` (delivered to the application). That distinction is not cosmetic for a protocol with its own framing: it is the difference between "the socket is fine" and "the app is not draining".

**Congestion control** ([feature 5180947573112832](https://chromestatus.com/feature/5180947573112832), bug [#501268547](https://issues.chromium.org/issues/501268547)) — a `congestionControl` constructor option and read-only attribute accepting `"default"`, `"throughput"`, or `"low-latency"`.

**Keying material export** ([feature 4860330806214656](https://chromestatus.com/feature/4860330806214656), bug [#556304550](https://issues.chromium.org/issues/556304550)) — `WebTransport.exportKeyingMaterial(label, context, length)` derives crypto material bound to an established session. For HTTP/3, Chromium folds the CONNECT stream ID into the TLS exporter context, so two sessions over the same HTTP/3 connection derive *different* material.

**WebTransportError alignment** ([feature 5158277221580800](https://chromestatus.com/feature/5158277221580800), bug [#577073049](https://issues.chromium.org/issues/577073049)) — the `(message, options)` constructor, the full unsigned-long stream error code carried end to end, and structured-clonability.

And in the other direction, [`datagramsReadableType`](https://chromestatus.com/feature/5148774971342848) (bug #547572475) lets an application ask for a BYOB readable byte stream instead of the default `ReadableStream`.

Why does any of this matter to an ADB client? Because of a detail in Chromium's own IWA policy document, which is unusually candid about the design space:

> The web platform is very opinionated about the kinds of network connections a site can make. The Direct Sockets API allows a site to make unrestricted connections and doesn't require hosts to opt in to connections from the web. This is necessary for some applications, but not every application. **The complement to the Direct Sockets API is the WebTransport API**, which provides equivalent performance when endpoints can be updated to support it.

That sentence is the whole ADB-over-network story in one line. Direct Sockets gives you raw TCP but only to Isolated Web Apps on ChromeOS — a distribution model almost no consumer tool can use. WebTransport gives you a QUIC/HTTP3-backed reliable and unreliable transport that **works in an ordinary web page on every platform**, and Chrome 159 just made it feature-complete enough to build on.

The ADB protocol is, at the wire level, a tiny packet framing over a bidirectional byte stream:

```
24-byte header: command | arg0 | arg1 | payloadLength | checksum | magic
0..payloadLength bytes of payload
```

That framing is transport-agnostic. It rides on USB (WebUSB) today, and it rides on TCP when `adbd` is listening on port 5555. It would ride over a WebTransport stream just as happily — which is precisely why ya-webadb's packet layer is a separate concern from its transports. `AdbPacketSerializeStream` / `AdbPacketHeader` do not know or care what is underneath.

The catch, and it is a real one: **a phone's `adbd` does not speak WebTransport.** WebTransport requires a server that understands HTTP/3 CONNECT with a WebTransport capsule. So ADB-over-WebTransport from a browser necessarily means a relay — some server that accepts a WebTransport session, opens a TCP socket to the phone's ADB port, and pumps bytes. Every existing ADB-over-web project already does this shape over WebSocket: `piping-adb-web`, `adb-websocket-proxy`, `google/artemis`'s `adb_tunnel.py`, `tango-adb/example-nodejs`. The WebTransport version of that relay is the interesting upgrade, because:

- **Datagram prioritisation and send groups** matter for a *multiplexed* ADB connection. ADB over one TCP connection carries a control channel plus `sync:` streams plus `shell:` streams. When you push a large `sync:` pull (a 200 MB APK) and then try to open a `shell:` stream for an interactive prompt, you want the shell to win. `sendOrder` within a send group is the mechanism for saying so — and this is the first browser API that exposes *stream-level* priority, not just datagram-level.
- **Per-stream byte counters** (`bytesReceived` vs `bytesRead`) are exactly what you need to implement the backpressure that `AdbPacketSerializeStream` assumes but a raw TCP socket never gave you. Today a `WritableStream` to a TCP socket applies backpressure only at the OS socket buffer; with a WebTransport stream you can observe the difference between "queued in the network" and "consumed by the ADB layer" and apply your own.
- **`congestionControl: "throughput"`** is the correct setting for a bulk file pull, and `"low-latency"` for an interactive shell session. One connection, two different transports' worth of policy — though in practice you would use separate sessions per traffic class.
- **`exportKeyingMaterial()`** is the answer to "how do I authenticate the relay without inventing a session-token scheme". Binding derived key material to an established WebTransport session, with the CONNECT stream ID folded in so sessions on a shared HTTP/3 connection don't collide, is a cleaner primitive than rolling your own HMAC over a bearer token.

None of this is usable today without writing a relay server, and that is the honest caveat. But the *browser half* of the problem — a transport with real priority control, real backpressure observability, real session-bound key derivation — is what Chrome 159 just delivered, and it is the half that has been missing for the entire history of ADB-in-a-browser.

## Both USB specs are now WHATWG living standards

The second thread is quieter and arguably more durable.

The WebHID specification — which shipped to Chrome on Android in Chrome 158 and which we covered [yesterday](https://webadb.online/blog/2026/11/21/chrome-158-stabilizes-webhid-on-android-and-chrome-160-targets-the-clipboard/) — was converted to Bikeshed and moved onto the WHATWG Living Standard track by [rob-pitkin in `whatwg/hid@6b0ee7c`](https://github.com/whatwg/hid/commit/6b0ee7c) on October 26, 2026. The subsequent commits are the kind of thing that only happens when a spec has a permanent home and a real review cadence:

- [`19ec1aa`](https://github.com/whatwg/hid/commit/19ec1aa) — make `HIDDeviceFilter.vendorId` an unsigned short
- [`5665cd4`](https://github.com/whatwg/hid/commit/5665cd4) — make global state's usage page apply to usage minimum/maximum tags
- [`42294fa`](https://github.com/whatwg/hid/commit/42294fa) — when parsing a report descriptor, append the correct item to `report["items"]`
- [`ae0d0d5`](https://github.com/whatwg/hid/commit/ae0d0d5) — correctly set `reportItem.isRange` iff `usageMinimum <= usageMaximum` and both are present
- [`25e6e56`](https://github.com/whatwg/hid/commit/25e6e56) — correct the polarity of `HIDReportItem.hasPreferredState`
- [`8878f68`](https://github.com/whatwg/hid/commit/8878f68) — reject `HIDDevice.close()` if state is `"opening"` or `"closing"`
- [`1890d6f`](https://github.com/whatwg/hid/commit/1890d6f) — editorial: use `stringIndices` variable in parse report descriptor steps

WebUSB has followed the same road: the repository now lives at [`whatwg/usb`](https://github.com/whatwg/usb) with the spec at `usb.spec.whatwg.org`, and the most substantive recent change is [`3dcc3c2`](https://github.com/whatwg/usb/commit/3dcc3c2d53ac8c8f807c448066d6cb58583a86db) (PR #270, June 5, 2026) — **"Restrict control transfers to standard requests and protected classes"**, following [`337426a`](https://github.com/whatwg/usb/commit/337426a00221f6ce96c2370e8b758b2eeeec9270) which added hubs to the protected interface class list.

That last one deserves a pause, because it is a change to the *WebUSB blocklist*, and webadb lives inside that blocklist's blast radius every day.

The WebUSB spec has always had a "protected interface class" list — device classes that a page is not allowed to control — and the blocklist file (`blocklist.txt` in the spec repo) has been extended over the years with classes like mass-storage, hubs, and HID, to prevent a page from doing something dangerous or hardware-destroying through a generic USB API. ADB interfaces are on that list for a good reason: `FE_ADB` (class `0xFF`, subclass `0x42`, protocol `0x01`) lets the host issue arbitrary commands to the device.

The direction of travel is that the *protected* set grows, and the *unrestricted* escape hatch (`usb-unrestricted`, an IWA-only permission policy) stays IWA-only. That means the story for browser-based ADB is not "WebUSB will open up" — it is "WebUSB's safe subset stays narrow, and any broad USB access route runs through an IWA or through a permission-policy negotiation".

For webadb specifically, this is a *documentation* obligation rather than a code obligation: our connection path targets the ADB interface deliberately and the ADB interface is deliberately restricted, so the honest framing in our UI is the one we already use — the browser shows a per-interface permission prompt, the user grants it, and the transport works. But it does mean that any plan which involves "let the browser drive arbitrary USB" has to go through `usb-unrestricted` and therefore through an Isolated Web App, with its signed-bundle distribution model. That is a much heavier product decision than "add a flag".

## ya-webadb issue #784 names Direct Sockets in production

The third thread is the one that makes the other two concrete.

ya-webadb issue [#784](https://github.com/yume-chan/ya-webadb/issues/784), *"Support Android 11+ 'Wireless debugging' (TLS + pairing code/QR)"*, was opened by CurseStaff on August 22, 2025 and remains open, labelled `type:enhancement`, `help wanted`, `effort: high`. yume-chan's reply, in the first comment, is the crux of the whole problem:

> It requires a pretty complicated pairing process, and uses TLS with client certificate for connection.

The issue's description is worth reading closely, because it describes a *production* deployment that already solved half of this — using Direct Sockets:

> **Connection:** "Direct Sockets", following the documented contract:
> - ReadableStream via `StructDeserializeStream(AdbPacket)`
> - WritableStream\<Consumable\> via `AdbPacketSerializeStream` + `WrapWritableStream`
> - Transport: `AdbDaemonTransport.authenticate({ serial, connection, credentialStore })`

That is ya-webadb's own transport contract, exercised outside a browser, over a raw socket. It confirms the architecture the rest of this post assumes: the ADB packet layer is cleanly separable from the byte-stream layer, and swapping the byte-stream layer is a local change.

What issue #784 needs, and does not yet have, is the Android 11+ wireless-debugging flow:

```
pair({ host, pairingPort, code | qr, credentialStoreForTls })   →  TLS cert
connect({ host, tlsPort, tlsCredentials })                        →  ADB over TLS
```

Two things are missing and both are non-trivial. The **pairing** step is a separate TCP service on a separate port that performs an unauthenticated key-exchange dance, prints a six-digit code (or encodes it in a QR), and issues a client certificate. The **TLS** step then wraps the ADB packet stream in a TLS session using that client certificate plus the ADB RSA host key.

This is why the issue is `effort: high`, and why it matters that the *browser* has no `tls.connect()` equivalent in the general case. In Node, `tls.connect()` is one call. In a browser tab, there is no such API — which is exactly the gap Direct Sockets and WebTransport respectively bracket:

| Path | Browser support | Can carry ADB-over-TLS? |
|---|---|---|
| WebUSB | Chrome 61+, all platforms | No — USB only, and ADB class is protected |
| Direct Sockets | IWA-only, ChromeOS-only | Yes, if the socket is raw TCP to the pairing/TLS ports — but needs an IWA |
| WebTransport | Chrome 123+ (stable everywhere) | Needs a relay; the relay terminates TLS toward the phone |

Note the shape of the Direct Sockets row: `openTCPSocket` to the phone's pairing port *would* work, and it is the natural fit. But Direct Sockets is not available to ordinary pages at all — the API is IWA-only, and as of September 2026 IWAs run only on ChromeOS. The [Chromium IWA launch policy](https://www.chromium.org/blink/launching-features/isolated-web-apps) is explicit that this is a deliberate trade, and the [Direct Sockets docs](https://developer.chrome.com/docs/iwa/direct-sockets) confirm the requirement:

```json
{
  "permissions_policy": {
    "direct-sockets": ["self"],
    "cross-origin-isolated": ["self"]
  }
}
```

Since Chrome 151 (July 28, 2026), the blanket `direct-sockets-private` policy has been replaced by the more granular `local-network` and `loopback-network` policies, and Chrome 158 added **Source-Specific Multicast** for Direct Sockets (tracking bug [#461262401](https://issues.chromium.org/issues/461262401)). The public Chrome origin-trials list as of this writing contains no Direct Sockets trial — the feature is not OT-gated for ordinary sites, it is simply absent from them.

That is the honest state of ADB-over-network in a browser today, and the community projects reflect it precisely. `piping-adb-web`'s compatibility table lists, for Chromium-based browsers: *USB cable — supported using WebUSB API*; *Wireless through WebSocket — supported*; *Wireless through TCP — **WIP using Direct Sockets API***.

Meanwhile, over at ya-webadb, the last 24 hours were genuinely quiet: no commits on `main` since [`a62aacc2`](https://github.com/yume-chan/ya-webadb/commit/a62aacc210897b2f1bc3fb2270b94ec033b45575) (the scrcpy UHID manager, November 20), zero open pull requests, and the newest tag still `v3.0.0-beta.5` from `d22e9dc`. The four open issues are long-haul: #784 (wireless debugging), #640 (use `Symbol.dispose` instead of a custom `Disposable`), #487 (record/replay user input), #343 (fastboot mode).

## What Chrome 159's other entries mean for a desktop-shaped UI

Chrome 159's release notes also carry a few entries that land closer to home for webadb's interface work, and it is worth being specific about which ones actually matter.

**`AccentColor` and `AccentColorText` follow the `accent-color` value** ([feature 6207138742534144](https://chromestatus.com/feature/6207138742534144), bug [#536420071](https://issues.chromium.org/issues/536420071)) — the system colour keywords now reflect the element's effective `accent-color` instead of only the platform accent. Chromium's own note is that this "aligns Chromium's behavior with the CSS Color Module Level 4 specification". For a UI that ships a custom theme switcher — ours does, with a light/dark toggle — this means `AccentColor` stops being a fixed system value and starts tracking whatever the user has set. Low risk, but a real behavioural change for anyone using `AccentColor` as a proxy for "the platform's idea of accent".

**Background layer count independence** ([feature 5144333908049920](https://chromestatus.com/feature/5144333908049920), bug [#40855581](https://issues.chromium.org/issues/40855581)) — computed `background-*` longhands now keep the number of comma-separated values the author specified, instead of being repeated or truncated to the `background-image` layer count. This is a computed-value fix that aligns Chromium with [CSS Values 4 Appendix A](https://drafts.csswg.org/css-values-4/#linked-properties). Practically: if any test suite snapshots `backgroundPosition` / `backgroundSize` / `backgroundRepeat` computed values, those snapshots may change on December 8.

**`CSSImportRule.styleSheet` returns `null`** for an `@import` with no associated stylesheet, including when its `supports()` condition is false ([feature 5123480866783232](https://chromestatus.com/feature/5123480866783232)). Small, but it turns an exception into a `null` check — the kind of change that breaks code doing `rule.styleSheet.cssRules` without a guard.

**Sanitizer API `javascriptURLs` option** ([feature 5169798320357376](https://chromestatus.com/feature/5169798320357376)), from [whatwg/html#12898](https://github.com/whatwg/html/pull/12898) — the Sanitizer now sanitises `javascript:` URLs for navigation, as a developer-selectable option rather than a side effect of which "safe" method you used.

**ServiceWorker Static Routing: a distinct `TypeError` for a cancelled race** ([feature 5124748525830144](https://chromestatus.com/feature/5124748525830144), bug [#584504247](https://crbug.com/584504247)) — a `fetch()` inside a `race-network-and-fetch-handler` handler that gets cancelled now rejects with a specific message rather than a generic `Failed to fetch`. Chromium shipped this as an Intent to Ship directly, explicitly because applications may observe the message string.

**SpeechRecognitionResult timestamps** ([feature 5811907077472256](https://chromestatus.com/feature/5811907077472256), bug [#528037568](https://issues.chromium.org/issues/528037568)) — `speechStartTime` / `speechEndTime` on `SpeechRecognitionResult`, per the [WebAudio/web-speech-api#192](https://github.com/WebAudio/web-speech-api/pull/192) proposal. Not our business today, but it is the sort of feature that makes on-device voice control of an ADB session practical later.

And in Chrome 160 on Dev (`160.0.8171.0`, branch `r1742402`, branched November 30, Beta December 2, Stable January 5, 2027), the CSS corner shorthand family and `startViewTransition({ shadowRoots })` are the visible items — plus `Canvas2D` tone mapping and `CSSPseudoElement.selectorText` pending review. Nothing device-peripheral. The `Regular Expression Buffer Boundaries` proposal (`\A`, `\z`, `\Z` in Unicode-mode regexes, bug [#517575874](https://issues.chromium.org/issues/517575874)) is pending review and would be a genuine ergonomics win for a codebase that parses a lot of logcat lines.

## Where this leaves webadb.online

Three concrete takeaways, in descending order of how much they matter.

**One — the transport story just got a second browser-native option, and it is the one that works on ordinary pages.** WebUSB remains the default and should remain so: it is one permission prompt and a cable, with no server in the middle. But the ADB packet framing is transport-agnostic by design, and Chrome 159 just shipped the WebTransport half of the stack — priority groups, per-stream byte counters, congestion-control policy, session-bound key derivation — that a relay-based ADB-over-network transport would need to be genuinely good rather than merely functional. The work item on our side is not a protocol implementation; it is a spike on whether a WebTransport relay can carry `AdbPacketSerializeStream` traffic with acceptable latency for interactive shell sessions. That is a bounded experiment.

**Two — the Direct Sockets path we already ship is the right shape for issue #784, and it is also the path that cannot ship to normal users.** Our `lib/adb-daemon-tcp.ts` already opens `navigator.openTCPSocket({ remoteAddress, remotePort, noDelay: true })` and frames ADB packets over it, which is exactly the transport contract in issue #784. It works today behind a flag or OT token. It will not work for our users at scale, because Direct Sockets is IWA-only and ChromeOS-only, and there is no public origin trial. The honest consequence is that our wireless-connect UI should describe itself as experimental and flag-gated — and that the real fix for #784 (TLS pairing) is a **server-side** problem in the shape of a relay, not a browser-API problem.

**Three — the WebUSB blocklist's protected-class list is growing, so "just widen the browser's USB access" is not a plan.** `whatwg/usb@3dcc3c2` restricting control transfers to standard requests and protected classes, plus hubs joining that list, is the trend line. Any plan that needs broad USB access has to go through `usb-unrestricted` and therefore through an Isolated Web App with signed-bundle distribution. That is a product decision with a distribution model attached, and it should be weighed as such rather than as "a browser flag".

None of this is urgent for our users, and we have not shipped a code change based on it. But the shape of the ecosystem moved this week: the transport layer got real, the specs got a permanent home, and the gap between "what an ADB client could do in a browser" and "what the browser actually lets it do" narrowed by one meaningful step.

The weekly Chrome Direct Sockets check was skipped today — that sweep runs on Mondays only. The Direct Sockets facts quoted above were gathered incidentally because they are load-bearing for the ADB story, not as a substitute for that sweep.
