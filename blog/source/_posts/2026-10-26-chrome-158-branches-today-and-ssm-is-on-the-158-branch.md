---
title: Chrome 158 branches today and SSM is on the 158 branch
date: 2026-10-26 01:00:00
tags:
  - direct-sockets
  - source-specific-multicast
  - chrome-158
  - chromestatus
  - release-process
---

Chrome 158 branches off `main` **today, 2026-10-26**. The Source-Specific
Multicast implementation that shipped in `main` on October 21 at
`refs/heads/main@{#1724238}` — five days before that cutoff — is therefore
on the 158 branch, and it goes stable on 2026-11-17. Five days is not a
comfortable margin. The same chromestatus row that said "no milestone" in
February and "Chrome 158" in October was, for eight months, describing a
feature that did not exist in any release; the re-land and the branch cut
nearly collided, and the order of those two events is the entire story of
why the tracking-bug methodology in the
[Oct 12 post](https://webadb.online/blog/2026/10/12/2026-10-12-monday-recheck-ssm-direct-sockets-revert-chromium-3076e5f5/)
was worth keeping.

This is the Monday re-check, and it is mostly about a number nobody had
written down yet.

## The schedule, from the API that actually owns it

The `https://chromestatus.com/api/v0/channels` endpoint returns the
authoritative milestone schedule. Not a mirror, not a blog post quoting a
dashboard, not a release-notes page — the same source that produces the
`desktop_first` fields the rest of this post is about. Today it says:

```text
channel  mstone  branch_point    earliest_beta  early_stable  final_beta  stable_date
stable   157     2026-10-12      2026-10-14     2026-10-21    2026-10-21 2026-11-03
beta     158     2026-10-26      2026-10-28     2026-11-04    2026-11-04 2026-11-17
dev      159     2026-11-09      2026-11-11     2026-11-18    2026-11-18 2026-12-08
```

Three things fall out of that table, and all three correct something that
was stated confidently and wrongly in the [Oct 24
post](https://webadb.online/blog/2026/10/24/2026-10-24-source-specific-multicast-for-direct-sockets-ships-in-chrome-158/).

**Chrome 157 is the current stable release, and it has been since
November 3 — no, since it will be.** The `stable` channel's `mstone` is
157 with `stable_date: 2026-11-03`, and `final_beta` was `2026-10-21`.
Chrome 156 (stable 2026-10-20) was the release before it. The Oct 24 post
described "Chrome 158 goes stable on 2026-11-17" as if that were a
distant event; it was twenty-two days away, and 157 was two weeks from
stable at the time.

**The 158 branch point is today, not a milestone abstract.** It is a
single day on a calendar. Chromium's process is that `main` is cut into a
branch head on the branch-point date, and everything on `main` at that
moment is what ships. A feature that lands on `main` on October 24 is in
158. A feature that lands on October 27 is in 159.

**The cadence changed in September and every milestone number since is
misread by people who remember the old schedule.** Chrome moved from a
four-week to a two-week release cycle with the stable release of Chrome
153 on 2026-09-08, announced in March
([developer.chrome.com](https://developer.chrome.com/blog/chrome-two-week-release):
*"Starting September 2026, Chrome will move to a two-week release cycle,
from the current four-week cycle."*). The consequence for anyone tracking
a feature by milestone number is arithmetic: every deadline that used to
mean "about six months away" now means "about three months away." The
branch point is the number that matters and it is the one that is easiest
to miss, because chromestatus only ever tells you the stable date.

## Five days of margin

Here is the whole timeline of the feature, from the commit stream on the
tracking bug
([issues.chromium.org/issues/461262401](https://issues.chromium.org/issues/461262401))
and the chromestatus row
([6208452397498368](https://chromestatus.com/feature/6208452397498368)):

```text
2026-02-21  chromestatus row last touched before the re-land
            (stage 130 desktop_first: null, is_released: false)

2026-03-07  acf38610f124  "Allow MCAST_JOIN/LEAVE_SOURCE_GROUP in network
                            service seccomp filter"   main@{#1595817}

2026-03-10  030237772913  "Add SSM support to Direct Sockets API
                            (services/network and Blink layers)"
                                                  main@{#1597329}

2026-03-11  3076e5f581b8  REVERT of 030237772913
                            Reason: "Suspicious about causing test failures
                            of ChromeDirectSocketsUdpIsolatedWebAppMulticastTest
                            .MulticastJoinGroupSSMSameGroupDifferentSources"
                                                  main@{#1597454}

2026-07-14  863435829ee0  "Add SSM support to Blink MulticastController and
                            browser integration"
                            → "This is a reland of the blink/browser portion
                               of commit 030237772913c, which was reverted in
                               3076e5f581b85."    main@{#1661529}

2026-10-19  a559af362c7f  "[Direct Sockets] Reject non-multicast groups in
                            RestrictedUDPSocket"       main@{#1721842}
            a9a57df5bd3e  "Reject invalid group addresses in network::UDPSocket"
                                                   main@{#1721866}

2026-10-20  ca9cb7f5721d  "[Direct Sockets] Reject loopback sourceAddress in
                            MulticastController"       main@{#1722769}
            6408d75ec58d  "[Direct Sockets] Count SSM joins separately from
                            ASM joins"                 main@{#1722854}
            c0b84c898438  "[Direct Sockets] Report the SSM source separately
                            in CDP events"             main@{#1722855}

2026-10-21  8774e07525eb  "[Direct Sockets] Ship SourceSpecificMulticastIn
                            DirectSockets"              main@{#1724238}
                                                   ← 5 days before the branch

2026-10-22  chromestatus row refreshed; is_released flips to true,
            stage 160 desktop_first populates to 158

2026-10-26  CHROME 158 BRANCHES TODAY
```

The single most consequential line in that table is the gap between
`2026-10-21` and `2026-10-26`. Under the old four-week cadence there
would have been roughly twenty-eight days of margin between the ship CL
and the branch cut. Under the two-week cadence there were five.

And note what the margin consisted of. The ship CL
(`8774e07525eb`) touched exactly one file:

```text
third_party/blink/renderer/platform/runtime_enabled_features.json5
  kSourceSpecificMulticastInDirectSockets  →  enabled by default
```

That is the whole commit. The eight CLs before it — the ones that
validate multicast group addresses, reject loopback source addresses,
fix the double-counted use counter, split the CDP event, and teach
DevTools to key memberships by group *and* source — are what made the
one-line flip safe. They landed between October 19 and October 21. The
last of them landed on October 21. The branch cut was five days later.

That is the actual shape of the risk. Not "will the feature work" — it
worked; the browser tests had been green since the March revert was
addressed — but "will the preparation be *in the branch*." Had the
DevTools-frontend roll (which the Chromium CL explicitly sequences
against: *"Land this CL after a devtools-frontend roll that includes it,
so DevTools never keys SSM memberships by group alone"*) landed on
October 23 instead of October 20, the feature would still have shipped,
but DevTools would have shown one merged membership instead of two.

## The CDP protocol roll nobody tracked

While checking the commit stream, one more thing turned up that the
Oct 24 post did not mention, and it is the piece that makes the feature
*observable* rather than merely *present*.

The DevTools Protocol is versioned separately from Chromium, in
[ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol),
and rolled automatically against the Chromium revision. The roll that
carried the SSM CDP shape landed on **2026-10-21**, the same day as the
ship CL:

```text
commit 71ba93da82a9   "Roll protocol to r1723477"   2026-10-21T04:41:26Z
```

Its diff, in `pdl/domains/Network.pdl`, is exactly what the Oct 20
`c0b84c898438` CL added on the browser side:

```diff
 experimental event directUDPSocketJoinedMulticastGroup
   # Multicast group address.
+  # Source address of a source-specific multicast (SSM) membership. Absent
+  # for any-source multicast (ASM) memberships.
+  optional string sourceAddress
 experimental event directUDPSocketLeftMulticastGroup
   # Multicast group address.
+  # Source address of a source-specific multicast (SSM) membership. Absent
+  # for any-source multicast (ASM) memberships.
+  optional string sourceAddress
```

And the generated TypeScript:

```ts
export interface DirectUDPSocketJoinedMulticastGroupEvent {
  /** Multicast group address. */
  ipAddress: string;
  /** Source address of a source-specific multicast (SSM) membership. Absent
   * for any-source multicast (ASM) memberships. */
  sourceAddress?: string;
}
```

This matters for a reason that is easy to miss. The browser-side CL
changed the *wire format* of an event that DevTools already consumed. If
the protocol roll had come later, DevTools would have continued to key
memberships by `IPAddress` alone — and since the browser stopped putting
`"group@source"` into that field, an app that joined one group from two
different sources would have seen one membership instead of two, and
leaving one would have dropped both. The DevTools-frontend CL that
fixes the keying was sequenced explicitly against the browser CL for
exactly this reason, and the protocol roll was sequenced against both.

Three independently-sequenced changes — browser event shape, DevTools
frontend keying, CDP protocol definition — landing inside a 48-hour
window ahead of a five-day branch margin. That is what "ship" looks like
in Chromium, and it is why the CL count in the Oct 24 post (nine CLs in
three days) was the right number to be watching.

For anyone writing tooling against Direct Sockets today, the practical
consequence is that `sourceAddress` is now a first-class field in the
CDP event and in `devtools-protocol`'s TypeScript types, available as of
`devtools-protocol` 0.0.1723477 (released 2026-10-21). Tooling that
predates it will silently see `undefined` for every SSM membership.

## The other Direct Sockets row is still frozen, and now we know what it is worth

The second row this blog has tracked every Monday — the permission-policy
merger, feature id `6046077976444928` — is unchanged in every field. The
`/api/v0/features/6046077976444928` payload today:

```text
updated.when:         2026-06-22 13:32:10.563438
updated.by:           bhaskarsharma@google.com
is_released:          false
accurate_as_of:       2026-06-22 13:32:10.563438
active_stage_id:      5101390021132288   (stage_type 160, desktop_first: 151)
intent_stage:         None
shipping_year:        2026
flag_name:            None
finch_name:           None
```

That is four months of no movement on a row whose feature shipped in
Chrome 151 — before the current stable, two milestones back. The tree
has since removed the `direct-sockets-private` permission policy the row
describes, and the CDP protocol dropped the corresponding permission-policy
enumeration value on **2026-06-13** (`ChromeDevTools/devtools-protocol`
commit `1857dd05813f`, *"Roll protocol to r1646372"*):

```diff
--- a/pdl/domains/Page.pdl
+++ b/pdl/domains/Page.pdl
@@ -117,7 +117,6 @@ domain Page
       digital-credentials-get
       direct-sockets
       direct-sockets-multicast
-      direct-sockets-private
       display-capture
```

So the row is stale, the code is unwinding the thing the row describes,
and — as of today — the row's target milestone is two releases behind
stable. Under the new two-week cadence, "151" was released on
2026-08-25. The row is describing a Chrome that has been out of date for
two months.

The symmetry with the SSM row is now exact and instructive. Both rows
were frozen for months. One of them caught up and one did not, and the
difference is not seniority or attention — it is that the SSM feature had
an active implementation team re-landing it while the merger row had
already shipped and had nobody left who cared to move a metadata field.

That is the transferable lesson, and it is a slightly uncomfortable one:
**chromestatus rows are maintained by the people who are shipping the
feature, not by the platform.** A feature that nobody is working on
today stops getting its documentation updated. The SSM row's `updated.by`
is `omar@blockcast.net` — the author of the implementation CLs, from the
company shipping the "Multicast Gateway Beacon" product. The merger
row's `updated.by` is `bhaskarsharma@google.com`, from June. When you
are polling a row to find out whether a feature is alive, the row is a
weak signal about the feature and a strong signal about *whether anyone
is currently working on it*.

## A security bug worth knowing about

While in the Direct Sockets component, one more item turned up that is not
about the happy path at all — and it is the reason to keep watching
Chromium's Direct Sockets component page rather than just the feature
rows.

[Issue 518397189](https://issues.chromium.org/issues/518397189) is a
Chrome VRP report, P2 / S2, filed 2026-05-31, marked as a vulnerability
bug and a release blocker on 2026-09-09. It is now a duplicate of
[495799116](https://issues.chromium.org/issues/495799116). The summary:

> In a Chrome Isolated Web App with Direct Sockets enabled,
> `TCPServerSocket("0.0.0.0", {localPort})` opens when local/loopback
> network permissions deny comparable Direct Sockets operations.

The reproduction, as reported on Chrome Stable 148.0.7778.179:

```text
TCPSocket to 127.0.0.1: blocked with InvalidAccessError
TCPServerSocket on 0.0.0.0: opened
local-network permission: denied
loopback-network permission: denied
```

The cause is a missing enforcement step, and it is a one-line diff in
shape. The comparable paths route through the private-network helper
before creating a socket:

```text
DirectSocketsServiceImpl::OnResolveCompleteForTCPSocket(...)
  -> RequestPrivateNetworkAccessAndCreateSocket(...)

DirectSocketsServiceImpl::OpenBoundUDPSocket(...)
  -> RequestPrivateNetworkAccessAndCreateSocket(...)
```

while the server path goes straight to the socket:

```text
DirectSocketsServiceImpl::OpenTCPServerSocket(...)
  -> network_context_->CreateTCPServerSocket(options->local_addr, ...)
```

This is the Chrome 151 permission-policy merger biting in practice. The
merger replaced one coarse `direct-sockets-private` policy with two
granular ones — `local-network` for RFC 1918 ranges and
`loopback-network` for `127.0.0.0/8` and `::1` — and the enforcement
for the *server* socket type was never wired to the new policy check.
The connected-TCP and bound-UDP paths got it; `TCPServerSocket` did not.

A related bug, [517364411](https://issues.chromium.org/issues/517364411),
covers the same class of hole from the other direction: on POSIX,
`connect(2)` and `sendto(2)` with `0.0.0.0` or `::` as the destination
get rewritten by the kernel's route lookup to the loopback interface, so
Chromium's port-restriction mechanism — which does not classify the
unspecified addresses as loopback — can be bypassed by aiming at
`0.0.0.0:30987` instead of `127.0.0.1:30987`.

Two things follow for anyone building on Direct Sockets today. First, if
you expose a `TCPServerSocket` in an IWA, do not assume the
`loopback-network` policy is protecting you on Chrome versions before
the fix lands. Second, and more generally: the Direct Sockets permission
model is now three releases old in its current shape, and the bug tracker
shows that the *server* socket path has had at least one enforcement
hole in it for the whole time. Treat the policy surface as newer and
sharper than its milestone number suggests.

## The state of the whole surface, one month in

For reference, the current state of every row on the
`chromestatus.com/features?q=Direct+Sockets` query, as of today:

| Feature | Updated | Status | Desktop |
|---|---|---|---|
| Source Specific Multicast for Direct Sockets API | 2026-10-22 | Enabled by default | 158 |
| Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network" | 2026-06-22 | Proposed | 151 |
| WebRequest.SecurityInfo in Controlled Frame | 2026-01-27 | Proposed | 145 |
| Multicast support for Direct Sockets API | 2026-01-09 | Proposed | 144 |
| Direct Sockets API in Shared/Service workers | 2025-01-31 | Proposed | — |
| verifyTLSServerCertificate for IWA | 2025-02-12 | Proposed | — |
| Direct Sockets API in Chrome Apps | 2024-04-12 | Enabled by default | 125 |
| Direct Sockets API | 2025-01-14 | Enabled by default | 131 |

The `stage 130` entry on the SSM row still reads `desktop_first: 152` —
the "intent to ship" slot, carrying the
[November 2025 intent-to-ship thread](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/692dffe2.050a0220.17ec37.0673.GAE%40google.com)
— while the active stage reads 158. That is not a contradiction, it is
two different slots that were populated by two different people at two
different times: 152 was the target before the March revert, 158 is the
target after. The chromestatus stage model has no "deferred from 152 to
158" representation, so it keeps both.

The developer-signal picture is unchanged and worth restating once a
year: Firefox's position on the parent Direct Sockets API is negative
([mozilla/standards-positions#431](https://github.com/mozilla/standards-positions/issues/431)),
Safari's WebKit position request for Isolated Web Apps is still open
without a position
([WebKit/standards-positions#184](https://github.com/WebKit/standards-positions/issues/184)),
and the "Ready for Trial" thread on the SSM row got no replies at all.
One vendor, one platform (ChromeOS), one API surface (isolated web
apps), zero public developer signal. The spec maturity on the mirror
still reads "Incubation".

## What this means for webadb.online

No code change to webadb, and no change to the Direct Sockets work.

SSM is a `navigator.openUDPSocket` multicast feature. webadb's Wi-Fi
transport uses `navigator.openTCPSocket` (`lib/wifi/transport.ts`), and
the ADB protocol has no multicast in it at all — TCP, one socket, one
device. The webadb-side IWA manifest declares `local-network` and
`loopback-network` (the post-merger correct shape) and declares no
multicast policy, which remains correct: webadb should *not* request
`direct-sockets-multicast`.

But two things are worth pinning down, because the calendar just got
twice as fast and both of them are about how we track milestones.

First, the schedule change is the single biggest practical difference
for anyone reading this blog's back catalogue. Every "Chrome N ships
this" claim in every post from the [Sep 21
one](https://webadb.online/blog/2026/09/21/2026-09-21-monday-recheck-direct-sockets-chrome-151-shipped-but-policy-merger-entry-still-stale/)
onward needs re-derivation against the branch point, not the stable
date. Chrome 158 branches today and is stable 2026-11-17; Chrome 159
branches 2026-11-09 and is stable 2026-12-08. If you are building
against a Direct Sockets milestone, the number to write down is the
branch date, because that is the day the code stops moving.

Second, the Direct Sockets API in general — not SSM — now has its own
release-train clock that webadb's Wi-Fi transport is on. The core
Direct Sockets API row has said `is_released: true`, `desktop_first:
131` since January 2025, and the Chrome Apps variant since 2024. That
has not changed in twenty months. What *has* changed is everything
around it: the permission policy was merged in 151, the permission-policy
enumeration was removed from the CDP protocol in June, the multicast
surface gained SSM in 158, and the server-socket path has an open
enforcement bug against the new policy model. webadb's Wi-Fi transport
uses `openTCPSocket` to connect *out* to a device on the LAN — the
connected path, which is the one that got the policy check right. But
"the connected path is the one that got the check right" is a
statement about a specific bug in a specific release, and the release
cadence is now fast enough that this class of thing changes underneath
you.

The practical advice, unchanged in shape but with a shorter fuse: if you
use webadb's Wi-Fi transport, pin the Chrome version you tested against
and re-test on each milestone boundary rather than on each stable
release. Two weeks is a short enough window that "we tested on stable"
is no longer a statement that means anything.

And one small note on method, because this post's central fact — that
SSM was in 158 — was not derivable from any single metadata source.
The chromestatus row gave 158; the *branch point* gave today; the
commit stream gave the five-day margin; the DevTools protocol repo
gave the separate protocol rollout. None of those three told the others.
The tracking-bug comment stream remains the only surface that showed the
sequence of the nine CLs, which is the only thing that made the
five-day margin legible at all. Read the bug, not the row. The row just
tells you where the feature ended up.
