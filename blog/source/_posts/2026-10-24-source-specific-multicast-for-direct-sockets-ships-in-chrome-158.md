---
title: Source-Specific Multicast for Direct Sockets ships in Chrome 158
date: 2026-10-24 01:00:00
tags:
  - direct-sockets
  - source-specific-multicast
  - ssm
  - chrome-158
  - chromestatus
  - isolated-web-apps
---

The chromestatus row for [Source Specific Multicast for Direct Sockets
API](https://chromestatus.com/feature/6208452397498368) — feature id
`6208452397498368` — refreshed on **2026-10-22 20:05:35**, and it did not
refresh by inches. `is_released` flipped from `false` to `true`, the active
stage's `desktop_first` populated to **158**, and the mirror at
chromestatuslite now renders the row as *"Enabled by default (Chrome
158)"*. Chrome 158 goes stable on **2026-11-17**. This is the row that the
[Oct 12 post](https://webadb.online/blog/2026/10/12/2026-10-12-monday-recheck-ssm-direct-sockets-revert-chromium-3076e5f5/)
told readers to watch, because it was the one chromestatus surface that
had gone stale in a way the surrounding Monday series had never
distinguished: the SSM implementation had been reverted out of the
chromium tree in March, and the documentation row still said "no
milestone, last updated Feb 21" — a date *before* the revert landed. As
of today the row says the feature is enabled by default in a Chrome
release that is three and a half weeks out. The revert is history.

The re-land itself was nine CLs over three days, landing in `main` between
2026-10-19 and 2026-10-21 — squarely inside the 24-hour window this post
covers, and only hours after the [Oct 19
post](https://webadb.online/blog/2026/10/19/2026-10-19-monday-recheck-chromestatus-still-frozen-but-tree-has-cleaned-up-direct-sockets-private/)
described the tree as "unwinding" the Direct Sockets Private Network
Access layer.

## The chromestatus row, field by field

The `/api/v0/features/6208452397498368` payload today, against the Oct 12
snapshot recorded in the previous post:

```text
                          Oct 12                     Oct 24
updated.when:              2026-02-21 02:52:29      2026-10-22 20:05:35
updated.by:                (unchanged)               omar@blockcast.net
accurate_as_of:            2026-02-21 02:52:29      2026-10-22 20:05:35
is_released:               false                     true
active_stage_id:           (160 stage)               5117210058162176
stage 160 desktop_first:   null                      158
stage 130 desktop_first:   null                      152
intent_stage:              "None"                    "None"
flag_name:                 (absent)                  source-specific-multicast-in-direct-sockets
finch_name:                (absent)                  SourceSpecificMulticastInDirectSockets
spec_link:                 WICG/direct-sockets/pull/81  wicg.github.io/direct-sockets/#dom-multicastgroupoptions-sourceaddress
api_spec:                  (unset)                   true
shipping_year:             2026                      2026
first_enterprise_notification_milestone:  143
enterprise_impact:         (medium-ish)              1
bug_url:                   issues.chromium.org/issues/461262401  (unchanged)
```

Three of those lines are doing a lot of work.

**`is_released: true`** is the field the whole Monday series has been
polling on the *other* Direct Sockets row (`6046077976444928`, the
permission-policy merger) and watching refuse to move for five
consecutive weeks. Here it moved. The distinction matters: the merger
row's `is_released: false` is a documentation staleness bug — the feature
shipped in Chrome 151 and the row never got the memo. The SSM row's
`is_released: true` is a documentation *catch-up* — the feature genuinely
did not ship anywhere until three days ago.

**`desktop_first: 158`** on the active stage (id `5117210058162176`,
stage_type 160) is the shipping milestone. The stage 130 entry — the
"intent to ship" slot, which carries
[`intent_thread_url`](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/692dffe2.050a0220.17ec37.0673.GAE%40google.com)
and an `announcement_url` of
`https://groups.google.com/a/chromium.org/g/blink-dev/c/vMmLZVd7rQI` —
carries a `desktop_first` of **152**. That is the milestone that was
proposed in November 2025 and then lost to the March revert. Chromium
moved the target from 152 to 158.

**`flag_name` / `finch_name`** appearing for the first time is the
fingerprint of the "ship" CL landing. Before this, SSM had a
`runtime_enabled_features.json5` entry gated behind a feature flag that
was never stable. Now the flag exists as a first-class, killable Finch
feature:

```text
chromium/src: third_party/blink/renderer/platform/runtime_enabled_features.json5
  kSourceSpecificMulticastInDirectSockets
  → enabled by default as of the 158 branch point
```

The chromestatuslite mirror renders all of this in one line —
**"Enabled by default (Chrome 158)"** — and the Chrome 158 bucket page at
`chromestatuslite.com/?version=158` now lists *Source Specific Multicast
for Direct Sockets API* among the features shipping in that milestone.

## The re-land: nine CLs in three days

The chromium-side story is on the tracking bug,
[issues.chromium.org/issues/461262401](https://issues.chromium.org/issues/461262401),
which carries every commit as a comment. The March history for context,
since the Oct 12 post covered it in depth:

```text
2026-03-07  acf38610f12403205046ed055c58e954b165421a
            "Allow MCAST_JOIN/LEAVE_SOURCE_GROUP in network service seccomp filter"
            refs/heads/main@{#1595817}

2026-03-10  030237772913cd7805c13962d9a50b145c7ba90d
            "Add SSM support to Direct Sockets API (services/network and Blink layers)"
            refs/heads/main@{#1597329}

2026-03-11  3076e5f581b85be166e932615caac9f83c322faa
            "Revert \"Add SSM support to Direct Sockets API (services/network and Blink layers)\""
            refs/heads/main@{#1597454}
            Reason: Suspicious about causing test failures of
            ChromeDirectSocketsUdpIsolatedWebAppMulticastTest
              .MulticastJoinGroupSSMSameGroupDifferentSources

2026-03-12  5749767220104c43be19694ebcc7e756850bde03
            refs/heads/main@{#1598159}

2026-03-18  7cfd0862612bfcb89db88414860249221b704ee2
            refs/heads/main@{#1601525}

2026-07-14  863435829ee0f5679fad41bc117670acdf3dbc5e
            "Add SSM support to Blink MulticastController and browser integration"
            refs/heads/main@{#1661529}
            → "This is a reland of the blink/browser portion of commit
               030237772913c, which was reverted in 3076e5f581b85."
```

That July 14 reland is the CL that Chromium Dash surfaced in search
results earlier this week, and it is the hinge of the whole story: the
Blink/browser half of the feature came back in July, but the
network-service half — the part that actually plumbs `source_address`
through `RestrictedUDPSocket` into `//net` and calls
`JoinSourceGroup()` instead of `JoinGroup()` — did not. Without the
network-service half, the Blink half is a flag-guarded API surface that
cannot complete a join.

Then, in a 60-hour burst starting Monday 2026-10-19:

```text
2026-10-19 13:31:00  a559af362c7f4b9fb27e41efdf73b5d15ea30401
            "[Direct Sockets] Reject non-multicast groups in RestrictedUDPSocket"
            crrev.com/c/8583003       refs/heads/main@{#1721842}

2026-10-19 14:02:10  a9a57df5bd3e82ee75d927c0a87ba8dbac44b2d9
            "Reject invalid group addresses in network::UDPSocket"
            crrev.com/c/8583123       refs/heads/main@{#1721866}

2026-10-20 10:42:54  ca9cb7f5721d5e1e485c2c622878f2783479f992
            "[Direct Sockets] Reject loopback sourceAddress in MulticastController"
            crrev.com/c/8582708       refs/heads/main@{#1722769}

2026-10-20 (rolled)  59141ddb29dde8d8e8f34f331d7e15efe1daee04
            devtools-frontend: "[network] Key Direct Sockets multicast
             memberships by group and source"
            crrev.com/c/8586159

2026-10-20 13:19:36  6408d75ec58d666f6e045bd8cda5fef846d423ef
            "[Direct Sockets] Count SSM joins separately from ASM joins"
            crrev.com/c/8574609       refs/heads/main@{#1722854}

2026-10-20 13:24:40  c0b84c898438c3fea8cb8a5af3ee807864c5b8f4
            "[Direct Sockets] Report the SSM source separately in CDP events"
            crrev.com/c/8588617       refs/heads/main@{#1722855}

2026-10-21 23:02:15  8774e07525eb94b789d22da15451a772af708986
            "[Direct Sockets] Ship SourceSpecificMulticastInDirectSockets"
            crrev.com/c/8581753       refs/heads/main@{#1724238}
```

The last one is the ship commit, and it is 24 hours and change old:

```text
[Direct Sockets] Ship SourceSpecificMulticastInDirectSockets

Sets the runtime_enabled_feature for
SourceSpecificMulticastInDirectSockets to stable. This exposes the
sourceAddress option on MulticastController.joinGroup()/leaveGroup()
and the MulticastMembership entries in joinedGroups. Like the rest of
Direct Sockets multicast, the API is only exposed to Isolated Web Apps.

The generated blink::features::kSourceSpecificMulticastInDirectSockets
becomes enabled by default, which also enables the browser-side
plumbing in DirectSocketsServiceImpl and keeps a Finch kill switch for
both.

Chromestatus: https://chromestatus.com/feature/6208452397498368
I2S: https://groups.google.com/a/chromium.org/d/msgid/blink-dev/6ad03dc5.32cf16a2.aa5e8.002a.GAE%40google.com

Bug: 461262401
Change-Id: I595e7abcc9c747a4991b4bbf6a9ab17371fd1611
Reviewed-on: https://chromium-review.googlesource.com/c/chromium/src/+/8581753
Commit-Queue: Mike Taylor <miketaylr@chromium.org>
Reviewed-by: Reilly Grant <reillyg@chromium.org>
Reviewed-by: Mike Taylor <miketaylr@chromium.org>
Cr-Commit-Position: refs/heads/main@{#1724238}
```

Note the file list on that CL: exactly one file,
`third_party/blink/renderer/platform/runtime_enabled_features.json5`.
That is how a "ship" lands in chromium — the implementation is already
in `main` from the earlier CLs, and flipping a feature is a one-line
JSON5 edit. Every one of the preceding eight CLs is the *preparation*
that makes the one-line flip safe.

## What the eight preparatory CLs actually fixed

The March revert's stated reason was a single failing test:
`ChromeDirectSocketsUdpIsolatedWebAppMulticastTest.MulticastJoinGroupSSMSameGroupDifferentSources`.
Six months and a half later, the re-land sequence addresses that test
directly, plus three adjacent crash-and-validation bugs that the original
March CL had papered over with `NOTREACHED()`s and `CHECK`s.

**1. Non-multicast group addresses crashed the network service.**
`RestrictedUDPSocket::JoinGroup()` / `LeaveGroup()` forwarded whatever
group address the renderer sent straight into `//net`. A compromised
renderer could send an empty group address; the ASM path hit a
`NOTREACHED()` in `UDPSocketPosix::JoinGroup()`, and — once SSM was
enabled — the SSM path hit a size `CHECK` in `ToIn6Addr()`. `8583003`
re-checks the group address alongside the other renderer preconditions
and reports a bad message instead. Blink already validated group
addresses with the same `net::IPAddress::IsMulticast()`, so well-behaved
renderers are unaffected.

**2. The same hole existed one layer down.**
`network::UDPSocket::JoinGroup()` passed the group address from Mojo
straight to `//net`, and Mojo deserialization accepts an empty address.
`8583123` returns `ERR_ADDRESS_INVALID` instead of letting `//net`
`NOTREACHED()`. The commit message notes the blast radius explicitly:
*"A client that holds a raw UDPSocket, such as the Mirroring Service (a
sandboxed utility process), could therefore crash the network service."*
This one is a general `network::UDPSocket` fix, not a Direct Sockets
fix — it covers every UDPSocket client.

**3. Loopback source addresses were accepted.**
The Direct Sockets spec's `joinGroup()` steps
([WICG/direct-sockets#81](https://github.com/WICG/direct-sockets/pull/81))
throw a `TypeError` when `sourceAddress` is a multicast, loopback, or
unspecified address. `MulticastController` only rejected multicast and
unspecified sources. `8582708` closes the loopback gap.

**4. The use counter was double-counting.**
`[MeasureAs]` on `joinGroup()` counted *every* call, so after the flag
existed, SSM joins would have inflated the ASM counter. `8574609` adds
`MulticastControllerJoinGroupWithSourceAddress` for joins that pass a
`sourceAddress` and stops those calls from also counting
`MulticastControllerJoinGroupFunction`. It also stops counting calls
that fail argument conversion in the bindings — so the counter now
measures *successful* joins rather than *attempted* ones.

**5. CDP events encoded the source into the group string.**
`Network.directUDPSocketJoinedMulticastGroup` and
`Network.directUDPSocketLeftMulticastGroup` used to put `"group@source"`
(e.g. `232.1.1.1@192.0.2.100`) into the `IPAddress` field. `8588617`
splits them: `IPAddress` now carries only the group, and a new optional
`sourceAddress` parameter carries the source. ASM events are unchanged
and omit `sourceAddress`.

**6. DevTools had to be taught the new shape before the browser sent it.**
The devtools-frontend CL `8586159` keys `joinedMulticastGroups` by
*group and source* rather than by `IPAddress` alone — otherwise one
group's memberships from different sources would merge into one key, and
leaving one of them would drop the rest. The SSM keys keep the existing
`"group@source"` text form so `DirectSocketConnectionView` output is
unchanged and an older backend that still sends the combined string
produces the same key. The Chromium CL explicitly sequences itself:
*"Land this CL after a devtools-frontend roll that includes it, so
DevTools never keys SSM memberships by group alone."* The roll landed on
Oct 20 (`8619113`, "Roll DevTools Frontend from 789c779b3d50 to
59141ddb29dd (4 revisions)"), one day before the browser-side CL.

**7. The seccomp allowlist.**
`MCAST_JOIN_SOURCE_GROUP` and `MCAST_LEAVE_SOURCE_GROUP` have to be in
the BPF setsockopt allowlist for the network service sandbox, or any SSM
`setsockopt` call hits `CrashSIGSYSSockopt()` and kills the process.
That landed back in March (`7641869`,
`sandbox/policy/linux/bpf_network_policy_linux.cc`) and survived the
revert, since it is not part of the reverted CL.

**8. The macOS test-bots problem.**
The original March test used `192.0.2.1` (TEST-NET-1) as a second
source address. macOS's `GetInterfaceForDestination` uses `connect()`
to find the outgoing interface; with a non-routable destination it
returns interface index 0 and `MCAST_JOIN_SOURCE_GROUP` fails. The fix
constructs `source2` by toggling the last byte of `source1`, giving a
same-subnet address that *is* routable via the same interface. The
commit message notes the remaining known issue: on macOS 15 test bots,
joining a group with a second source still fails with `NetworkError`
(`crbug.com/443716695`); it succeeds on macOS 26.

## The API shape, and the availability constraint that surrounds it

The spec anchor is
[`MulticastGroupOptions.sourceAddress`](https://wicg.github.io/direct-sockets/#dom-multicastgroupoptions-sourceaddress),
and the interoperability story is the interesting part — the SSM addition
is strictly additive at the API level:

```js
// ASM — unchanged, works exactly as before
const socket = await navigator.openUDPSocket({ address: "232.1.1.1", port: 5000 });
socket.joinGroup("232.1.1.1");

// SSM — new: only receive datagrams from this source
const ssm = await navigator.openUDPSocket({ address: "232.1.1.1", port: 5000 });
ssm.joinGroup("232.1.1.1", { sourceAddress: "192.0.2.100" });
```

The compat contract, per the chromestatus `interop_compat_risks` field:
*"sourceAddress is an optional dictionary member: code that doesn't pass
it behaves exactly as before, and joinedGroups still returns strings for
ASM memberships. Where SSM is unavailable (older Chrome, or the feature
turned off), sourceAddress is ignored and joinGroup() makes an ASM join;
apps can detect this because joinedGroups then lists a string, not a
MulticastMembership."*

That last sentence is the detection mechanism worth writing down:
**the presence of a `MulticastMembership` object in `joinedGroups` (rather
than a plain string) is the runtime signal that SSM actually took
effect**, as opposed to being silently downgraded to an ASM join.

Two rules constrain usage, and both are enforced in Blink now:

- You cannot mix ASM and SSM for the same group on one socket. Joining
  `232.x.x.x` with a source and then joining the same group without one
  is rejected.
- `sourceAddress` must not be multicast, loopback, or unspecified — a
  `TypeError` per spec, now enforced.

`joinedGroups` returns `MulticastMembership` dictionary entries — `(group,
source)` pairs — instead of bare group strings. Several sources for one
group are additive (RFC 4604).

The security rationale is the one that made this worth shipping. RFC 8815
deprecates ASM for inter-domain use. Without SSM, an IWA receiving
multicast has to accept and application-layer-filter every packet sent to
the group, which burns CPU and bandwidth on traffic it will discard, and
which an off-path host can use as a denial-of-service amplifier. With SSM,
the OS and the SSM router drop datagrams from other source addresses
before they reach the socket. The chromestatus entry is careful to state
the limit of that claim: *"It is not authentication: a host that forges
the source address can potentially still inject (RFC 4607 §7.4), so apps
that need authenticity must authenticate content, as with ASM."*

### The availability constraint is the real story

None of this reaches a normal web page. The chromestatus
`availability_expectation` field is blunt:

> *"Available only to Isolated Web Apps, on platforms where IWAs are
> supported (currently ChromeOS): IWAs installed by an admin or in
> developer mode, and user-installed IWAs that Chrome's IWA allowlist
> grants the DIRECT_SOCKETS_MULTICAST entitlement. Not available on
> Android or WebView."*

The `all_platforms_descr` field adds the platform matrix in detail: Direct
Sockets is implemented on desktop platforms but only reachable where
isolated web apps are supported, which is currently ChromeOS only.
Android and WebView do not support Direct Sockets at all. On the
permissions-policy side, since M150 ChromeOS users can install IWAs that
are on Chrome's IWA allowlist, and a user-installed IWA gets the
`direct-sockets-multicast` policy only if the allowlist grants it the
`DIRECT_SOCKETS_MULTICAST` entitlement. There is no new permission, no
new prompt, and no new content setting — SSM inherits ASM's exposure
exactly.

The `wpt_descr` field is refreshingly honest about the state of the
tests:

> *"There is no SSM WPT yet (follow-up tracked in crbug.com/461262401):
> the spec rejects loopback sources, so the test has to send from a
> non-loopback address of the test host, which I haven't validated on the
> WPT bots yet. The ASM multicast WPT
> (direct-sockets/udp_socket_multicast.https.html) runs in Chromium's
> virtual/direct-sockets suite (Timeout on Mac, crbug.com/443716695;
> flaky on Linux, crbug.com/570251397). No Chromium test sends SSM
> datagrams yet either."*

So SSM ships in 158 with **no WPT coverage**, no Chromium test that
actually sends an SSM datagram, and a known-flaky ASM multicast WPT that
does not even run cleanly on macOS or Linux bots. What exists instead is
a unit-test and browser-test matrix:

```text
blink_unittests:      MulticastControllerSsmTest.*
                      (validation, membership rules, IP-version mismatch,
                       ASM/SSM mixing)
content_browsertests: DirectSocketsBoundUdpBrowserTest.*SSM*
browser_tests (IWA):  ChromeDirectSocketsUdpIsolatedWebAppMulticastTest.*SSM*
net_unittests:        UDPSocketTest.JoinSourceGroup*, LeaveSourceGroup*,
                      SSMSourceFilteringMultiNIC*
services_unittests:   bad-message / invalid-address tests
                      (crrev.com/c/8583003, crrev.com/c/8583123)
```

Note the `IDL feature-flag tests` in the blink_unittests line — the flag
itself is now tested.

## The merger row has STILL not moved, and nobody else has spoken up

The other Direct Sockets row this blog has tracked for five consecutive
Mondays is unchanged on every field. The API payload for
`6046077976444928` today:

```text
updated.when:         2026-06-22 13:32:10.563438   (unchanged since Jun 22)
updated.by:           bhaskarsharma@google.com
is_released:          false
accurate_as_of:       2026-06-22 13:32:10.563438
intent_stage:         "None"
active_stage_id:      5101390021132288  (stage_type 160, desktop_first: 151)
shipping_year:        2026
```

And the mirror's rendering of it, side by side with the SSM row on the
same site:

```text
/feature/6208452397498368   Status: Enabled by default (Chrome 158)
/feature/6046077976444928   Status: Proposed (Chrome Proposed)
```

Same site, same day, same author-type of question, two completely
different answers. The merger row *is* the one that shipped in Chrome
151 — the Oct 5 post established that the bucket page listing it under
"Enabled (18) in 151" is the canonical signal, and the chromium tree
has since been actively *unwinding* the `direct-sockets-private` policy
it introduced (`f1b445b8` removes the permission policy; a follow-up
removes the never-launched DSPNA enterprise policies). The SSM row *is*
the one that genuinely just shipped, three days ago, in 158.

So the two rows have swapped roles since the Oct 19 post. Previously
SSM was the row that lagged behind reality (implementation reverted,
documentation said "in development"), and the merger was the row that
lagged behind reality in the opposite direction (implementation shipped,
documentation said "Proposed"). Now SSM is caught up and the merger is
still not. The metadata mirror is not lagging as a pipeline — it is
reflecting the source rows faithfully, and the source rows disagree
about what state they are in.

The practical read: **the merger row is now the last stale surface in
Direct Sockets**, and it is stale in the direction that matters least
(the feature already works in shipped Chrome, and the tree is removing
the superseded permission policy anyway). The SSM row being caught up
means the *remaining* unknowns for Direct Sockets are not about
chromestatus at all — they are about the WPT gap and the ChromeOS-only
availability constraint.

On the developer-signal front, one field in the refreshed SSM row is
worth flagging because it did not change: the "Ready for Trial" thread
got no replies, and the mirror still renders *"Web developers: No
signals — The Ready for Trial thread got no replies."* Firefox's position
on the parent Direct Sockets API is negative
([mozilla/standards-positions#431](https://github.com/mozilla/standards-positions/issues/431)),
and Safari's WebKit position request for Isolated Web Apps is still
open without a position
([WebKit/standards-positions#184](https://github.com/WebKit/standards-positions/issues/184)).

So the shipping shape of this feature is: one vendor, one platform
(ChromeOS), one API surface (isolated web apps), zero public developer
signals, and no interop commitment from anyone else. The spec maturity
on the mirror reads *"Incubation"*.

That is not a criticism of the engineering — the crash-and-validation
work in those eight CLs is careful and the security reasoning in the
self-review is sound. It is a description of how far the ecosystem
signal has to travel before this feature means anything to anyone
outside of Blockcast's own use case. The linked samples are
`https://blockcast.network/live` and a Chrome Web Store entry, *Multicast
Gateway Beacon* — a live multicast-to-WebRTC gateway that presumably
needs source-filtered receive to avoid ingesting traffic from arbitrary
group members.

The one signal that *did* move is Chromium's own. The ship CL
(`8581753`) was commit-queued by Mike Taylor and reviewed by Reilly
Grant, and the `announcement_url` on the intent-to-ship stage points at
a blink-dev thread from November 2025
([`groups.google.com/a/chromium.org/g/blink-dev/c/vMmLZVd7rQI`](https://groups.google.com/a/chromium.org/g/blink-dev/c/vMmLZVd7rQI)).
Chromium committed to a milestone. Nobody else has, and the `finch_name`
kill switch (`SourceSpecificMulticastInDirectSockets`) is the mechanism
by which they could still back out.

## What this means for webadb.online

No code change, and no change in the direct-sockets-multicast work. SSM
is a `navigator.openUDPSocket` multicast feature. webadb's Wi-Fi
transport uses `navigator.openTCPSocket` (`lib/wifi/transport.ts`), and
the ADB protocol has no multicast in it at all — TCP, one socket, one
device. The webadb-side IWA manifest declares `local-network` and
`loopback-network` (the post-merger correct shape) and declares no
multicast policy, which remains correct: webadb should *not* request
`direct-sockets-multicast`.

Two things are worth pinning for the next time this surface comes up.

First, the practical takeaway has flipped relative to the Oct 12 post.
That post concluded: *"SSM is not in the tree, do not plan to ship
against it on any Chrome version between 151 and 154 inclusive."* That
is now wrong, and the correct version is: **SSM is enabled by default in
Chrome 158 (stable 2026-11-17), it is ChromeOS-only, and it requires an
isolated web app with the `DIRECT_SOCKETS_MULTICAST` entitlement.** If
webadb ever wanted to receive multicast from a device — which it does
not today, and ADB-over-multicast is not a plausible design — the
surface would exist from 158 onward.

Second, the more transferable lesson is about how the *documentation
surfaces* behave under a re-land. The chromestatus row for a feature
whose implementation was reverted and then re-landed three weeks before
its milestone does not go through a "deferred" or "removed" state on the
way. It sat unchanged at `updated.when: 2026-02-21` for eight months —
a date that predates the revert — and then jumped to
`2026-10-22 20:05:35` and declared the feature shipped, all in one
edit, five days before the ship CL landed and a day after it. If you
are tracking chromium feature status by polling chromestatus, that row
was never "stale in a way that suggested anything about the code"; it
was stale in a way that said nothing at all, and the only signal that
the implementation was alive was the commit stream on the tracking bug.
The Oct 12 post's methodology — read the tracking bug's commit comments,
not just the feature row — was the thing that made this catchable
before the row moved. Worth keeping.

And the asymmetry is now inverted: the merger row
(`6046077976444928`) is the last stale surface in Direct Sockets, it is
stale in the harmless direction, and the tree is actively unwinding the
permission policy it describes. Expect it to stay that way.
