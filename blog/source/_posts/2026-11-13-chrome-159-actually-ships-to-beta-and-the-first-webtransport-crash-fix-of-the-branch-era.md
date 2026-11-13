---
title: "Chrome 159 actually ships to Beta, and the first WebTransport crash fix of the branch era"
date: 2026-11-13 01:00:00 UTC
tags:
  - chrome-159
  - webtransport
  - quic
  - adb
  - platform-tools
---

Chrome 159 was promoted to the Beta channel yesterday afternoon, and the promotion is now a fact rather than a schedule: Chrome for Testing reports `Beta 159.0.8154.6` and `Canary 160.0.8158.0` as of this morning. The build carries branch position `1739869`, which means every WebTransport behaviour this blog has spent three posts describing is now on a channel real users can install. Same day, in a completely different corner of the browser, a Chromium CL landed on `main` that fixes a WebTransport crash in the handshake state machine — a crash that has existed since the API shipped, and which the branch just made reachable for far more people.

## The promotion: 159.0.8154.6, branch position 1739869

The Chrome Releases blog carried four entries on Thursday, November 12:

| Entry | Version | Time |
|---|---|---|
| Early Stable Update for Desktop | 158.0.8127.36/.37 | Nov 12, 09:05 PM |
| Chrome Beta for Desktop Update | 159.0.8154.6 | Nov 12, 07:53 PM (Win/Linux), 08:28 PM (Mac) |
| Chrome Beta for Android Update | 159.0.8154.4 | Nov 12, 05:35 PM |
| Chrome Beta for iOS Update | 159.0.8154.5 | Nov 12, 05:32 PM |

The Desktop announcement is the one that matters for this blog:

> The Chrome team is excited to announce the promotion of Chrome 159 to the Beta channel for Windows, Mac and Linux. Chrome 159.0.8154.6 contains our usual under-the-hood performance and stability tweaks, but there are also some cool new features to explore — please head to the Chromium blog to learn more!

Three things are worth noticing about the shape of this milestone. First, the beta branch position is `1739869`, which is the *same* position that Canary carried as `159.0.8154.x` on November 10 — the 8154 branch was cut from `main` at `{#1739869}` and every platform's beta build descends from that single cut point. Second, Chrome 159 goes stable on **December 8**, which makes for a three-week window between early-stable (November 18) and stable. That is the compressed holiday window the release calendar absorbs by shortening beta, and it is why the beta channel is currently the only place to test anything new — Chrome 158 only reaches stable on November 17, so the two milestones overlap. Third, the Canary build moved to **160.0.8158.0** at position `1742811` on the same day, which means `main` was already roughly 3,300 commits past the branch point when the beta build shipped.

That last number matters for the next section.

## The crash fix: `fafa2796e51f`, and why its position matters

At **2026-11-12T19:18:19Z**, Monica Chintala landed commit `fafa2796e51f` on `main`:

```
Fix crash when WebTransport connection is closed during handshake

When a peer sent a QUIC CONNECTION_CLOSE frame with QUIC_NO_ERROR while
the WebTransport client was still CONNECTING, OnConnectionClosed treated
it as an established clean close and transitioned to CLOSED. That
violated the state invariant and could invoke OnClosed before the
handshake client had been replaced by the connected client.

Treat QUIC_NO_ERROR as a clean close only after reaching CONNECTED.
During the handshake, record the QUIC close details and transition
directly to FAILED so OnConnectionFailed is delivered without
re-entering the connect state machine.

Add regression coverage for a clean QUIC close while the client is
waiting for the WebTransport response.

Bug: 582443259
Change-Id: I33c407eef265a11d79f5c1f3a21ab08f6029d41d
Reviewed-on: https://chromium-review.googlesource.com/c/chromium/src/+/8747705
Reviewed-by: Nidhi Jaju <nidhijaju@chromium.org>
Commit-Queue: Monica Chintala <monicach@microsoft.com>
Cr-Commit-Position: refs/heads/main@{#1743223}
```

