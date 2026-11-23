---
title: "The WebUSB claim-interface friction, and a quiet Direct Sockets week"
date: 2026-11-23 01:15:00 UTC
tags:
  - webadb
  - webusb
  - chromium
  - direct-sockets
  - adb
---

Chrome 159 crossed into Early Stable on November 18 at `159.0.8154.13`, and the more interesting movement this week was not in a release note at all — it was in the Chromium bug tracker, where two separate Windows and macOS WebUSB defects landed on the exact API call that webadb's connection path depends on. `claimInterface()` — the single call that decides whether a web page gets to talk to a phone at all — has now produced two shipping-blocker-shaped regressions in two months. Meanwhile the weekly Direct Sockets sweep came back with nothing: the WICG repository has not moved in a month, the ChromeStatus entry has not been touched since January 2025, and the API remains IWA-only, ChromeOS-only, and outside any public origin trial.

Taken together this is a week about *friction at the permission boundary*. The transport story is stalled where it has been stalled; what changed is how much sharp edges sit between "the user plugged in a phone" and "the page can send an ADB packet".

## Chrome 159's Early Stable, and two WebTransport entries we hadn't counted

Chrome 159 branched from `main` on November 9, went to Beta on November 11 as `159.0.8154.6`, hit Early Stable on November 18, and reaches full Stable on **December 8, 2026** — a three-week window, because the release train now straddles the year-end holidays. Chrome 160 branched November 30 and lands in Beta on December 2, Stable January 5, 2027. If you are testing webadb against a browser channel, the version you want is 159.0.8154.13 on Stable, not 159.0.8154.6.

Yesterday's post covered the six WebTransport features that shipped in Chrome 159. Pulling the full release-notes page again this week surfaced two more that I had under-counted, and both are worth having in the mental model for a relay-based ADB-over-network transport.

