---
title: "Web Bluetooth learns the ATT MTU, and WebSocket over HTTP/3 gets a test server"
date: 2026-11-14 01:00:00 UTC
tags:
  - web-bluetooth
  - att-mtu
  - http3
  - websocket
  - adb
---

Chromium shipped `BluetoothRemoteGATTServer.maxWriteWithoutResponseSize` to stable on Friday, flipping a feature flag that has been baking since June, and in the same commit range the Web Platform Tests tooling gained a WebSocket-over-HTTP/3 server built on `aioquic` — the first time Chromium has a conformance harness for RFC 9220's Extended CONNECT. Neither change touches ADB directly, but both sit in the same layer of the stack that browser-based ADB clients live in, and the second one is the more interesting of the two.

## The Bluetooth flag flip: `0f168258bb7b`

The headline commit is short, and that is how you know it is a shipping commit rather than a feature commit:

```
Web Bluetooth: Enable maxWriteWithoutResponseSize by default

Flips WebBluetoothMaxWriteWithoutResponseSize to stable so that
BluetoothRemoteGATTServer.maxWriteWithoutResponseSize and its
maxwritewithoutresponsesizechanged event are exposed by default, and rebases
the virtual/stable interface listings of the platforms that ship Web
Bluetooth.

Bug: 40265040
Change-Id: Ie03aa3944acea745bfe163346ff6c7b83a92f0aa
I2S: https://groups.google.com/a/chromium.org/g/blink-dev/c/hC1OI_Fl8-E/m/T7IncWmqCgAJ
Reviewed-on: https://chromium-review.googlesource.com/c/chromium/src/+/8814955
Reviewed-by: Mike Taylor <miketaylr@chromium.org>
Commit-Queue: Helmut Januschka <helmut@januschka.com>
Cr-Commit-Position: refs/heads/main@{#1744096}
```

Three files changed:

```
modified  +   1/-   1  third_party/blink/renderer/platform/runtime_enabled_features.json5
modified  +   3/-   0  third_party/blink/web_tests/platform/mac/virtual/stable/webexposed/global-interface-listing-platform-specific-expected.txt
modified  +   3/-   0  third_party/blink/web_tests/platform/win/virtual/stable/webexposed/global-interface-listing-platform-specific-expected.txt
```

The `runtime_enabled_features.json5` diff is one line — `WebBluetoothMaxWriteWithoutResponseSize` moves from an experimental entry to a flat `status: "stable"`. That single-line change is the entire feature flip; everything else in this commit is bookkeeping.

The two `global-interface-listing-platform-specific-expected.txt` files are the real tell: shipping a Web API to stable means the IDL has to appear in the *virtual stable* interface listing, which is the file Blink uses to guarantee that a feature's surface does not change once it reaches stable. The Mac and Win files gained three lines each:

```
    getter maxWriteWithoutResponseSize
    getter onmaxwritewithoutresponsesizechanged
    setter onmaxwritewithoutresponsesizechanged
```

A readonly getter for the attribute, and a getter/setter pair for the event handler. The Linux and Android listings did not change, because those platforms ship the feature under a different baseline — which is exactly the kind of asymmetry that the platform-specific listing files exist to record.

This landed at `Cr-Commit-Position: refs/heads/main@{#1744096}`. The Chrome 159 beta build currently in circulation is at `{#1739869}` — the branch point from November 12. The difference is **4,227 commits**, so the flag flip is not in Chrome 159. It is on `main` and will ship in Chrome 160, whose branch point is scheduled for November 30. Canary is already running past it at `160.0.8160.0` / position `{#1744042}`, which is 54 commits *before* the flip — so even Canary does not have it yet.

### The API, and the arithmetic behind it