The diff touches exactly two files:

```
modified  +1/-7    net/quic/dedicated_web_transport_http3_client.cc
modified  +99/-0   net/quic/dedicated_web_transport_http3_client_test.cc
```

Seven lines removed from the implementation, ninety-nine lines of regression test added. This is the smallest possible diff for the bug it fixes, which is a good sign — it means the state machine was already close to correct and the failure was one missing guard.

### The bug, precisely

The WebTransport connect path has a state machine with, at minimum, `CONNECTING`, `CONNECTED`, `CLOSED`, and `FAILED` states. The transport sits in `CONNECTING` while the HTTP/3 CONNECT request is in flight, waiting for the server's response. During that window the underlying QUIC connection can be closed by the peer at any moment.

The bug was that a QUIC `CONNECTION_CLOSE` frame carrying `QUIC_NO_ERROR` — which semantically means "everything is fine, goodbye" — was treated as a *clean* close no matter what state the transport was in. So a peer that opened the connection and then closed it politely, while the client was still waiting for the WebTransport response, drove the transport from `CONNECTING` straight to `CLOSED`.

That transition violates the state invariant. `CLOSED` is the terminal state of a session that was *established and then cleanly shut down*. Reaching it from `CONNECTING` means the client never had a session, but the code path believes it did — and, as the commit message puts it, `OnClosed` could fire "before the handshake client had been replaced by the connected client." The handshake client and the connected client are two different objects in Chromium's implementation; the invariant is that the swap happens exactly once, on successful connection. A close during the handshake could invoke the terminal callback against the wrong one.

The fix makes the interpretation of `QUIC_NO_ERROR` state-dependent:

- After `CONNECTED` → treat it as a clean close, transition to `CLOSED`. Unchanged; this is the ordinary path.
- During `CONNECTING` → record the QUIC close details and transition directly to `FAILED`, so `OnConnectionFailed` is delivered and the connect state machine is not re-entered.

That distinction — *clean close* versus *failure during setup* — is exactly the distinction the spec draws between a `closed` transport and a `failed` one, and exactly the distinction an application needs in order to distinguish "the server hung up" from "the server never accepted me."

### Where it landed, and where it is not

`Cr-Commit-Position: refs/heads/main@{#1743223}`. The beta build that shipped yesterday is at `{#1739869}`. The difference is 3,354 commits.

That means **the crash fix is not in Chrome 159 beta**. It is on `main`, and will ship in whichever milestone cuts from `main` after it — Chrome 160, whose branch point is scheduled for November 30, or Chrome 161 if the M160 branch point slips. Anyone who installs Chrome 159 Beta today and reproduces the crash by closing a peer connection during the handshake will still see it.

This is the branch discipline in action, and it is worth being precise about because the two facts are easy to conflate. Yesterday's blog described the spec churn that will *define* Chrome 160. This is the complementary fact: Chrome 160 is also where the *implementation* catches up with the parts of the API that shipped in 159 and turned out to be wrong.

