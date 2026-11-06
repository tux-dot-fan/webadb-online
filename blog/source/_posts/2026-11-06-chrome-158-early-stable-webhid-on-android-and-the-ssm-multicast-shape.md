---
title: "Chrome 158 goes early stable, and the ADB-in-browser feature set finally lands on Android"
date: 2026-11-06 01:00:00 UTC
tags:
  - chrome-158
  - webhid
  - direct-sockets
  - webusb
  - android
---

Chrome 158 started its early-stable rollout on desktop on November 4, and on
November 5 Google shipped Chrome 158 for Android (`158.0.8127.22`) to "a small
percentage of users" alongside Chrome 157 for Android (`157.0.8103.46`). That
second release is the one that matters for this blog, because the Android
stable channel is where webadb actually lives — most people running an
ADB-in-the-browser tool are on a phone, and they get Chrome updates on a
completely different cadence than desktop.

Chrome 158's feature list is the first release where three things that the
ADB-in-browser ecosystem has been waiting on all land in the same build:
Source-Specific Multicast for Direct Sockets, the WebHID API on Android, and
the first real wave of WebTransport ergonomics (reliability attributes,
congestion control, `exportKeyingMaterial`). None of them are ADB features.
All of them change what a browser can do to a device that webadb wants to
reach.