The spec change is [whatwg/bluetooth PR #672](https://github.com/whatwg/bluetooth/pull/672), "Add BluetoothRemoteGATTServer.maxWriteWithoutResponseSize", opened by hjanuschka on **2026-06-18** and last touched on **2026-11-02**. It has been under review for nearly five months — the thread shows `reillyeon` requesting changes on 2026-06-22, approving on 2026-08-07, requesting changes again on 2026-08-26, and approving again the same day. The WHATWG PR is still **open**, which is worth noting: Chromium shipped to stable ahead of the spec landing. That is normal for a WHATWG feature with a single implementation, but it does mean the shape of the API is currently Chromium's to define.

The WebIDL is one line:

```webidl
readonly attribute unsigned short maxWriteWithoutResponseSize;
```

The value is the largest payload, in octets, that a single `writeValueWithoutResponse()` can carry without being rejected. It is derived from the ATT MTU negotiated for the connection — formally, the smaller of the local Host's transmit ATT_MTU and the peer's receive ATT_MTU — minus the three-octet ATT Write Command header. When no MTU exchange has happened, the value is `23 - 3 = 20` octets.

The spec text spells out why returning `ATT_MTU - 3` rather than the raw MTU is the right call:

> Returning `ATT_MTU - 3` (inspired by CoreBluetooth's `maximumWriteValueLengthForType:`) rather than the raw MTU means callers don't have to know to subtract the ATT Write Command header themselves.

That is the same design decision Apple's CoreBluetooth made years ago, and it is the difference between an API that is usable and one that requires every caller to hard-code a magic subtraction.

### Why the old behaviour was actually broken

The PR body describes the status quo more bluntly than a spec document usually allows itself to:

> Today there's no way for a site to know how big a single write can be. The practical pain is `writeValueWithoutResponse()`: if you hand it more than `ATT_MTU - 3` bytes, the write either fails or gets silently chopped depending on the platform, and the page has no way to tell ahead of time. People end up hard-coding 20 (the old default payload) to be safe, which leaves a lot of throughput on the table on modern devices that happily negotiate 247+.

"Silently chopped depending on the platform" is the operative phrase. Before this API, the correct portable behaviour for a web page writing to a GATT characteristic without a response was to assume the worst-case 20-byte payload, because anything larger might work on one OS and be truncated on another. Every Web Bluetooth throughput path was paying for the weakest link in the ecosystem.

The value is backed by an internal slot on the server rather than the characteristic. The spec text is explicit about the placement decision:

> The attribute lives on the GATT server (rather than the characteristic) to match the device-level MTU exposure of most platform APIs, per the spec discussion in https://github.com/whatwg/bluetooth/pull/672.

The MTU is a property of the *link*, not of any particular characteristic, so putting it on the server is the semantically correct choice — and it also means a page does not have to hold a characteristic handle just to read the MTU.

### The event, and the rule that it never fires alone

The change is not just an attribute. There is a `maxwritewithoutresponsesizechanged` event, fired at the `BluetoothRemoteGATTServer`, and the spec text pins down its semantics precisely:

> The value is backed by an internal slot on the server: it starts at 20, is established when the connection is made, and is updated only when the UA observes an ATT_MTU change -- at which point a `maxwritewithoutresponsesizechanged` event fires at the `BluetoothRemoteGATTServer` itself. The value never changes without the event firing. The event deliberately doesn't carry the value; listeners read the attribute, keeping a single source of truth.

Two design choices there, both worth internalising:

1. **The event carries no payload.** A listener reads the attribute after the event fires. This makes it impossible for the event's value and the attribute to disagree — there is exactly one source of truth, and the event is only the notification that it moved.
2. **The value never changes without the event.** This is a strong guarantee, and it is what lets a page cache the value safely.

### The four-commit shape of the feature

The Bluetooth work arrived as a coordinated four-commit set on 2026-11-13, and the order matters because it shows the pattern Chromium uses to ship a Web API without breaking anyone:

| SHA | Time (UTC) | What |
|---|---|---|
| `ec147d693015` | 07:54 | Expose `maxWriteWithoutResponseSize` |
| `2f633169c9b9` | 08:20 | Simulate ATT MTU changes in the emulation layer |
| `1bf993a44a20` | 08:41 | Add `bluetooth.simulateGattMtuChange` to WebDriver BiDi |
| `44afa7123705` | 08:52 | Test `maxWriteWithoutResponseSize` |

The implementation commit `ec147d693015` touches **twenty-six** files, spanning four platform backends:

```
modified  +  14/-  0  content/browser/bluetooth/frame_connected_bluetooth_devices.cc
modified  +  56/-  8  content/browser/bluetooth/web_bluetooth_service_impl.cc
modified  +  46/-  0  device/bluetooth/bluetooth_adapter_winrt.cc
modified  +  32/-  0  device/bluetooth/bluetooth_low_energy_device_mac.mm
modified  +   0/-  8  device/bluetooth/bluez/bluetooth_adapter_bluez.cc
modified  +   7/-  6  device/bluetooth/android/java/src/org/chromium/device/bluetooth/ChromeBluetoothDevice.java
```

The `bluez` files lose eight lines each and gain none — on Linux, where BlueZ owns the socket, the negotiated MTU is not observable by Chromium, so the platform implementation does not have to do anything. The WinRT and Mac backends each gain a fair number of lines because they *do* observe it and must push it up through the mojo boundary. This is the shape of a platform-conditional API: the interface is uniform, the plumbing is not.

### The testing story, and why it matters more than the feature

The most interesting commit in the set is not the feature — it is the one that makes the feature testable by *other* browsers. `2f633169c9b9` adds `BluetoothEmulation.simulateGattMtuChange` to the DevTools protocol:

```
Adds BluetoothEmulation.simulateGATTMtuChange to the DevTools protocol so
tests can drive the ATT MTU of a simulated peripheral, which is what
BluetoothRemoteGATTServer.maxWriteWithoutResponseSize is derived from.
FakePeripheral keeps the simulated MTU until the connection goes away, and
values below the smallest valid ATT_MTU are rejected.
```

And `1bf993a44a20` exposes the same capability through WebDriver BiDi, which is the cross-browser standard:

> Lets a test negotiate an ATT MTU with a simulated peripheral, which is what maxWriteWithoutResponseSize is derived from. The mapper forwards the command to BluetoothEmulation.simulateGATTMtuChange.
>
> The wptrunner and testdriver plumbing mirrors the proposed upstream patch, so it is replaced by the next wpt tooling roll once that lands.

That last sentence is a nice piece of Chromium-internal honesty: the WPT-side plumbing was written by hand because the upstream `webdriver-bidi` patch had not landed yet, and the commit explicitly says it will be clobbered by the next tooling roll. Then `44afa7123705` adds three WPT test files that run against *any* implementation:

```
added  +  16/-  0  third_party/blink/web_tests/external/wpt/bluetooth/bidi/server/maxWriteWithoutResponseSize/default-att-mtu.https.window.js
added  +  20/-  0  third_party/blink/web_tests/external/wpt/bluetooth/bidi/server/maxWriteWithoutResponseSize/mtu-change.https.window.js
added  +  24/-  0  third_party/blink/web_tests/external/wpt/bluetooth/bidi/server/maxWriteWithoutResponseSize/reconnect.https.window.js
```

The commit message enumerates what they cover:

> Covers the default ATT_MTU, the `maxwritewithoutresponsesizechanged` event after an MTU exchange, and the reset back to the default on reconnection.

Three behaviours, three files: the default value, the change event, and the reset-on-reconnect. The third is the one that is easy to get wrong — a page that caches the MTU across a reconnect would use a stale value, and the test pins the reset behaviour down.

### A bug fix buried in the same commit

`2f633169c9b9` also contains an unrelated-looking fix that is worth pulling out, because it is a genuinely gnarly activation bug:

> `BluetoothHelper.requestDevice()` now takes user activation from a dispatched input event. The activation from `Runtime.evaluate`'s userGesture flag was not reliably in place when `requestDevice()` ran, which rejected it with a `SecurityError` in about 3% of runs.

Three percent of runs failing with a `SecurityError` on `requestDevice()`, caused by the user-activation flag being set asynchronously by `Runtime.evaluate` but read synchronously by `requestDevice()`. The fix sources the activation from a dispatched input event instead — a synthetic click — so the activation is definitely live at the moment the call happens.

This is a nice illustration of how transient-activation timing works in practice: the flag is not a boolean you set, it is a *state* that has to be present at the exact moment the gated API runs. If you are building anything on top of Web Bluetooth and you hit a flaky `SecurityError` in automation, this is the commit to read.

## The bigger story: WebSocket over HTTP/3 gets a conformance server

The second headline is `2ba044b798ac`, and it is less flashy but considerably more consequential for anything that wants to move a byte stream over HTTP/3.

```
Roll WPT tooling for WebSocket over HTTP/3

Roll web-platform-tests tooling to include websocket over h3 support at
014392209697fc89f5faa223d41aab8b5122f2eb.

Bug: 40210995
Cq-Include-Trybots: luci.chromium.try:linux-blink-rel
Change-Id: I9147d18c35e91075da7b8e2671f82e9e79b543a9
Reviewed-on: https://chromium-review.googlesource.com/c/chromium/src/+/8808136
Reviewed-by: Jonathan Lee <jonathanjlee@google.com>
Commit-Queue: Liang Zhao <lzhao@microsoft.com>
Cr-Commit-Position: refs/heads/main@{#1744287}
```

The diff adds **1,943 lines** of new Python and **deletes** none, including a complete HTTP/3 WebSocket server built on `aioquic`:

```
added  +    0/-   0  third_party/wpt_tools/wpt/tools/websocket/__init__.py
added  +    0/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/__init__.py
added  +  230/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/h3_wptserve_adapter.py
added  +   36/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/headers.py
added  +  924/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/tests/test_websocket_h3_server.py
added  +  120/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/tests/test_ws_h3_handshake.py
added  +  726/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/websocket_h3_server.py
added  +  252/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/websocket_h3_session.py
added  +   65/-   0  third_party/wpt_tools/wpt/tools/websocket/h3/ws_h3_handshake.py
```

### The mechanism: Extended CONNECT

The server's core is a three-line subclass of `aioquic`'s `H3Connection`:

```python
class H3ConnectionForWebSocket(H3Connection):
    """H3Connection subclass that enables Extended CONNECT for WebSocket."""

    ENABLE_CONNECT_PROTOCOL = 0x08

    def _get_local_settings(self) -> Dict[int, int]:
        settings = super()._get_local_settings()
        settings[self.ENABLE_CONNECT_PROTOCOL] = 1
        return settings
```

Setting `0x08` in the HTTP/3 SETTINGS frame is what enables the Extended CONNECT protocol. This is the same mechanism WebTransport uses — RFC 9220's WebSocket-over-HTTP/3 and RFC 9297's WebTransport-over-HTTP/3 are siblings, both built on the HTTP/3 Extended CONNECT verb, both gated behind the same `SETTINGS_ENABLE_CONNECT_PROTOCOL` bit.

That shared mechanism is the point. The transport layer is converging on one way to open a bidirectional stream inside an HTTP/3 connection, and Chromium now has a *conformance test harness* for it.

The server file's own docstring lays out the scope:

> This is the main entry point for the WebSocket H3 server. It owns the QUIC server lifecycle, creates the HTTP/3 connection object, dispatches incoming H3 events, handles Extended CONNECT requests for WebSocket streams, and serves normal WPT resources over the same H3 port through wptserve adapters.

And the adapter file explains the non-obvious part:

> The WebSocket H3 server must serve more than WebSocket CONNECT streams: tests also load HTML, JavaScript, CSS, Python handlers, and `.sub.` resources from the same H3 origin. wptserve already knows how to route those requests and apply the WPT response pipeline, but it expects HTTP/1-style request handler objects.
>
> This module provides the small compatibility layer between aioquic HTTP/3 events and wptserve.

So this is not a toy server — it is a real HTTP/3 origin that also serves the static assets a WPT test page needs, with the `connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, and `upgrade` headers explicitly filtered out (`_H3_FORBIDDEN_RESPONSE_HEADERS`) because those are HTTP/1 connection-management headers that HTTP/3 forbids.

### Why a WPT server is the thing that actually unblocks a feature

A conformance server is a deceptively high-leverage piece of infrastructure. Writing the server is the boring half; the valuable half is that once the server exists, *every browser* can run the same test files against it, and any browser that wants to implement WebSocket-over-HTTP/3 has a reference implementation to diff against.

The commit is authored by Liang Zhao and reviewed by Jonathan Lee, and the trybot is `luci.chromium.try:linux-blink-rel` — the Blink release trybot. That trybot selection matters: it means the WebSocket-H3 server is exercised on the release-blocking configuration, not just on the experimental one.

### What this means for a browser-based ADB client

Here is where the connection to webadb becomes concrete. webadb's transport story is: WebUSB today, and eventually WebTransport or Direct Sockets for a TCP path to `adbd`. All three of those converge on the same underlying problem — **carrying a bidirectional byte stream with framing over a protocol the browser does not natively expose as a raw socket**.

WebSocket-over-HTTP/3 is a fourth path to the same goal, and it is a *good* one for ADB specifically, because ADB's wire protocol is already a framed protocol with a length-prefixed header. RFC 6455's WebSocket framing and ADB's `CNXN`/`OPEN`/`DATA` framing are both trivially mappable: send the ADB payload as a WebSocket binary message, and the stream framing is free.

Chromium shipping an `aioquic`-based conformance server means a browser-side ADB-over-WebSocket-over-HTTP/3 client could, in principle, be validated against a real reference server rather than against a hand-rolled one.

## The QUIC fix that nobody will notice

Between the two headline features, Chromium landed a QUIC bug fix with a distinctive shape — Patrick Meenan's `4ce6260180da`:

```
Fix QuicHttpStream::IsConnectionReused() before stream creation

QuicHttpStream::IsConnectionReused() returned false whenever `stream_`
was null. If a pooled QUIC session closed after a request was bound to
it but before InitializeStream() created a stream,
HttpNetworkTransaction did not retry the resulting
ERR_CONNECTION_CLOSED, even though the session had already been used.

When `stream_` is null, IsConnectionReused() now checks whether the
session was ever used to create streams. That state is cached on the
session Handle so it is still available after the session closes. Like
HTTP/1.1 idle sockets and HTTP/2, preconnected sessions are always
treated as reused.

Bug: 584819136
Change-Id: I226956a0e0f51cfcd872c5762020488ec5afa616
Reviewed-on: https://chromium-review.googlesource.com/c/chromium/src/+/8808155
Reviewed-by: Nidhi Jaju <nidhijaju@chromium.org>
Commit-Queue: Patrick Meenan <pmeenan@chromium.org>
Cr-Commit-Position: refs/heads/main@{#1744296}
```

The bug is a race with a tiny window: a request binds to a pooled QUIC session, the session closes before `InitializeStream()` runs, the stream is null, `IsConnectionReused()` returns false, and so `HttpNetworkTransaction` does *not* retry the `ERR_CONNECTION_CLOSED`. But the session had already been used — retrying is safe and correct, and skipping it surfaces a spurious network error to the user.

The fix caches "was this session ever used to create streams" on the session *handle*, precisely because the handle outlives the session object that the null-`stream_` case used to be reading from. And the rule it lands on is clean: preconnected sessions are always treated as reused, matching how HTTP/1.1 idle sockets and HTTP/2 already behave.

The diff is small but the test diff is not:

```
modified  +  24/- 11  net/quic/quic_chromium_client_session.cc
modified  +  11/-  2  net/quic/quic_chromium_client_session.h
modified  +  37/-  1  net/quic/quic_http_stream.cc
modified  + 190/-  1  net/quic/quic_http_stream_test.cc
modified  + 266/-  0  net/quic/quic_network_transaction_unittest.cc
```

Two new test files, 456 lines of test coverage for a 70-line implementation change. `Nidhi Jaju` reviewed it — the same reviewer as yesterday's WebTransport handshake-crash fix, which is a nice coincidence given how much of the recent QUIC work in Chromium has been reviewed by one person.

This is the class of bug that matters enormously for a WebTransport-based ADB client, because the WebTransport transport *is* a QUIC session in Chromium's stack, and "connection closed under me, do I retry or do I surface an error" is exactly the question an ADB client has to answer when the user's laptop sleeps and the QUIC session dies.

## And the security fix that is really an architecture fix

`641160e24b18`, by Yi Gu, closes a WebOTP Permissions Policy hole:

```
[WebOTP] Enforce Permissions Policy in the browser

Previously, only Blink checked the "otp-credentials" Permissions Policy
before a frame used WebOTP. The browser bound WebOTPService for any
frame that requested it, so a compromised renderer could use WebOTP in a
frame where the embedder did not allow it.

Now, the browser also checks the policy when it binds WebOTPService, and
terminates the renderer if the policy is disabled for the frame. This
matches other browser interfaces that are gated by Permissions Policy,
e.g. PictureInPictureService. Frames that are allowed to use WebOTP are
not affected, since Blink requests WebOTPService only after its own
check passes. The SMS origin matching and the user consent prompt stay
the same.

Fenced frames need no separate check since they have been removed.

This adds BindWebOTPService() to browser_interface_binders.cc for the
check, and the BIBI_BIND_WEBOTP_SERVICE_BLOCKED_BY_PERMISSIONS_POLICY
bad message reason.
```

The shape of this bug is worth dwelling on, because it is a recurring pattern in Chromium's multi-process architecture. Blink (the renderer) checked a Permissions Policy. The browser process (the privileged side) did not. A compromised renderer — which by definition has already escaped Blink's own checks — could therefore request the service anyway, and the browser would hand it over.

The fix is to enforce the policy **at the binding layer**, in the browser process, where the decision cannot be forged. The new `bad message` reason is the interesting part:

```
modified  +   1/-   0  content/browser/bad_message.h
modified  +  19/-   3  content/browser/browser_interface_binders.cc
modified  +  59/-   0  content/browser/sms/sms_browsertest.cc
modified  +   2/-   0  tools/metrics/histograms/metadata/stability/enums.xml
```

If a renderer requests a service it is not allowed, the browser **terminates the renderer**. This is the same "the browser process does not trust the renderer" pattern that Chromium has applied to every other Permissions-Policy-gated browser interface. WebOTP was an outlier, and it is now not.

This is not ADB news, but it is the kind of thing that determines whether a feature can be shipped to embedded frames — and `webadb.online` runs as a static site with no framing guarantees in the first place, so it is a reminder that Permissions Policy is a real deployment constraint for any browser-embedded device tooling.

## The rest of the surface: quiet, as expected

A path-scoped sweep of Chromium's `main` since November 12 confirms the shape:

| Tree | Commits since Nov 12 |
|---|---|
| `third_party/blink/renderer/modules/webusb/` | **0** |
| `third_party/blink/renderer/modules/serial/` | **0** |
| `third_party/blink/renderer/modules/webhid/` | **0** |
| `third_party/blink/renderer/modules/webtransport/` | **0** |
| `third_party/blink/renderer/modules/direct_sockets/` | **0** |
| `net/usb/` | **0** |
| `net/quic/` | **4** |
| `device/bluetooth/` | **3** |
| `content/browser/bluetooth/` | **1** |

The WebUSB, Web Serial, WebHID, WebTransport, and Direct Sockets trees were all completely untouched. WebTransport's last change was the handshake-crash fix `fafa2796e51f` on November 12 — the same commit this blog covered yesterday — and the two QUIC commits that followed it are the ones above.

The Chrome for Testing channel positions right now:

| Channel | Version | Position |
|---|---|---|
| Stable | 157.0.8103.78 | 1717349 |
| Beta | 159.0.8154.6 | 1739869 |
| Dev | 160.0.8157.0 | 1742402 |
| Canary | 160.0.8160.0 | 1744042 |

The Bluetooth flag flip at `{#1744096}` is 54 commits ahead of Canary. It will be in Chrome 160, whose branch point is November 30.

## ya-webadb: still quiet

On the ADB side of the ledger, `yume-chan/ya-webadb` has not moved since `v3.0.0-beta.5` on **2026-11-06**, which this blog covered on November 7. The npm registry confirms it:

```
@yume-chan/adb dist-tags: { latest: "2.6.4", beta: "3.0.0-beta.5" }

3.0.0-beta.3  2026-09-17T13:53:30.335Z
3.0.0-beta.4  2026-10-09T08:06:25.909Z
3.0.0-beta.5  2026-11-06T02:06:33.192Z
```

The most recently updated issue or PR in the repository is still **#878** from November 6. There is no open PR newer than that, no release newer than that, and no commit on `main` newer than `d22e9dc3` ("chore: release v3.0.0-beta.5").

The `w3c/webtransport` specification repository is in the same state as yesterday: head still `91b5a73`, no merge since November 4, and the fourteen unreviewed PRs from `JinDX` still sitting there with empty review arrays.

## What this means for webadb.online

**No direct impact on webadb this week.** Neither the Bluetooth API nor the WebSocket-over-HTTP/3 conformance server changes anything webadb does today, and the ya-webadb upstream has been quiet for eight days.

But three of the four items on this list are relevant to where webadb is heading, and one of them is relevant to what webadb does *right now*:

**The Bluetooth MTU API is a template for the class of problem webadb keeps hitting.** webadb's File Manager and APK panels hit the same shape of problem in a different layer: the device's ADB protocol has a maximum payload size (`MAX_PAYLOAD` is 64 KB on the wire), and a browser client that wants to move a large file over it has to chunk at a boundary it cannot always see. The Bluetooth change is instructive because Chromium solved it the way the web platform should: expose the negotiated limit as a first-class attribute, fire an event when it changes, and guarantee that the attribute never moves without the event. If webadb ever surfaces a chunk-size limit to the user, that is the shape to copy.

**The WebSocket-over-HTTP/3 server is the most concrete news in a while for the "ADB over the network, in the browser" story.** Chromium now has a reference HTTP/3 origin that speaks RFC 9220's Extended CONNECT, built on the same `aioquic` stack that any independent implementation would use. That means the "put a TCP bridge in front of `adbd` and reach it from the browser" design has a testable target on both ends. webadb's Wi-Fi ADB panel currently speaks raw TCP to the device's `adbd` on port 5555 — which a browser cannot do without Direct Sockets. Wrapping that same connection in a WebSocket, carried over HTTP/3, is a path that does not need the Direct Sockets origin trial at all. It is not on the roadmap today, but the pieces it depends on just got much more real.

**The QUIC connection-reuse fix is a bug class webadb will inherit the moment it ships a WebTransport transport.** Chromium's `IsConnectionReused()` returning `false` for a session that had in fact been used is exactly the shape of the failure that shows up as "my ADB session randomly dies and does not reconnect". The fix — cache "was this session ever used" on the *handle* so it survives the session closing — is the model to copy when webadb's own transport layer eventually caches a pooled connection.

**And the WebOTP Permissions Policy fix is a reminder about embedding.** If webadb ever wants to be embedded in a third-party site — a kiosk mode, a lab dashboard, a CI panel — Permissions Policy becomes a hard constraint on which device APIs the frame may use. WebUSB and WebTransport both require permissions-policy delegation from the embedder. Chromium's new "terminate the renderer if the policy is disabled" behaviour is the enforcement that makes those policies real rather than advisory.

Chrome 159 goes stable December 8. Chrome 160 branches November 30, and it is the milestone that will carry the Bluetooth MTU API, the WebSocket-over-HTTP/3 conformance server, and — if it stays on schedule — the WebTransport handshake-crash fix that landed on November 12.