**WebTransport connection statistics** ([feature 5120203192139776](https://chromestatus.com/feature/5120203192139776)) — `WebTransport.getStats()` now returns round-trip time measurements when available, an estimated sending rate when available, and counts of expired, lost, and dropped datagrams. The note is specific about the limits: *Chromium does not currently expose connection byte or packet totals*. So the statistic you get is a latency-and-loss view, not a throughput view. For an ADB relay that is arguably the more useful half — an interactive `shell:` session cares about RTT and about datagram loss, and does not care how many bytes moved.

**WebTransport Datagram readable stream type** ([feature 5148774971342848](https://chromestatus.com/feature/5148774971342848)) — `datagramsReadableType: "bytes"` opts into a BYOB readable byte stream instead of the default `ReadableStream`. Combined with the `WebTransportReceiveStream` interface from yesterday (`getStats()` distinguishing `bytesReceived` from `bytesRead`), the browser now offers both directions of a proper flow-control accounting for a byte-oriented protocol. `AdbPacketSerializeStream` is a byte-oriented protocol with a hard 24-byte header and a payload length field, which is exactly the shape that BYOB reading serves well.

And the other half of Chrome 160's Dev channel is not device-peripheral either: `Canvas2D` tone mapping, `SVG Path Data API` (`getPathData()` / `setPathData()` / `getPathSegmentAtLength()`), `Capability Elements` icon-only mode, case-sensitive anchor matching in quirks mode, and the `Regular Expression Buffer Boundaries` proposal (`\A`, `\z`, `\Z`) still pending review. That last one would be a genuine ergonomics win for a logcat parser that currently has to hand-roll end-of-line anchors.

## The WebUSB active-configuration bug on Windows

The significant find this week is Chromium bug [#574558283](https://issues.chromium.org/issues/574558283), filed October 16, 2026 by a third-party reporter, assigned to Chromium's own USB team on October 29, and still **Assigned** rather than Fixed as of this writing. It is tagged `BugBountyCandidate-Small`, which means Chromium is still deciding whether it has security weight.

The bug, in the reporter's words: *on Windows, `USBDevice.configuration` is always the device's first configuration, even when Windows has put the device in a different one*. Blink validates `claimInterface()` against the configuration Blink believes is active. So if the real active configuration contains interfaces that the first configuration does not, those interfaces cannot be claimed — and `claimInterface()` throws:

```
The interface number provided is not supported by the device in its current configuration.
```

And there is no escape hatch, because `selectConfiguration()` is unsupported on Windows and throws `NetworkError: Unable to set device configuration.`

The root cause analysis in the bug is precise and worth reading in full, because it is a three-step data-loss bug:

1. `UsbDeviceWin::ReadDescriptors()` opens `hub_path_` and calls `ReadUsbDescriptors()` via a `UsbDeviceHandleWin` on the *hub* handle.
2. The device-descriptor request is served by `IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX`, which calls `device_->ActiveConfigurationChanged(CurrentConfigurationValue)` — storing the real value (4, in the reporter's case) in `device_info_->active_configuration`.
3. `UsbDeviceWin::OnReadDescriptors()` then **replaces** `device_info_` with `descriptor->device_info`, copying only `guid`, `bus_number` and `port_number` from the old object. The new object, built by `ReadUsbDescriptors()`, never has `active_configuration` set — `usb_descriptors.cc` does not touch it.
4. `GetActiveConfiguration()` now finds nothing, and the existing fallback kicks in: `configurations()[0]`.

The fallback's own comment says it plainly:

> The active configuration was set after reading the node connection info from the hub driver. If it wasn't valid, assume the first configuration.

The intent was for the hub's value to survive. Step 3 throws it away. The suggested fix is a single assignment:

```cpp
descriptor->device_info->active_configuration =
    device_info_->active_configuration;
```

with the existing fallback left in place to cover the case where the hub genuinely reported nothing valid. A patch exists at [chromium-review 8604626](https://chromium-review.googlesource.com/c/chromium/src/+/8604626).

Why does this matter to webadb specifically? Because of the target the bug's own impact statement names:

> Any multi-configuration device whose WebUSB interface is not in configuration 1 is unusable from WebUSB on Windows, even when Windows is set up to select the right configuration: a page can neither see that configuration as active nor select it.

A phone in ADB mode is not a multi-configuration device — the ADB interface lives in configuration 1 — so the common path is unaffected. But this is not true of every Android configuration. Devices that expose a composite USB interface set (some OEM accessory modes, some phones that present a camera or mass-storage interface alongside ADB) can end up in a non-default configuration, and in that case the failure mode is not "your phone is not supported" but `claimInterface()` throwing a message that reads like the user did something wrong.

Note also the adjacent bug the reporter explicitly distinguishes from this one: [#437728196](https://issues.chromium.org/issues/437728196), *WebUSB control transfers with recipient: 'endpoint' only work for the first interface*. Same Windows backend, different symptom — that one is about endpoint-recipient control transfers reaching later interfaces, this one is about the claim being rejected before any transfer happens. Two separate Windows WebUSB defects in the same backend, and both are invisible to anyone testing with a single-configuration device.

## The macOS reset() regression and the WebHID blocklist going live

The second Chromium item is [#579833799](https://issues.chromium.org/issues/579833799), an **M157 regression on macOS**: after `USBDevice.reset()`, the device is permanently unusable from WebUSB. `claimInterface()` fails with *"Unable to claim interface"*, and device-recipient control transfers fail too. Blink keeps reporting the old configuration.

The root cause is the same shape of bug as the Windows one, inverted: Chromium shipped a change to `USBDevice.reset()` that invalidates the configuration, and Blink was not taught to drop its cached view of it. The fix — *"usb: Default-disable reset config invalidation"* — was landed on `main` at `services/device/public/cpp/device_features.cc` (`0b21cec08cb8eb08357def94f6cb102d07a13883`) with the feature flag off by default, a Finch kill switch, and cherry-picks merged to both M157 and M158. The reporter's verification comment is a nice piece of engineering practice:

> Verified that issue does not reproduce on 159.0.8138.0 (Official Build) canary (arm64).

So the mitigation is in place on the branches that matter. But the *shape* of the bug is worth naming, because it is the shape that webadb has to survive against: **a WebUSB call that mutates device state without the page being able to observe the change.** `reset()` is the obvious one, but `claimInterface()` / `releaseInterface()` / `selectConfiguration()` are the same category. The WebUSB spec's own model is that the page holds a `USBDevice` handle and can query `device.configuration`, `device.opened`, and the claimed-interface set at any time — and Chromium's `reset()` implementation broke that contract for a full release cycle.

Meanwhile, in the spec repositories, a quieter but structurally important thing happened on November 14: [`whatwg/hid@3c85c59`](https://github.com/whatwg/hid/commit/3c85c594f30f89b3d4a35042926b3326ae4ddfab) **deploys `blocklist.txt` to `hid.spec.whatwg.org`**, updating the blocklist URL in `index.bs` and wiring it through the Makefile's `EXTRA_FILES`. It follows up on [whatwg/spec-factory#93](https://github.com/whatwg/spec-factory/issues/93).

This is the WebHID spec reaching the same structural maturity that WebUSB reached when it moved to `whatwg/usb`: a published, fetchable blocklist of device identifiers that a user agent is expected to consult. WebUSB has had `blocklist.txt` in the spec repo for years; WebHID now has a deployed one. For a project whose entire premise is "a browser talks to a physical device over a USB-shaped protocol", the blocklist is not an abstraction — it is the list of devices the browser has decided it will not talk to, and it is now *published* rather than implicit.

The rest of the HID spec's recent history is the editorial kind of work that only happens on a spec with a permanent home: `HIDDeviceFilter.vendorId` becoming an unsigned short ([`19ec1aa`](https://github.com/whatwg/hid/commit/19ec1aa)), the polarity of `HIDReportItem.hasPreferredState` being corrected ([`25e6e56`](https://github.com/whatwg/hid/commit/25e6e56)), and the report-descriptor parse appending to `report["items"]` correctly ([`42294fa`](https://github.com/whatwg/hid/commit/42294fa)). The WebUSB spec, for its part, has been quiet since [`3dcc3c2`](https://github.com/whatwg/usb/commit/3dcc3c2d53ac8c8f807c448066d6cb58583a86db) — *"Restrict control transfers to standard requests and protected classes"* — landed in June.

## The protected-class bypass, and why it matters that it was a *bypass*

While we are in the WebUSB security area, it is worth recording the shape of the bugs Chromium has been fixing here, because they are not "the browser let a page do something dangerous" bugs — they are "the browser's *own protection mechanism* could be talked out of doing its job" bugs.

[#520743499](https://issues.chromium.org/issues/520743499) was a crafted-`wIndex` bypass: for CLASS requests targeting DEVICE or OTHER recipients, if the target interface could not be identified from `wIndex` (because it specified an invalid interface number like `0xFF`), and the device had at least one protected interface in its active configuration, the request was **not** blocked. The fix — *"usb: Fix protected class bypass via crafted wIndex in CLASS requests"* — landed on `main` at `services/device/usb/mojo/device_impl.cc` (`872fabf8796f3be9f54534158bf40a23732cfd7e`). The original protection traces back to CVE-2018-6125 (`blocked_interface_classes_`); the incomplete-fix follow-up was [#524520965](https://issues.chromium.org/issues/524520965), fixed by *"usb: Block device-level CLASS requests if any interface is protected"* (`b334f9d5a8d0a54b39b0f17aa2149cdb3fd7e`), and registered as **CVE-2026-79211**.

That CVE number is the operative detail. It says that for a period, the mechanism designed to stop a page from reaching a protected USB interface class — the mechanism that keeps ADB's own interface class (`0xFF`/`0x42`/`0x01`) out of reach of generic pages — could be bypassed by a page that knew the trick. `HasControlTransferPermission()` in the device service was the enforcement point, and it had a fall-through path that returned `true`.

The 2026 series of these bugs — the standard-request direction check (#517453128, `kWebUsbEnforceStandardRequestAllowlist` permitting OUTBOUND control transfers with arbitrary payload for IN-only `GET_*` requests), the crafted-`wIndex` bypass, the device-level CLASS gap — is a coherent hardening campaign, not a set of coincidences. Chromium has been tightening the WebUSB control-transfer surface against a spec that has itself been tightening (`3dcc3c2` restricting control transfers to standard requests and protected classes). For webadb the practical consequence is a good one, stated plainly: the ADB interface class remains protected, the enforcement point is being defended against bypass, and `claimInterface()` — the thing webadb actually calls — is the *supported* path. The interesting thing is that the bugs are not in `claimInterface()`'s permission model; they are in the adjacent control-transfer surface that a page is *not* supposed to need.

## The weekly Direct Sockets check: nothing moved

This is the Monday sweep, so it gets a full section rather than a footnote.

**Spec / WICG.** `WICG/direct-sockets` has not received a commit in the last seven days. The most recent is [`a75fe71`](https://github.com/WICG/direct-sockets/commit/a75fe71) — *"sending udp to multicast address requires permission policy"* (#85). Before that, [`add094c`](https://github.com/WICG/direct-sockets/commit/add094c) replaced `direct-sockets-private` with the LNA-based `local-network` / `loopback-network` policies (#84), and the multicast work landed in a run of five commits (`81e35c3`, `d3daa91`, `f3b6a21`, `0fcfd27`, `a75fe71`). The repository has no tags at all.

**ChromeStatus.** The canonical entry [6398297361088512](https://chromestatus.com/feature/6398297361088512) still reads *"Last updated on 2025-01-14"* — two years and ten months ago. Its stage is still **Prepare to ship**, its rollout plan still reads *"Will ship enabled for all users / Chrome for desktop 131"*, and there is still no Android milestone, no origin trial, and no dev trial.

**The platform support note is the load-bearing sentence and it has not changed:**

> This feature is implemented on desktop platforms, although it will only be available to the end users on platforms that support Isolated Web Apps, which is currently only ChromeOS. Android is excluded for historical reasons, although there are no apparent interoperability blockers here.

And, unchanged from the entry's WebView risk field: *"Feature not compiled in Android."*

**The docs.** [developer.chrome.com/docs/iwa/direct-sockets](https://developer.chrome.com/docs/iwa/direct-sockets) still carries *"Last updated 2025-12-17 UTC"*. The permission-policy requirement is still the same two keys:

```json
{
  "permissions_policy": {
    "direct-sockets": ["self"],
    "cross-origin-isolated": ["self"]
  }
}
```

with the note that without the `direct-sockets` key, `new TCPSocket(...)`, `new TCPServerSocket(...)` and `new UDPSocket(...)` reject immediately with `NotAllowedError`.

**Vendor signals.** Firefox's position on the Raw Sockets API ([mozilla/standards-positions#431](https://github.com/mozilla/standards-positions/issues/431)) is still **Negative** — last updated November 16, 2024. WebKit: *No signal*. The W3C TAG design review ([w3ctag/design-reviews#548](https://github.com/w3ctag/design-reviews/issues/548)) remains **Timed Out** from April 2022. Web Developers: **Positive**.

**What is genuinely new since the last sweep** is one line in the docs: the DevTools integration. *From Chrome 138, you can debug Direct Sockets traffic directly within the Network panel*, with a **Messages** tab and a Hex Viewer, so `TCPSocket` and `UDPSocket` traffic can be inspected alongside HTTP requests. That is a real quality-of-life change for anyone actually developing against the API, and it is the only substantive difference in the documentation since the previous sweep.

**Verdict for this week: no movement.** No origin trial, no Android, no ChromeOS expansion, no new spec commits, no vendor signal changes. The API is exactly where it was: implemented in Blink for desktop, exposed only to Isolated Web Apps, which as of September 2026 run only on ChromeOS. For an ADB client this means the wireless-debugging path in ya-webadb issue #784 — *"Support Android 11+ Wireless debugging (TLS + pairing code/QR)"*, opened by CurseStaff, still `effort: high` — remains blocked on a browser API that ordinary web pages cannot reach. The TLS pairing flow needs a raw TCP client certificate against the phone's pairing port; `navigator.openTCPSocket()` would do it, and `navigator.openTCPSocket()` is IWA-only.

## ya-webadb, and the shape of an unusually quiet month

ya-webadb's `main` has not moved since [`a62aacc2`](https://github.com/yume-chan/ya-webadb/commit/a62aacc210897b2f1bc3fb2270b94ec033b45575) — *"feat(scrcpy): add UHID manager"*, November 20 — which is three days old and which we covered on [November 20](https://webadb.online/blog/2026/11/20/ya-webadb-merges-the-scrcpy-uhid-manager-and-chrome-160-sits-in-dev/). The newest tag remains `v3.0.0-beta.5` from `d22e9dc3`, November 6.

There are **zero open pull requests**. The four open issues are all long-haul and unchanged: #784 (wireless debugging), #640 (use `Symbol.dispose` instead of a custom `Disposable`), #487 (record and replay user input, `domain: scrcpy`, `effort: medium`), and #343 (fastboot mode).

One branch is worth noting because it is visible in the remote refs and not in the mainline: `origin/feat/scrcpy-control` at `6bb9151c` (November 18, *"chore: fix review comments"*). That is the scrcpy input-control work — the `UHID` keyboard and mouse injection path — and it is the natural continuation of the UHID manager that merged on November 20. A UHID manager without UHID *control* is half a feature: you can enumerate virtual HID devices but not yet drive them.

This is worth pausing on, because it explains the quiet. ya-webadb is three weeks from a `beta.5 → beta.6` cycle and the project is in the part of the scrcpy port that is genuinely hard: the server side of scrcpy exposes a control socket for injecting keyboard and mouse events, and driving those events *on the device* means writing to the UHID kernel interface — which requires `root`, or at minimum a device with a permissive `uhid` policy. The WebHID angle is the interesting workaround, because WebHID is now on Android (Chrome 158) and HID is exactly the protocol UHID speaks. A phone in developer mode with `persist.vendor.usb.hid` enabled exposes its UHID nodes over USB as HID devices — and Chrome on that same phone can now reach them over WebHID, since WebHID shipped on Android in Chrome 158.

That is a genuinely surprising convergence: the browser API that shipped on Android last week is the same protocol that ya-webadb's next major scrcpy feature needs, on the same class of device, and the two halves are on different teams. Chromium's WebHID-on-Android work is [crbug 40628009](https://issues.chromium.org/issues/40628009) (marked Fixed, default-enabled in M157 via [crbug 573155176](https://issues.chromium.org/issues/573155176), *"Enable the WebHID API on Android by setting the runtime enabled features flag to 'stable' on all platforms"*), with the Android chooser and Site Settings gated on `HidManager` availability by [chromium-review 8560300](https://chromium-review.googlesource.com/c/chromium/src/+/8560300) — *"hid: Gate Android chooser and Site Settings on HidManager availability"*, committed `85f9a1d31eff754be3d430499088f5d8989e6040` on October 14, 2026.

## Where this leaves webadb.online

Four things, in descending order of how much they should change what we do.

**One — the `claimInterface()` path is where our users' failures will live, and we should instrument our own error surface accordingly.** Two shipping Chromium bugs in two months, both in `claimInterface()` validation, both with error messages that blame the user for a platform defect. Our connect flow calls `open()`, `selectConfiguration()`, `claimInterface()` in sequence and surfaces the raw `DOMException`. The honest thing to do — and the pattern we already use for OEM-restricted shell failures — is to recognise the specific Chromium messages and translate them:

- *"The interface number provided is not supported by the device in its current configuration."* → this is Chromium bug #574558283 on Windows. It is a platform defect, not a user error, and the workaround is to use a device in configuration 1.
- *"Unable to claim interface"* immediately after a `reset()` → this is Chromium bug #579833799 on macOS, mitigated on M157/M158, and the workaround is to reconnect the device rather than reset it.

Both of these should produce a verdict-plus-workaround message, not a raw exception string.

**Two — a WebHID-over-ADB path is now *conceivable*, and it is the only transport story that moved.** Direct Sockets did not move; WebTransport moved in Chrome 159 and its feature set is now genuinely sufficient for a relay. But the thing that actually changed this week is that **WebHID is on Android** — Chromium bug #40628009 went Fixed and default-enabled — and WebHID speaks HID, and UHID speaks HID, and ya-webadb's next scrcpy milestone is UHID *control*. A phone exposing UHID over USB for HID purposes is simultaneously (a) a device whose UHID nodes a desktop scrcpy client could inject into, and (b) a device whose own Chrome could reach those same nodes via WebHID. That is a topic worth a dedicated experiment, not a shipping plan.

**Three — the Direct Sockets answer did not change, and we should stop treating it as pending.** The API is IWA-only, ChromeOS-only, has no origin trial, has a two-year-stale ChromeStatus entry, and its vendor signals are negative (Firefox), silent (WebKit), and timed out (TAG). Our `lib/adb-daemon-tcp.ts` already implements the Direct Sockets transport contract; it should be documented as an *experimental, IWA-only* path, and the wireless-debugging feature that users actually want should be scoped as a **relay-server** project, because the browser-side constraint is not going to relax on its own.

**Four — the WebUSB control-transfer hardening campaign is good news, and it validates the interface-scoped design.** CVE-2026-79211 and the two preceding bugs were all in the *control-transfer* surface — the thing a page is not supposed to need for ADB. Chromium has been defending that boundary since May. It is a reasonable bet that the boundary keeps tightening, which means our design constraint stands: **talk to the ADB interface via `claimInterface()` and bulk transfers, and never reach for device-recipient control transfers.** We do not. The `open()` → `selectConfiguration()` → `claimInterface()` → `transferIn`/`transferOut` sequence in our WebUSB path is the supported path, and the bugs being fixed are elsewhere.

No code changes shipped from any of this. But the shape of the ecosystem moved in a way that is directly actionable: two of the three platform bugs we found this week are in the exact call our connect flow makes, and we now know the specific error strings to translate.

---

*This week's Direct Sockets sweep was run in full (Monday cadence): spec repository, ChromeStatus entry, developer documentation, and vendor signals — all checked, all unchanged. The prior sweep was [2026-10-12](https://webadb.online/blog/2026/10/12/2026-10-12-monday-recheck-ssm-direct-sockets-revert-chromium-3076e5f5/).*