The other half of the story is quieter: ya-webadb did not merge anything in
the last 24 hours. The upstream repository's `origin/main` head is still
`0c68ad2f` — PR #879, the socket-close refactor — which landed at
`2026-11-04T17:25:18Z` and which [we covered yesterday](https://webadb.online/blog/2026/11/05/ya-webadb-pr-879-closes-adb-sockets-and-adopts-array-from-async/).
The npm registry confirms it: the last `@yume-chan/*` publish is
`@yume-chan/async` `4.2.2` at `2026-11-04T07:35:16Z`. So this post is a
Chrome-side post, and it is worth reading as one — the interesting movement
in ADB-in-browser right now is in the browser, not in the library.

## Source-Specific Multicast for Direct Sockets, and why the IDL matters

The Direct Sockets entry in Chrome 158's release notes is
[Source Specific Multicast for Direct Sockets API](https://chromestatus.com/feature/6208452397498368),
tracking bug
[#461262401](https://issues.chromium.org/issues/461262401), shipping on
milestone 152 and landing in 158.

We have covered the SSM story twice already — once when the
[spec change landed in the WICG repo](https://github.com/WICG/direct-sockets/pull/81)
in November 2025, and once when the
[chromestatus merger entry gave it three LGTMs](https://webadb.online/blog/2026/10/30/source-specific-multicast-gets-three-lgtms-spec-still-disagrees-with-chrome/).
What is new today is not the feature but the *shape* of the API, which the
finalized spec now pins down. The Direct Sockets specification at
[wicg.github.io/direct-sockets](https://wicg.github.io/direct-sockets/)
defines two dictionaries:

```webidl
dictionary MulticastGroupOptions {
  DOMString sourceAddress;
};

dictionary MulticastMembership {
  DOMString groupAddress;
  DOMString sourceAddress;
};
```

and the spec text is explicit about the semantics:

> The optional IP address of the source for Source-Specific Multicast (SSM).
> When present, creates or references a source-specific membership that only
> receives multicast packets from this specific source address to the group
> address. When absent, creates or references an Any-Source Multicast (ASM)
> membership that receives packets from any source. The source address must be
> a unicast address and match the IP version of the group address.

So the API surface is a single optional string in a single options dictionary,
and the "IP version must match the group address" rule is a hard constraint —
an IPv6 group address cannot be joined with an IPv4 source and vice versa.
The usage example in the spec is correspondingly small:

```js
// Join SSM group - receive only from 192.0.2.100
await multicastController.joinGroup("232.1.1.1", { sourceAddress: "192.0.2.100" });
console.log('Successfully joined SSM group!');
```

Two details are worth flagging for anyone planning to use this. First,
`MulticastController` is `[Exposed=(Window, DedicatedWorker), SecureContext,
IsolatedContext]` — the `IsolatedContext` requirement means this is *not*
available to a normal web page, only to an Isolated Web App. That is the
same gating that applies to the whole of Direct Sockets, and it is why
Direct Sockets has never been a viable transport for a plain webadb-hosted
page. Second, the SSM story depends on the permission-policy merger that
shipped back in Chrome 151: `direct-sockets-private` was replaced with the
granular `local-network` and `loopback-network` policies, and the WICG
explainer added a follow-up rule that sending UDP to a multicast address
requires a permission policy
([WICG/direct-sockets#85](https://github.com/WICG/direct-sockets/pull/85),
July 2026). SSM without the policy is a no-op.

The practical upshot for webadb: **Source-Specific Multicast makes Direct
Sockets useful for the one thing a debugging tool wants and a browser
historically forbade — reaching a device on a LAN without a cloud round-trip
and without accepting packets from every source on the segment.** Today,
`adbd` over TCP on a LAN is the fallback transport when WebUSB is
unavailable, and it is exposed through a plain `fetch` to `5555`. That works,
but it is one-shot HTTP: no multiplexing, no push channel, and the browser's
private-network access rules make it increasingly awkward to serve from a
public origin. A raw TCP socket to `192.168.x.x:5555` is a much better fit
for an ADB daemon, and Direct Sockets is the only browser API that can
provide it — but it is gated behind Isolated Web Apps, and SSM's specific
value (receiving only from the one host you asked for) is a security property
that matters most in exactly the shared-LAN case where you'd use it.

We have been tracking the Direct Sockets chromestatus entries across several
Mondays and the merger entry has been frozen at `updated: 2026-06-22` since
April. The feature entry finally moved to `updated: 2026-10-27` when the
three LGTMs landed, and now it has a shipping milestone. The merger entry's
Chrome status still reads `"Proposed"` with `desktop_first: 151` even though
151 shipped months ago — that staleness is a known chromestatus data problem,
not a signal that the policy did not land.

## WebHID comes to Android, and it is not about AOA

Chrome 158's [Device section](https://chromestatus.com/release-notes/158)
carries one entry: [Support for WebHID](https://chromestatus.com/feature/5172464636133376),
tracking bug [#40628009](http://crbug.com/40628009).

The substance is one sentence:

> WebHID shipped on desktop platforms (Windows, macOS, Linux, and ChromeOS) in
> Chrome 89. Chrome 158 brings the existing WebHID API to Chrome on Android
> (relying on new OS support in Android 17 / API level 37 and later) with no
> changes to the web-exposed API surface.

Two things follow. The API surface is unchanged, so nothing in the WebHID
spec changed — this is purely a platform availability change. And it depends
on Android 17 / API level 37, meaning that on Android 16 and below the API
simply will not exist, and on Android 17 it depends on the OS actually
shipping the HID host support the WebHID implementation sits on.

Now, the obvious reaction in an ADB-in-browser context is "does this affect
AOA?" It does not — at least not the way you might hope. ya-webadb's
[aoa](https://github.com/yume-chan/ya-webadb/tree/main/libraries/aoa)
library implements Android Open Accessory protocol by issuing **WebUSB**
vendor control transfers directly to the phone:

```typescript
export async function aoaHidRegister(
    device: USBDevice,
    accessoryId: number,
    reportDescriptorSize: number,
) {
    await device.controlTransferOut(
        {
            recipient: "device",
            requestType: "vendor",
            request: AoaRequestType.RegisterHid,
            value: accessoryId,
            index: reportDescriptorSize,
        },
        new ArrayBuffer(0),
    );
}
```

That is `navigator.usb`, not `navigator.hid`. AOA's HID mode is a *USB
vendor-specific* protocol that happens to carry HID-shaped reports; it is
not the USB HID class, so the WebHID API has nothing to attach to. The
`libraries/aoa/src/hid.ts` module talks to the device through
`device.controlTransferOut()`, never through `navigator.hid.requestDevice()`.

The WebHID-on-Android change matters for a different reason: it means the
browser on Android now exposes a *second* device-access API alongside
WebUSB, with a device chooser and a permission model that is separate from
the WebUSB one. Two implications for a tool like webadb. First, the
permission surfaces are separate, so a user could in principle grant HID
access while denying USB access — the "your device can't be reached" error
message needs to be specific about which permission is missing. Second,
WebHID on Android is new enough that the browser-chooser UX is unproven;
the enterprise policy surface listed for the feature
(`DefaultWebHidGuardSetting`, `WebHidAllowAllDevicesForUrls`,
`WebHidBlockedForUrls`, and four others) is where a managed deployment
would lock it down, and on Android WebView is explicitly excluded — "WebView
is not supported, as it does not have a device chooser UI or permissions UX
controls."

For our purposes the honest summary is: no code change, no new capability
for ADB, but a broader platform story that says Chrome on Android is
investing in hardware access rather than retreating from it. Chrome on
Android shipping WebUSB is what made webadb possible there in the first
place; WebHID landing in the same release suggests the trajectory continues.

## The WebTransport wave, and the one thing worth stealing

Chrome 159's release notes are already filling up with WebTransport work,
and while none of it is in 158 stable, the 158 entries are the leading edge
of a coherent push. In 158:

- **WebTransport reliability attributes**
  ([#5094058497277952](https://chromestatus.com/feature/5094058497277952)) —
  a `WebTransport.reliability` instance attribute and a static
  `WebTransport.supportsReliableOnly`. In Chromium, `reliability` starts at
  `"pending"` and flips to `"supports-unreliable"` once an HTTP/3 session is
  established, because Chromium has no HTTP/2 fallback: every successful
  WebTransport session in Chromium is HTTP/3 with unreliable datagrams
  available.
- **WebTransport draining**
  ([#6427766428925952](https://chromestatus.com/feature/6427766428925952)) —
  `WebTransport.draining` is a promise that resolves when the *server*
  indicates the session will be gracefully retired, so an app can stand up a
  replacement session while the old one is still usable. This is the
  server-initiated-handover primitive that a long-lived device session
  needs.
- **WebTransport anticipated concurrent incoming streams**
  ([#5089961022980096](https://chromestatus.com/feature/5089961022980096)) —
  constructor hints for initial QUIC stream allowance.
- **WebTransport exportKeyingMaterial**
  ([#4860330806214656](https://chromestatus.com/feature/4860330806214656)) —
  not 158 but already in the 159 notes, and it is the interesting one: the
  method derives cryptographic keying material bound to an established
  WebTransport session, and for HTTP/3 Chromium includes the WebTransport
  CONNECT stream ID in the TLS exporter context, so two sessions sharing one
  HTTP/3 connection derive *different* keying material.

That last property is the one worth stealing, and it has a direct analogue
in the ADB world. The ADB daemon protocol has no session identity of its own
beyond the socket's local/remote id pair, and ya-webadb's
`AdbDaemonSocketController` — which [yesterday's post covered in detail](https://webadb.online/blog/2026/11/05/ya-webadb-pr-879-closes-adb-sockets-and-adopts-array-from-async/)
— identifies a logical connection by exactly that pair. A transport-level
per-session secret, derivable by both ends and distinct per session, would
be a materially stronger way to bind a multiplexed ADB connection to the
thing that opened it. Chromium's `exportKeyingMaterial` shows the shape of
that primitive exists in a shipping browser API; whether it can be applied
to the ADB protocol is a separate question.

Also worth noting for anyone tracking the WebTransport surface: 159 adds
`WebTransport.getStats()` (round-trip time, sending rate, expired/lost/dropped
datagram counts, readable after close), a `congestionControl` constructor
option accepting `"default" | "throughput" | "low-latency"`, the
standardized `WebTransportReceiveStream` interface with per-stream
`bytesReceived` vs `bytesRead` counters, and send groups with `sendOrder`
prioritization.

## What did not happen

Being explicit about the absences, because a daily post that only lists what
shipped reads as marketing.

**ya-webadb merged nothing.** `origin/main` is `0c68ad2f`, and the commit
window `2026-11-04T01:00:00Z` → `2026-11-06T01:00:00Z` contains exactly two
commits: `ac8447b3` (the `Consumable.WritableStream.write` unhandled-rejection
fix, PR #878) and `0c68ad2f` (PR #879). Both were covered by the Nov 3 and
Nov 5 posts respectively. There are no open PRs newer than #879, no issues
filed since #876, and the npm registry's most recent `@yume-chan/*` publish
is `@yume-chan/async` `4.2.2` from `2026-11-04T07:35:16Z`.

**The Direct Sockets and WebUSB specs did not move.** The WICG
`direct-sockets` repository's last commit is `a75fe711` from July 10, 2026
(the multicast permission-policy rule). The `whatwg/usb` repository — which
the WebUSB spec now lives in — last saw a commit on June 5, 2026:
`3dcc3c2d`, "Restrict control transfers to standard requests and protected
classes"
([whatwg/usb#270](https://github.com/whatwg/usb/pull/270)), merged by
`reillyeon`. That change is worth a separate note because it constrains what
`controlTransferIn`/`controlTransferOut` can legally do, and the ADB daemon
protocol depends heavily on vendor-specific control transfers — see the
`aoaHidRegister` snippet above, which is exactly a vendor request type. If
Chrome 158's control-transfer validation is stricter than what the ADB
daemon protocol needs, that is a breakage for AOA, and it is the kind of
thing worth testing on a real device rather than reasoning about from the
spec.

**The WebUSB `forget()` / `close()` / `disconnect` distinction did not
change.** The Nov 4 post covered Chrome 157's WebUSB disconnect-semantics
change in detail. That analysis still holds; nothing in the last 24 hours
revised it.

**No new WebUSB release note or protected-class change.** Chrome 158's
release notes contain no WebUSB entry at all. The API's only appearance in
158 is by association: WebHID lands on Android alongside it.

## What this means for webadb.online

No code changes today, and we are not going to manufacture some. But three
things from this release are worth putting on the record.

First, the **Android channel lag is the real story**. Chrome 158 has been on
desktop early-stable since November 4 and reaches Android stable today, on a
rollout that is explicitly "a small percentage of users". The 158 feature set
— SSM, WebHID on Android, the WebTransport reliability work — will be on
Android devices for weeks before it is broadly available. Any conclusion
about Direct Sockets or WebHID on Android drawn from desktop Chrome is
drawing from a build most Android users do not have yet.

Second, **Direct Sockets' value to this ecosystem is now clearer than it has
ever been, and it is still gated behind Isolated Web Apps.** SSM's promise —
receive only from the specific source you named — is precisely the property
you want when reaching an `adbd` instance on a shared LAN. But the
`IsolatedContext` requirement on `MulticastController` means a plain
webadb-hosted page cannot use it, and the `local-network` permission policy
from Chrome 151 governs whether an IWA may even try. That is a decision for
the platform, not for us, and the honest position is to keep the current
WebUSB-primary, HTTP-fallback transport matrix while tracking the IWA story.

Third, **`exportKeyingMaterial` is a template.** Chromium can now derive
per-session cryptographic material bound to an established session, with
distinct values per logical session even when they share an underlying
connection. The ADB daemon protocol multiplexes several logical connections
over one transport and identifies them by an id pair. Per-session keying
material derived by both ends would be a stronger binding than the id pair
alone. We are not going to propose a protocol change to the ADB daemon from
this blog, but the primitive now exists in a shipping browser API, and it is
worth remembering the next time someone asks why an ADB connection over a
shared transport is trusted at all.

Concretely, the next things we intend to verify on a real device are
whether Chrome 158's tightened control-transfer validation breaks the
vendor-specific control transfers in the AOA path, and whether the WebUSB
`disconnect` semantics from Chrome 157 behave identically on the Android
build. Both are device tests, not browser tests, and both are the kind of
question that takes five minutes with a phone plugged in and an hour of
speculation without one.
