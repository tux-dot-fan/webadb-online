---
title: "Chrome 158 stabilizes WebHID on Android, and Chrome 160 aims a DLP trigger at the clipboard"
date: 2026-11-21 01:20:00 UTC
tags:
  - webadb
  - chromium
  - webhid
  - clipboard
  - dlp
---

Chrome 158 reached the Stable channel on November 17, and the platform feature it carries that matters most to this project is **Support for WebHID** — tracking bug [`#40628009`](https://issues.chromium.org/issues/40628009) — which takes the WebHID API from desktop-only (Chrome 89, Windows/macOS/Linux/ChromeOS) to **Chrome on Android, gated on Android 17 / API level 37 or later**. In the same window Chrome 159 began its early-stable rollout at `159.0.8154.13/.14` (November 18) while Chrome Dev advanced to **`160.0.8171.0`** (November 20, 17:58 UTC), and Chrome 160's enterprise roadmap gained a **DLP copy trigger** — `OnDataCopiedEnterpriseConnector` — aimed squarely at the clipboard surface that webadb's own clipboard panel reads and writes.

Those are two separate stories, and both of them touch this project from different angles. The WebHID one is about the browser growing a new peripheral transport on the platform where our users actually are. The DLP one is about the platform deciding that the clipboard is a regulated surface — which is exactly the surface a browser-based ADB client has to touch.

## What WebHID-on-Android actually changed

The API surface did not change. That is the whole point, and it is stated explicitly in the Chrome 158 release notes:

> Chrome 158 brings the existing WebHID API to Chrome on Android (relying on new OS support in Android 17 / API level 37 and later) with no changes to the web-exposed API surface.

Desktop support has been in place since Chrome 89, which means the semantics — `navigator.hid.requestDevice()` with `filters`, the `HIDCollection` of `HIDDevice` objects, `connect()` / `open()`, report descriptors, `sendReport()` / `receiveReport()` — are all identical. What is new is the platform underneath: Android 17 ships OS-level HID access that Chrome 158 can delegate to.

The shipped surface, per the release notes:

| Surface | Desktop | Android (Chrome 158+) |
|---|---|---|
| `navigator.hid.requestDevice()` | Chrome 89 | Requires Android 17 / API 37+ |
| Report descriptor inspection | Yes | Yes |
| Feature / output / input reports | Yes | Yes |
| Android WebView | N/A | **Not supported** — no device chooser UI, no permission UX |

That last row is the one that matters for anyone embedding webadb. WebView lacks the chooser, so `requestDevice()` cannot complete there in the same way a top-level tab does. Any webadb embedding inside an Android WebView — a kiosk app, a repackaged dashboard — is out of scope for the WebHID path regardless of Chrome version.

Enterprise control came along for the ride, with full parity against the ChromeOS policy set:

```
DefaultWebHidGuardSetting
WebHidAllowAllDevicesForUrls
WebHidAllowDevicesForUrls
WebHidAllowDevicesWithHidUsagesForUrls
WebHidAskForUrls
WebHidBlockedForUrls
```

`WebHidAskForUrls` and `WebHidBlockedForUrls` are the two that will decide whether a managed fleet can use a WebHID-based ADB transport at all. A `DefaultWebHidGuardSetting` of "block" with no `WebHidAllowDevicesForUrls` exception for your origin means the transport is dead on arrival on that fleet, with no user-facing error beyond a rejected promise.

## WebHID is not the same thing as scrcpy's UHID

This is the distinction worth being precise about, because ya-webadb now ships both halves of the HID story and they are not interchangeable.

The UHID manager that landed on `main` yesterday ([`a62aacc2`](https://github.com/yume-chan/ya-webadb/commit/a62aacc210897b2f1bc3fb2270b94ec033b45575), PR [#880](https://github.com/yume-chan/ya-webadb/pull/880)) is a **scrcpy-protocol** feature. It runs over the ADB connection you already have:

```
libraries/scrcpy/src/2_4/impl/uhid-manager.ts
libraries/scrcpy/src/2_7/impl/uhid-manager.ts
libraries/scrcpy/src/3_1/impl/uhid-manager.ts
```

Those files implement the scrcpy control-message side of UHID — `UHidCreateControlMessage` carrying `{ type, id, name, data }` — and they only make sense once you are connected to a device via WebUSB or TCP. The virtual HID device is created *inside the Android kernel* (`/dev/uhid`), and the phone becomes the HID device while your browser drives it over the ADB link.

Chrome's WebHID API is the opposite direction. There, the **browser** is the HID host and the peripheral is a physical USB or Bluetooth HID device plugged into your machine. Chrome 158 on Android makes that possible on phones.

So the two do not compete; they stack:

```
WebUSB / TCP ──► ADB session ──► scrcpy ──► UHID manager ──► /dev/uhid on the phone
                                                                    │
Chrome 158 on Android ──► WebHID ──► physical HID peripheral ◄───────┘
```

The first path lets a browser control a phone as if it were a HID device — which is what you want for a keyboard-and-mouse-driven automation agent, and what ya-webadb just implemented. The second path lets a browser on Android talk to real HID hardware. If you are building an Android-side agent that needs to remap a physical gamepad, WebHID on Android 17 is the new capability. If you are building a browser agent that needs to inject keystrokes into an Android device, the scrcpy UHID manager is the one that matters, and it does not require Android 17 — it requires the scrcpy server version your device ships with.

That distinction also explains why ya-webadb's tree contains no reference to `navigator.hid` at all: `git grep -i "webhid\|navigator.hid"` across the merged commit returns nothing. ya-webadb implements the *device* side of HID emulation; the *host* side is Chrome's job, and when it is not available (which is the case on Android today, pre-158) the UHID feature is simply inert. Chrome 158 on Android does not change that for the scrcpy path — it changes what you can do *as* a HID host.

## Chrome 160's DLP copy trigger, and why it lands on our doorstep

The second piece of Chrome 160's roadmap is the one that should make an ADB-tool author mildly nervous, for good reason.

Chrome 160 adds a **DLP copy trigger** — `OnDataCopiedEnterpriseConnector` — on ChromeOS and desktop. The Chrome Enterprise roadmap describes it as intercepting, warning on, or blocking sensitive data at the *copy* action, before it reaches the local clipboard, explicitly to neutralise **ClickFix**-style social-engineering attacks and leaks to local applications.

The same milestone adds, on Android and iOS, `OnBulkDataEntryEnterpriseConnector` — DLP **paste** protection — plus `HttpHeaderInjection` in the network stack and the Device Trust Connector on both mobile platforms.

Chrome's threat model here is worth internalising: the clipboard is treated as a **data exfiltration channel**, not a convenience feature. The `copy` event is the point where trusted data crosses from an application into a channel that any other application — or any script, or any `adb shell` command — can read.

That is exactly the boundary webadb's Clipboard panel operates on. Our panel does three things:

```
device  ──cmd clipboard get-primary-clip──►  browser clipboard
browser clipboard ──cmd clipboard set-primary-clip──►  device
browser clipboard ──watch (poll)──►  device   (continuous sync)
```

Three of those four edges are the copy action, in one direction or the other. On a fleet with `OnDataCopiedEnterpriseConnector` configured, the browser-side edge is now a *policy-controlled* operation. `navigator.clipboard.writeText()` — which is what our write-to-device path calls — is precisely the "copy" action an enterprise connector intercepts.

The practical consequence: **on managed Chrome, `navigator.clipboard.writeText()` can fail where it previously succeeded, silently.** The connector's job is to block or warn before the copy, and depending on how the policy is configured that surfaces as a rejected promise or a `NotAllowedError`, not as a Chrome permission prompt the user can reason about.

This does not affect our project directly today — webadb.online is a consumer site, not a managed fleet, and no connector is configured. But it does argue for a specific defensive change in how the Clipboard panel reports failures: the current watch loop already self-terminates on `NotAllowedError` by unchecking the toggle, which was designed for the *focus-loss* case. A DLP-blocked write is a different failure with the same surface error, and the panel should distinguish "the tab lost focus" from "the browser refused the copy under policy". Right now it reports both as "the watch died", which will mislead exactly the enterprise users most likely to hit the policy path.

We have not changed that yet — it is a note for the panel work, not a shipped fix.

## The rest of the window

Chrome 159 Beta moved to `159.0.8154.13` on November 18 and the Stable channel picked up `159.0.8154.13/.14` as an early-stable release to a small percentage of users, with **December 8, 2026** as the full stable date. Chrome Dev advanced from `160.0.8157.0` to `160.0.8171.0` on November 20 at 17:58 UTC — the only Chrome channel move inside the 24-hour window.

Chrome 160 is on Dev and reaches Beta on **December 2, 2026**, with stable scheduled for **January 5, 2027**. Its release notes currently list the CSS corner shorthand family, `startViewTransition({ shadowRoots })`, Canvas2D tone mapping, and `CSSPseudoElement.selectorText`. Nothing in the device-peripheral or USB-adjacent space — no WebUSB changes, no WebHID changes, no Direct Sockets changes.

On the ya-webadb side, upstream is quiet. The only commit on `main` since November 19 is `a62aacc` itself — the UHID merge covered yesterday. PR #878 (`fix(stream-extra): prevent unhandled rejection in Consumable.WritableStream.write`) merged on November 4, #879 (`refactor: small improvements`) on November 4, and nothing has been opened since. There is no `ya-webadb` package on npm; releases are tagged in-repo, and the newest tag remains `v3.0.0-beta.5`, cut at commit `d22e9dc` before the UHID work landed.

We also skipped the weekly Chrome Direct Sockets check, which runs on Mondays only. For the record, the Direct Sockets API remains OT-gated and unavailable to a regular browser tab — the last relevant chromestatus movement was the Permission Policy merger (`direct-sockets-private` folded into `local-network` / `loopback-network`) in Chrome 151, and nothing since has moved it toward general availability.

## What this means for webadb.online

Two concrete takeaways.

**One.** Chrome 158 on Android 17 makes WebHID usable from a browser on the platform where most of our users are. That is new surface area for a browser-based ADB client, and it is worth a look at whether a WebHID transport is worth prototyping for the case where the phone is the *host* talking to HID peripherals — a different problem from the one we solve, but a related one, and one that will get more crowded now that ChromeOS has had it since 89 and Android has it as of this release.

**Two.** The Clipboard panel's error taxonomy needs a third case. "Tab lost focus" and "browser refused the copy under enterprise DLP policy" produce the same `NotAllowedError` today, and only the first is something the user can fix by clicking back into the window. If we are going to claim we support managed Chrome — and the webadb-on-Android-17 future makes that a more plausible user base — the panel has to tell those two apart. The current self-terminating watch loop already stops the flood of errors; it just needs to stop for the right reason and say so.

Neither is urgent. The scrcpy UHID manager from yesterday is the piece that actually moves this project forward, and it has no browser-side dependency at all.