The bug tracker reference is `582443259`; the review is [chromium-review CL 8747705](https://chromium-review.googlesource.com/c/chromium/src/+/8747705), reviewed by Nidhi Jaju — the same engineer who authored the `exportKeyingMaterial` and `exportKeyingMaterial` spec PRs ([w3c/webtransport#644](https://github.com/w3c/webtransport/pull/644)) in April and June.

## The quiet rest of the surface: nothing else moved

A full sweep of `chromium/chromium`'s `main` for the November 12 UTC day — 600 commits, positions `{#1734768}` through `{#1743570}` — turns up exactly **one** commit touching WebTransport, one touching USB, and zero touching WebUSB, Web Serial, Bluetooth, or Direct Sockets.

That last number is worth a note, because the weekly Direct Sockets check is a Monday-only item on this blog's calendar and today is Friday, so it was skipped by policy. But the Chromium-side data says there was nothing to find anyway: no `openTCPSocket`, no `direct_sockets` directory, no QUIC socket work landed on November 12.

The `w3c/webtransport` specification repository was equally quiet. Its `main` branch head is still `91b5a73` — "Merge pull request #815 from jan-ivar/datagram-byte-cap", merged **2026-11-04T00:58:42+0100**. No merge has landed in nine days. The fourteen unreviewed PRs from `JinDX` that this blog covered on November 12 remain open and unreviewed, with the `reviews` array still empty on every one. The newest activity in the repository is PR [#833](https://github.com/w3c/webtransport/pull/833) (opened and closed on November 11), and nothing has happened since.

And ChromeStatus is silent: across the `usb`, `webusb`, `serial`, `bluetooth`, and `webtransport` categories — 92 feature entries in total — **not one** has an `updated` timestamp of November 11 or later. The most recently touched WebTransport entry is "WebTransport connection statistics" at `2026-11-10 18:28:56` by `vbryhider@microsoft.com`. The most recently created is "WebTransport Datagram writable streams and prioritization" at `2026-08-20`.

The shape of this week is therefore: the milestone shipped, and the moment it shipped, the implementation started accruing the fixes that shipped milestones always accrue.

## The other half of the ADB story: Platform-Tools 37.0.3

Chrome is only half of the browser-ADB story. On the device side, Google shipped **SDK Platform-Tools 37.0.3** (Canary: November 2026, released **2026-11-10**) with a set of changes that are quietly important for anyone building ADB tooling — including webadb.

```
adb
- Reduce debug log spam. Demote high-frequency data-plane logs (such as reads
  and writes) to verbose level (for example: usb:v, transport:v) to prevent
  large log files.
- Add support for syncing the system_dlkm, vendor_dlkm, and odm_dlkm partitions
  in the adb sync command.
- Deprecate the adb install --fastdeploy option in favor of the
  android install command. Fast Deploy remains temporarily available using
  the --deprecated-fastdeploy flag and will be removed in later releases.
- Add support for wireless pairing using a QR code in the terminal
  (the adb pair --qr command).

Linux:
+ Introduce the libadbusb library to replace the legacy USB backend
  (ADB_USB_LEGACY=1). The libadbusb library uses periodic USB bus polling
  (1000ms default, configurable using the ADB_USB_LINUX_POLL_INTERVAL_MS
  environment variable) instead of netlink hotplug to avoid missing devices
  after in-place USB resets or concurrent start-server command races.
+ Improve the legacy USB backend (ADB_USB_LEGACY=1). Add a reconnection
  retry loop to recover devices in case of missing netlink events.

MacOS:
+ Introduce the libadbusb library to replace the legacy USB backend.
  The libadbusb library can be disabled by setting the ADB_USB_LEGACY
  environment variable to 1.
+ Fix an adb server crash (abort in _Unwind_Backtrace) on Apple Silicon M6
  (macOS 27) caused by capturing backtraces on ignored non-ADB mDNS records.
+ Fix an adb server crash (KERN_INVALID_NAME Mach port exception) on USB
  device attach when AMFI is disabled.
```

Three of these are worth unpacking for a browser-based ADB client.

**`libadbusb` replaces netlink hotplug on Linux.** The rationale in the release note is precise: netlink hotplug *misses* devices after an in-place USB reset, and it races with concurrent `start-server` invocations. The replacement polls the USB bus directly every 1000 ms by default, tunable via `ADB_USB_LINUX_POLL_INTERVAL_MS`. This is the same class of problem that `libadbusb` was already solving on Windows — 37.0.1 (July 2026) introduced it there, replacing `libusb`. macOS 37.0.1 had gone the other way, *disabling* `libusb` and using the legacy backend, and 37.0.3 now brings `libadbusb` to macOS too.

**The polling model is a direct admission that hotplug is unreliable on USB.** Every layer of the stack has been forced to acknowledge it: 37.0.0 moved Linux from an active loop to netlink; 36.0.2 had moved Linux *back* to the legacy backend because of "device disconnection, interface read failure, and delayed netlink events preventing device detection"; and now 37.0.3 moves to a hybrid — poll, but keep the hotplug path alive in the legacy backend with a reconnection retry loop.

**`adb pair --qr` is the feature that finally makes wireless pairing scriptable.** Pairing a device today means reading a six-digit code off the phone and typing it into a terminal. `--qr` renders a QR code *in the terminal* — the same pairing flow the Android UI has offered for years, but now reachable from a script. This is the CLI equivalent of the QR-code pairing screen, and it removes the last manual step.

### Why this matters to a browser client specifically

webadb does not run `adb`. It implements the ADB host protocol directly over WebUSB, in JavaScript, inside a browser tab. But the release notes describe the *problems* webadb shares, because both are talking to the same `adbd` on the other end of the same wire.

The `libadbusb` story is the clearest example. Chromium's WebUSB stack has its own device-attachment model, and the "device vanished after an in-place reset" class of bug is the same class of bug regardless of who owns the USB stack. When `libadbusb` polls the bus every second rather than trusting hotplug, it is accepting that the OS's hotplug signal is a best-effort notification, not a guarantee. A WebUSB implementation that keys off `navigator.usb` connection events is making the same bet.

The `adb pair --qr` change is more directly comparable to something webadb does not yet do: webadb's Wi-Fi ADB panel reaches the device over the local network by IP address, but pairing itself still requires the user to type a code.

The `adb install --fastdeploy` deprecation is the one to watch for breakage. Fast Deploy — the incremental APK install that pushes only the changed dex files — is being retired in favour of the new `android install` command. webadb's APK install path currently does a full push-and-install through `adb install` semantics; it does not use Fast Deploy and never has. But the deprecation is a signal about where Google's ADB CLI is going: the `adb` subcommand surface is being consolidated under an `android` command, which is a much larger CLI than `adb` ever was.

## What this means for webadb.online

No impact on webadb itself this week — the webadb side of the project shipped nothing new in the last 24 hours beyond yesterday's blog post, and `ya-webadb` upstream has been quiet since `v3.0.0-beta.5` on November 6, with no commits, no new PRs, and no releases in the last 24 hours. The Chrome Direct Sockets check was skipped per the weekly Monday schedule.

The relevance is threefold and increasingly concrete:

**Chrome 159 Beta is the first channel where webadb's target audience can actually get the WebTransport features that this blog has been tracking.** If you are running an ADB-over-WebTransport experiment — a WebTransport session to a TCP bridge in front of `adbd` — you can now install Chrome 159 Beta on Windows, Mac, Linux, Android, or iOS and test against the real implementation rather than a flag. Chrome 160 will revise four of those behaviours under you (the `outgoingMaxAge` type change, the byte-based datagram send-queue cap, the `getStats()` per-session stability guarantee, and in-parallel datagram reception), so the window for testing against 159's exact semantics is roughly four weeks wide.

**The `fafa2796e51f` crash is a template for what to expect from a milestone that ships an unfinished state machine.** The WebTransport connect path had a clean-close path that did not check whether the connection had ever been established. That is not an exotic bug — it is the kind that only shows up when a peer does something unusual, which in practice means "when a real server does something unusual." The fix will land in Chrome 160 at the earliest. If you are testing against Chrome 159 Beta, treat a transport that closes during handshake as a *failure*, not a clean close, and do not rely on `OnClosed` semantics during the connecting phase.

**Platform-Tools 37.0.3's `libadbusb` is the strongest argument yet that hotplug is not a reliable signal, on any stack.** Chromium's WebUSB and AOSP's `libadbusb` arrived at the same conclusion from different directions: poll, and treat attach/detach events as hints. webadb's WebUSB transport is a poll-free event-driven design; it should expect that a device which resets in place may need a re-enumeration nudge rather than a clean detach/attach cycle.

Chrome 159 goes stable December 8. The WebTransport crash fix is already on `main`, 3,354 commits past the branch point, waiting for the next milestone to pick it up.
