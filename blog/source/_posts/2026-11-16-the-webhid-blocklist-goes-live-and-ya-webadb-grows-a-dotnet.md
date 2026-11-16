---
title: "The WebHID blocklist goes live, and ya-webadb grows a .NET"
date: 2026-11-16 01:05:00 UTC
tags:
  - webhid
  - whatwg
  - webadb
  - dotnet
  - quic
---

Two things landed in the last day that matter to anyone building device tooling on top of the browser's peripheral APIs. First, the WebHID specification — the standard that governs whether a page may talk to a raw HID device at all — now publishes a live filter list at `hid.spec.whatwg.org/blocklist.txt`, and that list explicitly forbids websites from touching keyboards and mice. Second, a new project appeared that wraps the `yume-chan/ya-webadb` core in C# and ships scrcpy screen mirroring from Blazor WebAssembly, which is the clearest evidence yet that ya-webadb has become a platform rather than a demo. Meanwhile Chromium turned on optimistic DNS resolution by default and started building the machinery for QUIC connections to migrate from IPv6 to IPv4.

## WebHID gets a blocklist, and it bans keyboards

The commit is [`whatwg/hid@3c85c594f`](https://github.com/whatwg/hid/commit/3c85c594f), "Deploy blocklist.txt to hid.spec.whatwg.org", pushed on 2026-11-14 at 01:00 UTC. The message is short — it "publishes blocklist.txt to https://hid.spec.whatwg.org/blocklist.txt via EXTRA_FILES in Makefile and updates the blocklist URL in index.bs" — and it follows up on `whatwg/spec-factory#93`, the infrastructure template work that gives every WHATWG standard repo a uniform deployment layout.

What matters is what is in the file. The header explains the filter grammar:

```
// Each filter rule may specify device-level properties (vendor, product),
// top-level-collection properties (usagePage, usage), and report
// properties (reportId, reportType). All of the properties for a filter
// rule must match for the rule to apply. Omitted properties match any
// value.
//
// Examples:
//   // Blocks access to all devices from vendor BABE.
//   {vendor:0xBABE},
//   // Blocks access to product BAAD from vendor 6666.
//   {vendor:0x6666, product:0xBAAD},
```

And then the actual blocks, with the reasoning written out:

```
[
  // Block FIDO HID U2F functionality. U2F devices should be handled by
  // U2F or WebAuthn APIs.
  {usagePage:0xF1D0},

  // HID access to mouse and keyboard inputs enables the creation of input
  // loggers and allows web pages to subvert the operating system's focus
  // model. Block collections that expose this type of functionality.
  {usagePage:0x0001, usage:0x0002},  // Generic Desktop / Mouse
  {usagePage:0x0001, usage:0x0006},  // Generic Desktop / Keyboard
  {usagePage:0x0001, usage:0x0007},  // Generic Desktop / Keypad
```

Three usages are blocked outright: Generic Desktop / Mouse (`0x0001` / `0x0002`), Generic Desktop / Keyboard (`0x0001` / `0x0006`), and Generic Desktop / Keypad (`0x0001` / `0x0007`). The stated reason is the one that should make every browser-based input-injection project pause:

> HID access to mouse and keyboard inputs enables the creation of input loggers and allows web pages to subvert the operating system's focus model.

That is the security rationale in its own words, and it lands directly on the roadmap discussed in [yume-chan/ya-webadb#866](https://github.com/yume-chan/ya-webadb/issues/866) — the mouse-button mapping request that Tango 3.2.0 closed last week. The UHID keyboard work that dominated [yesterday's post](https://webadb.online/blog/2026/11/15/tango-uhid-in-the-browser-and-the-scrcpy-keyboard-finally-learns-to-type/) lives in the same usage-page space. A browser that could open a virtual HID keyboard would be a browser that could log every keystroke typed on a physical keyboard — which is precisely why the spec now says no, in a machine-readable list that browsers can fetch.

The interesting engineering detail is the *mechanism*. Before this commit, the blocklist was a file in a repository, which is to say it was a policy document. After it, it is a URL, served by the spec's own domain, that a user agent can fetch at runtime. That is a meaningful change in what the rule *is*. A blocklist baked into a user agent is a blocklist that ships with the browser and ages badly; a blocklist fetched from `hid.spec.whatwg.org` can change without a browser release, and can differ per deployment. The file is 49 lines. The infrastructure is the story.

Note the difference in shape from the WebUSB filter. The HID filter matches on *usage page and usage* — the semantic function of a HID collection — whereas the WebUSB filter matches on *vendor and product IDs* — the identity of a device. That is a meaningful distinction for anyone trying to reason about what a page can reach. Filtering HID by usage is filtering by *capability*. A vendor could ship a keyboard with a new product ID tomorrow and the keyboard filter would still catch it, because the rule does not care who made it. It is a considerably more robust design, and it is the one that shows up in the spec's own example set: `{vendor:0xDADA, usagePage:0xFF00}` blocks reports from a specific vendor's vendor-defined usage page without blocking the device wholesale.

There is a companion editorial fix from earlier in the month, [`whatwg/hid@1890d6f69`](https://github.com/whatwg/hid/commit/1890d6f69), "Editorial: use stringIndices variable in parse report descriptor steps" — a typo fix in the report-descriptor parsing algorithm, fixing `whatwg/hid#152`. Small, but it is in the parsing path, and the parsing path is where a HID implementation lives or dies.

## WebUSB has a home in WHATWG now

While the HID spec was busy, the WebUSB specification quietly moved houses. `https://github.com/WICG/webusb` now redirects to `https://github.com/whatwg/usb` — a repository with 1,411 stars, last pushed 2026-06-05, described simply as "Connecting hardware to the web." The published specification at `https://usb.spec.whatwg.org/` identifies itself as a "Draft Community Group Report, 5 June 2026" and explicitly notes it "is not a W3C Standard nor is it on the W3C Standards Track."

The redirect is the substantive part. WebUSB was, for most of its life, a WICG incubation project — a Chromium-first feature with a spec that lived in a community group and a history of the phrase "vendor IDs" and "protected usage pages" appearing in security discussions. It is now under the same roof as WebHID, Web Serial, WebNFC, Web Bluetooth, and the HTML, DOM, Fetch, URL, and WebSocket standards.

The W3C side has been documenting the same conclusion from the other direction. The 2026 charter draft for the Devices and Sensors Working Group lists all five peripheral APIs as tentative deliverables, with Mozilla requesting WebUSB and Web Bluetooth be added alongside Web Serial, and Marcos Cáceres (WebKit) noting in `w3c/charter-drafts#799` that the APIs "expose raw transport protocols that are hardware-dependent by design" and ship only in Chromium-based browsers. The TAG's response, recorded in the disposition of comments, is worth quoting because it frames the long-term risk precisely:

> The specifications were added as tentative deliverables... The specifications do not acknowledge this changed threat model and explain how the APIs' security approaches address the class of attacks identified.

And WebKit's published positions are unambiguous: WebUSB — "oppose (privacy, security, device independence)"; Web Bluetooth — "oppose (privacy, security, device independence)". The WHATWG's willingness to host the spec is not a vote of confidence in interop. It is a decision to maintain the specification while the implementations stay Chromium-only.

For a project like webadb.online that is entirely dependent on `navigator.usb.requestDevice()`, the practical read is: the specification is now maintained by the same group that maintains the HTML standard, so it will not rot, but the "device independence" objection has never been addressed and the WebHID blocklist just demonstrated how a WHATWG-hosted peripheral spec can still draw hard security lines.

## ya-webadb in .NET, with scrcpy

The genuinely new project in the last 24 hours is `LostBeard/SpawnDev.BlazorJS.TangoADB`, a SpawnDev.BlazorJS wrapper around `@yume-chan/ya-webadb` that drives Android devices over WebUSB from a Blazor WebAssembly page. Its sibling, `SpawnDev.SpawnJS.TangoADB`, does the same for .NET proper. Both repositories were pushed on 2026-11-15 at 19:28 and 19:30 UTC respectively — the commits themselves are licence-header housekeeping, but the projects themselves are the news, and they are new to the ecosystem.

The framing is worth stating plainly, because the README says something slightly wrong that needs correcting. It calls the library a "wrapper around **Tango** (`@yume-chan/ya-webadb`)" and links Tango's GitHub — but `@yume-chan/ya-webadb` is **not** Tango. Tango is the commercial product built on top of ya-webadb; ya-webadb is the open-source library Tango uses. The README's own sentence gets it right in the next line ("the TypeScript re-implementation of ADB that runs in the browser over WebUSB") and then the parenthetical contradicts it. Minor, but it is the kind of confusion that makes people think Tango's UHID implementation is available under an Apache licence. It is not.

What the project actually does is more interesting than the name suggests. Its quick-start is a direct transliteration of the ya-webadb API into C#:

```csharp
await Tango.Init();

var manager = AdbDaemonWebUsbDeviceManager.Browser;
var device = await manager.RequestDevice();          // shows the browser USB chooser
var connection = await device.Connect();
var credentialStore = new AdbWebCredentialStore("MyApp");
var transport = await AdbDaemonTransport.Authenticate(new AdbDaemonAuthenticationOptions
{
    Serial = device.Serial,
    Connection = connection,
    CredentialStore = credentialStore,
});
var adb = new Adb(transport);

var model = await adb.GetProp("ro.product.model");
```

Note `AdbWebCredentialStore` — that is `@yume-chan/adb-credential-web`, the WebCrypto-plus-IndexedDB RSA key store. Getting RSA authentication to work from Blazor WASM means getting `crypto.subtle` to do the keygen inside a WASM sandbox with a DOM-free surface, and it evidently does, on a Meta Quest 3S in developer mode.

The hard part is screen mirroring, and the project goes at it the way ya-webadb intends:

```csharp
// 1. Push the bundled scrcpy server to the device.
using var response = await JS.Fetch("_content/SpawnDev.BlazorJS.TangoADB/scrcpy-server");
using var server   = response.Body!;
await AdbScrcpyClient.PushServer(adb, server);    // default path /data/local/tmp/scrcpy-server.jar

// 2. Start it (options must declare the server version they target).
var options = new AdbScrcpyOptionsLatest(
    new ScrcpyOptionsInit(),
    new AdbScrcpyClientOptions { Version = "3.3.1" });
client = await AdbScrcpyClient.Start(adb, "/data/local/tmp/scrcpy-server.jar", options);

if (!client.HasVideoStream) return;
var videoStream = await client.VideoStream;
var codec       = videoStream.Metadata.Codec;

// 3. Decode into the canvas.
var renderer = WebGLVideoFrameRenderer.IsSupported
    ? (JSObject)new WebGLVideoFrameRenderer(canvas)
    : new BitmapVideoFrameRenderer(canvas);

decoder = new WebCodecsVideoDecoder(new WebCodecsVideoDecoderOptions
{
    Codec = codec,
    Renderer = renderer,
});

// 4. Pipe the demuxed video packets into the decoder (runs until the stream ends).
_ = videoStream.Stream.PipeTo(decoder.Writable);
```

This is `scrcpy-decoder-webcodecs` — the WebCodecs `VideoDecoder` path, with a `TinyH264Decoder` software fallback that needs a WASM worker — and it is the exact architecture that webadb's own Screencast panel deliberately does *not* use, because webadb runs `adb shell screenrecord` with file-based polling instead of shipping a scrcpy server binary. The two projects disagree about the hard problem, and they disagree for good reasons: webadb's constraint is that it must work on OEM ROMs where a pushed `scrcpy-server.jar` may not run, and the Blazor project's constraint is that it can bundle the jar as a static asset.

The control-message surface is where the interop pain shows. The 1.0.1 changelog is a single bug, and it is a good one:

> `ScrcpyInjectTouchControlMessage.PointerId` and `ScrcpySetClipboardControlMessage.Sequence` are `BigInt<long>` (were `long`). Tango writes them with `setUint64`, which needs a JS `BigInt`; a `long` serialized as a JS number and `InjectTouch` threw `TypeError: Cannot mix BigInt and other types`.

This is a JavaScript-interop bug that has nothing to do with ADB and everything to do with the fact that the scrcpy control protocol uses 64-bit fields and JavaScript numbers are doubles. `setUint64` needs a `BigInt`; a C# `long` marshalled through a JS interop layer arrives as a `Number`; and the typed-array writer throws. The fix is to widen the C# type to `BigInt<long>` — which does not exist in `System.Numerics` and had to be defined by the wrapper.

The test suite is also worth noting, because it is the part most browser-ADB projects skip. The Verification page "serializes an InjectTouch message and checks its 32 bytes (red-checked: with `PointerId` as `long` it reports 19/20)" — a byte-exact assertion on the control message, run in real Chromium via Playwright, catching a one-byte wire-format error that would otherwise surface as "touch does nothing on the device". That is the level of rigour the scrcpy control protocol deserves and almost nobody achieves.

The bundled versions are also a useful data point for anyone tracking the ecosystem:

```
@yume-chan/adb 2.6.0, adb-daemon-webusb 2.3.2, adb-credential-web 2.1.0,
android-bin 2.1.0, scrcpy 2.3.0, adb-scrcpy 2.3.2,
scrcpy-decoder-webcodecs 2.5.3, scrcpy-decoder-tinyh264 2.1.0,
stream-extra 2.6.1, struct 2.3.2, event 2.0.0. scrcpy server: 3.3.1.
```

Note this pins the **2.x** line, not the 3.0.0-beta line — `@yume-chan/adb` 2.6.0 rather than 3.0.0-beta.5, and `scrcpy-decoder-webcodecs` 2.5.3 rather than 3.0.0-beta.5. The 3.x line renamed packages (`@yume-chan/adb` → `@yume-chan/adb` with `adb-scrcpy` split out, `adb-credential-web` replaced `TangoLocalStorage`). A wrapper targeting the stable 2.x line is a defensible choice for a library that wants a stable API surface to bind against, but it means the .NET binding is one major version behind the TypeScript library's head.

The `SpawnDev` ecosystem is a prolific generator of browser-device projects — `SpawnDev.NexStar` (Celestron telescope control over Web Serial and Web USB, pushed the same day), `SpawnDev.SpawnJS.Cryptography`, `SpawnDev.nanoFramework.WebRTC`. It is worth watching because it consistently reaches for the raw peripheral APIs that the W3C charter dispute is about, and it consistently hits the same walls.

## Chromium: optimistic DNS, and QUIC that can change address family

Chromium landed two related networking changes on 2026-11-15 that together constitute a meaningful change in how Chrome handles the address family of a connection.

The first is [`chromium/chromium@827b5667d`](https://chromium.googlesource.com/chromium/src/+/827b5667d), "net: Enable OptimisticDnsForTcp and IPv6 fallback tuning by default", committed at 17:26 UTC. The commit message is unusually candid about what it enables:

```
Enable the OptimisticDnsForTcp study features and parameters by default
on non-Cronet builds:
- kOptimisticDnsForTcp (with use_stale_connectors = true)
- kEnableIntermediateDnsResults (with SortTransactionsIndividually = true)
- kAdjustIPv6FallbackTime (with fallback_time = 100ms)
- kIPv6FallbackBasedOnRTT (with IPv6FallbackRTTMultiplier = 1.1)
```

The optimisation is that Chrome starts the TCP connection against a *stale* DNS answer before the fresh resolution completes, rather than waiting for DNS to settle. For a browser ADB client, this is invisible — WebUSB does not go through the network stack at all. For the adjacent future where a web client talks to an ADB-over-TCP server (the `adb tcpip` path, or `adb-scrcpy` over a forwarded socket), it is a real latency win, and it is the kind of change that shows up as "the tool just feels faster" with no observable cause.

The second change is more interesting and more speculative. [`chromium/chromium@b5a6deda4`](https://chromium.googlesource.com/chromium/src/+/b5a6deda4), "Add IPv6-to-IPv4 QUIC connection migration support", adds `kEnableQuicV6ToV4Migration` behind a flag, and the commit message is honest about how approximate the mechanism is:

> When this happens, we should migrate to an IPv4 address that routes to a "server" that has the state necessary to handle the migration. No RFC currently defines how to come up with an IPv4 address that guarantees that.
> https://datatracker.ietf.org/doc/draft-munizaga-quic-alternative-server-address/ is a start, but it's still a draft and requires implementing new frames. Until that is done, we approximate this IPv4 by using the IPv4 address we got during the original hostname resolution that led to the creation of the connection we're trying to migrate to an IPv4-only network. This is not perfect, but it's an initial approximation that lets us land the mechanism that will also be used by any long-term solution.

The follow-up plumbing lands in the same day: [`b6987cabf`](https://chromium.googlesource.com/chromium/src/+/b6987cabf), "Plumb fallback IPv4 address through AsyncDnsJob and EndpointConnector", routes the DNS-resolved IPv4 address through `QuicSessionPool::EndpointConnector` and `QuicSessionPool::AsyncDnsJob` into `QuicChromiumClientSession`. The `b5a6deda4` commit notes that `set_fallback_ipv4_peer_address()` "has no callers yet" — so this is two landing commits of a series, not a shipped feature. The flag is off.

Why does any of this belong in an ADB-in-browser post? Because QUIC connection migration is the transport-layer analogue of a problem every browser ADB client hits: the device is on a network, the network changes, the connection dies. WebUSB sidesteps it entirely — USB is a point-to-point link and the device never moves. But `adb tcpip` mode, wireless debugging with pairing codes, and any future WebTransport-based ADB transport all run into it. And this change is the browser starting to solve the hard version of it, where the address family itself changes mid-connection.

There is a third Chromium change from the same day that is worth a line because it will bite anyone running a proxy in front of a browser ADB client: [`2e584f27f`](https://chromium.googlesource.com/chromium/src/+/2e584f27f), "Check proxy server ports and reject HTTP/0.9 from HTTP proxies":

```
Validate proxy endpoints against IsPortAllowedForScheme() when starting
proxy connections and fail disallowed ports with
ERR_PROXY_CONNECTION_FAILED so standard proxy fallback applies.

Also reject statusless (HTTP/0.9) responses on non-tunneled HTTP proxy
requests with ERR_INVALID_HTTP_RESPONSE, including unencrypted legacy
Shoutcast 1.0 ("ICY 200") responses relayed verbatim over a configured
HTTP forward proxy.
```

Guarded by the `RestrictProxyPorts` and `RejectHttp09FromHttpProxy` killswitches. Both are hardening changes: previously Chrome would attempt a connection to *any* port a proxy config named, and would accept a statusless HTTP/0.9 response from a forward proxy. Neither is likely to affect a normal user, and both are behind killswitches, but the `ERR_PROXY_CONNECTION_FAILED` on disallowed ports is the kind of change that turns a silently-hanging request into a clean error — which is an improvement for debugging.

## The rest of the ecosystem: quiet

`yume-chan/ya-webadb` itself has not moved. The last commit on any branch is still `7bcec613` ("chore: release v3.0.0-beta.4") from 2026-10-09, and the most recent tagged release is still `v3.0.0-beta.5` from 2026-11-06, which this blog covered on November 7. (GitHub's `releases/latest` endpoint still reports `v2.6.4` from 2026-09-02, because the 3.0.0 betas are prereleases and do not displace it — a useful reminder that `latest` and "most recent tag" are different questions.) The npm dist-tags are unchanged:

```
@yume-chan/adb dist-tags: { latest: "2.6.4", beta: "3.0.0-beta.5" }
```

Every `@yume-chan/*` package — `adb`, `adb-scrcpy`, `scrcpy`, `adb-daemon-webusb`, `scrcpy-decoder-webcodecs`, `android-bin` — published its `3.0.0-beta.5` on 2026-11-06 within four minutes of each other, and has not published since.

The tracker is likewise quiet. The last issue activity is 2026-11-14T03:36:59Z — the closure of #398 ("Run .sh scripts") and #866 (the mouse-button mapping request), both pointing at Tango 3.2.0. That was covered yesterday. The most interesting *open* issue in the tracker right now is [#487](https://github.com/yume-chan/ya-webadb/issues/487), "Record and replay user input (macro)", opened by yume-chan themselves on 2026-09-02, and [#784](https://github.com/yume-chan/ya-webadb/issues/784), "[Feature Request] Support Android 11+ 'Wireless debugging' (TLS + pairing code/QR)", filed by CurseStaff on 2026-07-31. #784 is the one that matters for anyone trying to connect to a device over the network rather than USB, and it has been open for nearly four months.

Chrome's release channels are unchanged from last week: 158 is stable, 159 is in Beta, 160 is in Dev and Canary. Chrome 160 has exactly one web-facing deprecation in its release notes so far — [`chromestatus` feature 5160724576993280](https://chromestatus.com/feature/5160724576993280), removing `RTCPeerConnection.createDTMFSender()` on Windows, macOS, Linux, ChromeOS, and Android. Irrelevant to ADB, but worth recording because it is the first removal of a web API that anyone in this ecosystem might reasonably have used for DTMF-style input injection over a voice call, which was never a plausible ADB input path anyway.

`@devicefarmer/adbkit` is still at 4.1.0, published 2026-11-07. `Genymobile/scrcpy` is still at v5.0.1 from 2026-10-08.

## What this means for webadb.online

**The WebHID blocklist is a direct answer to a question webadb has not yet had to answer.** webadb's Screencast panel injects touch and keys today through `adb shell input tap` and `adb shell input keyevent` — the *software injection* path, the same one Tango calls "Software" mode and the one that is limited to ASCII. The UHID path discussed in yesterday's post would present a real HID keyboard to Android. The new `hid.spec.whatwg.org/blocklist.txt` says, in machine-readable form, that a page must not present a Generic Desktop / Keyboard to the operating system. Whether that rule binds a *browser-side* HID implementation is a separate question — the blocklist is about a page's access to *physical* HID devices through WebHID — but the security reasoning it states is the reasoning that will be applied to any browser-side HID proposal: input loggers, and subverting the OS focus model. The honest conclusion is that a webadb UHID implementation, if it ever happens, must go through the ADB-scrcpy control protocol to a server running *on the device* — not through a browser HID API. That is, in practice, what the Blazor project does: it pushes the scrcpy server and drives `UHID_CREATE` over the ADB control channel.

**The .NET binding is the most useful third-party validation ya-webadb has received.** It is a full second implementation of the library's surface — connect, authenticate, shell, sync, package manager, power, scrcpy, WebCodecs decode, control-message injection — built by someone who had never used the library before, against the published API only. Where it broke, it broke on the *protocol* rather than the API: the `BigInt`/`setUint64` mismatch in the touch control message. Those are exactly the bugs a second implementation surfaces and exactly the bugs webadb would surface if it ever moved from `adb shell screenrecord` to the real scrcpy control protocol. Reading its changelog is a free audit of the parts of ya-webadb that nobody but the TypeScript examples have exercised.

**Its 2.x version pin is the most actionable detail.** `SpawnDev.BlazorJS.TangoADB` binds `@yume-chan/adb` 2.6.0 and `adb-credential-web` 2.1.0, not the 3.0.0-beta.5 line. The 3.x line renamed the credential storage — `TangoLocalStorage` (base64 PKCS#8) became `AdbWebCredentialStore` (WebCrypto + IndexedDB) — and split `adb-scrcpy` out of `scrcpy`. webadb is on the 3.0.0-beta.1 line and uses `AdbWebCryptoCredentialManager` with `TangoLocalStorage`. A wrapper pinned to 2.x is a wrapper that never touched the credential refactor, which means the IndexedDB credential path is still under-exercised outside the TypeScript ecosystem. That is a gap worth watching.

**And Chromium's QUIC address-family migration is a quiet signal about where the transport layer is heading.** If a future webadb wants to talk to a device over the network — wireless debugging, `adb tcpip`, a WebTransport relay — it will be competing with a browser that is actively learning to move a connection from IPv6 to IPv4 without dropping it. The optimistic-DNS change makes the first connection to a slow-resolving host faster; the migration work makes the *second* connection, on a different network, not need one. Neither helps a USB-attached device. Both matter for the day webadb stops being USB-only.

The chrome-direct-sockets check ran today (Monday). The Direct Sockets API's ChromeStatus entry was last updated 2025-01-14 and shows no new stage activity, no new origin trial, and no movement in the WICG tracker — the feature remains available only to Isolated Web Apps, with no change in the last 24 hours. The WICG/direct-sockets issue #35 "Current status?" still records that the project "is partially implemented and still intended to go ahead, but is on hold awaiting a more-secure context than is currently available." There is still no path for a regular web page to open a raw TCP socket, which means a browser ADB client still has no way to reach an `adb tcpip` server except through WebTransport or a WebSocket relay.
