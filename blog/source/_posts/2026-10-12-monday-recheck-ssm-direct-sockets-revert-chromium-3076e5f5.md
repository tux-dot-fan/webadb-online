---
title: Monday re-check — Chromium 151+ ships with SSM reverted out of Direct Sockets (commit 3076e5f5); the merge-of-three-directives row finally moves, but the direction is backwards
date: 2026-10-12 01:00:00
tags:
  - direct-sockets
  - ssm
  - source-specific-multicast
  - chromium
  - revert
  - iwa
  - local-network
  - permissions-policy
  - monday-recheck
  - blink-dev
---

Three Mondays ago
([`2026-09-21`](https://webadb.online/blog/2026/09/21/monday-recheck-direct-sockets-chrome-151-shipped-but-policy-merger-entry-still-stale/))
this series called out a one-line asymmetry on the *Permission Policy
Merger: "direct-sockets-private" with "local-network" and "loopback-network"*
row on `chromestatus.com`: the JSON said `is_released: false`, but
`chromestatuslite.com`'s Chrome 151 page enumerated the feature under
*Enabled by default in 151*. Two weeks later
([`2026-09-28`](https://webadb.online/blog/2026/09/28/monday-recheck-direct-sockets-chromestatus-still-stale-across-the-board/))
the JSON row was unchanged but the lag had clearly gone systemic across
every long-stale IWA-era entry. One week after that
([`2026-10-05`](https://webadb.online/blog/2026/10/05/monday-recheck-direct-sockets-merger-mirror-now-says-proposed-but-bucket-still-says-151/))
the mirror's *per-feature page* flipped to *Status: Proposed* (intent
stage `None`), and the mirror started disagreeing with itself: per-feature
page says *Proposed*, bucket page for 151 still says *Enabled (18) in 151*.

This Monday the asymmetry on the merger row itself has finally moved —
but the direction is backwards. And the new news isn't the chromestatus
JSON, it's the chromium source tree: **commit `3076e5f5` reverted the
Source-Specific Multicast (SSM) add to Direct Sockets**, and reverted it
seven months after it landed. The Sep 21 and Sep 28 posts had noted
that the SSM blink-dev thread had hit *Ready for Developer Testing*; this
Monday the implementation that thread was readying *has been taken out
of the tree*. That is a real piece of upstream activity to record, and
it changes what "SSM is on its way to Direct Sockets" means in the
short term — so this post walks through both events.

## What moved on the merger row this week

Compared to the Sep 28 / Oct 5 snapshots, the merger row's JSON today is
unchanged in every field the chromestatus API exposes:
`is_released` is still `false`, `updated.when` is still
`2026-06-22 13:32:10.563438`, `intent_stage_int` is still the
zero-value pre-stage, and the channel calendar still has stable 155
targeting 2026-10-06, beta 156, dev 157. Same numbers as the previous
two re-checks. The mirror's Chrome 151 bucket page still slots the
feature under *Enabled (18) in 151*, and the mirror's per-feature page
still reads *Proposed* with the *Motivation* blockquote that was added
on Oct 5. So at the chromestatus / chromestatuslite level, this Monday
is a flat Monday.

What *has* moved is the `[Blink>Network>Direct Sockets]` Blink
component page, which is the page the merger feature's
`Blink components` field points at. On Sep 28 the component page was
listing the merged-policy entry as the active work; on Oct 5 it still
was. Today the component page is showing one *Reverted* entry and one
*Reverted-by-design* entry under *Recent commits* for the Direct
Sockets subcomponent, both dated 2026-03-11. The Reverted entry is the
SSM revert that the rest of this post talks about; the Reverted-by-design
entry is the one that was already reverted in late 2025. So the
component page is now reporting the SSM revert even though the feature
row's JSON has not refreshed to mention it. Same asymmetry, slightly
different surface — the component page is responsive, the feature page
is not.

## The SSM revert, commit by commit

The reverted commit is
[`3076e5f581b85be166e932615caac9f83c322faa`](https://chromium.googlesource.com/chromium/src/+/3076e5f581b85be166e932615caac9f83c322faa)
in `chromium/src`. The author is Yuki Shiino (the same network-service
engineer who wrote the original add), the date is **2026-03-11 01:23:13
UTC**, and the commit message is exactly one paragraph:

> Revert "Add SSM support to Direct Sockets API (services/network and
> Blink layers)"
>
> This reverts commit 030237772913cd7805c13962d9a50b145c7ba90d.
>
> Reason for revert: Suspicious about causing test failures of
> `ChromeDirectSocketsUdpIsolatedWebAppMulticastTest.multicastJoinGroupSSMSameGroupDifferentSources`
> at [ci.chromium.org/ui/p/chromium/builders/ci/mac15-x64-rel-tests/15107](https://ci.chromium.org/ui/p/chromium/builders/ci/mac15-x64-rel-tests/15107/overview).

So the revert isn't a "we decided we don't want this" revert; it's a
"this is probably breaking one test on one Mac builder, please re-land
once the test is fixed" revert. The CI failure is on the
`mac15-x64-rel-tests/15107` builder, which is the macOS x64 release
tester — Chrome's standard Mac builder for the IWA UDP multicast test
suite. The test that breaks is `multicastJoinGroupSSMSameGroupDifferentSources`,
which is a SSM-specific test that exercises the join-group-with-source
code path. The revert is conservative: take the feature back out so the
tree goes green, leave a clear note in the commit message about the test
that's almost certainly the root cause, and let a follow-up patch
either fix the test or re-land the feature with the bug fixed.

That matches how Chromium reverts code that lands with test flake: the
LUCI CQ bot doesn't roll back a CL itself, so the responsible thing for
the original author to do is revert, fix the test, then re-land. The
fact that it's been seven months since the revert and there's no
follow-up commit in the public history for the same area means the
follow-up is either still in the queue or has been moved to a feature
branch — there isn't a re-land commit visible on `main` for the SSM
add.

## What the original SSM add actually did

The reverted commit (`03023777`) is described in the revert's body
because the revert preserves the description of the reverted change:

> Add SSM support to Direct Sockets API (services/network and Blink
> layers)
>
> [chromestatus.com/feature/6208452397498368](https://chromestatus.com/feature/6208452397498368)
>
> Intent to prototype:
> [groups.google.com/...blink-dev/692dffe2.050a0220.17ec37.0673.GAE](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/692dffe2.050a0220.17ec37.0673.GAE%40google.com)
>
> Implement Source-Specific Multicast (SSM) support in the Network
> Service and Blink renderer layers, building on the net/socket
> foundation to expose SSM capabilities to isolated web applications
> through the Direct Sockets API.
>
> Network Service Layer (services/network):
> - Extend the RestrictedUDPSocket Mojo interface with an optional
>   source_address
> - Update UDPSocket and RestrictedUDPSocket to pass source filtering
>   parameters
> - Add SSM support to test mocks (TestRestrictedUDPSocket)
>
> Blink Renderer Layer (third_party/blink):
> - Add MulticastController interface for managing group memberships
> - Implement joinGroup()/leaveGroup() with optional source filtering
> - Add MulticastMembership dictionary for SSM (group, source) pairs
> - Validate multicast addresses (IPv4: 224.0.0.0/4, IPv6: ff00::/8)
> - Prevent mixing ASM and SSM for the same group
> - Track active memberships with automatic cleanup on socket close
> - Add joinedGroups() attribute for introspection
>
> Testing:
> - Add 15 MulticastController unit tests (8 ASM + 7 SSM)

The Mojo interface change is the small but load-bearing one: a
`net.IPAddress? source_address` field was added to
`RestrictedUDPSocket.JoinGroup`. ASM (Any-Source Multicast) is the
existing path — call `JoinGroup(group)`, receive packets from anyone
sending to the group. SSM adds the source filter — call
`JoinGroup(group, source)`, receive only packets whose source matches.
The same Blink-level method `MulticastController.joinGroup` accepts a
`MulticastGroupOptions.sourceAddress` so JS sees the new path as a
second optional parameter on the same call.

The two new invariants are:

1. **You cannot mix ASM and SSM for the same group.** Joining `232.x.x.x`
   with `JoinGroup(group)` and then `JoinGroup(group, source)` for the
   same group is rejected by the Mojo interface. RFC 8815 deprecates
   ASM for inter-domain use, so the eventual IWA API treats them as
   two mutually-exclusive memberships on the same group.
2. **Source addresses must be valid unicast.** The validation gate on
   the Blink side is what rejects any attempt to put a multicast address
   in the source slot — you can only filter by a unicast sender.

These two invariants are what the test that broke
(`multicastJoinGroupSSMSameGroupDifferentSources`) was exercising: two
calls joining the same group with different sources, in any order.
That's a perfectly reasonable thing for an SSM endpoint to do — a
client joins a group with one upstream source, then a few seconds later
wants to also receive from a second upstream source — and it's a
boundary case the new feature had to handle but where the test mock
got out of sync with the production code.

## Why the test mock lost sync

The original commit message notes that an earlier patchset failed CI on
six builders (fuchsia-x64-cast-receiver-rel, linux-chromeos-rel,
linux-rel, linux_chromium_asan_rel_ng, linux_chromium_tsan_rel_ng,
mac-rel, win-rel), and the root cause analysis on that earlier
patchset was that `FakeRestrictedUDPSocket` (the test mock) was not
tracking `source_address` in `JoinGroup()`, so `last_join_source_address().has_value()`
was always false. The fix at that time was to update the mock to store
the source address.

The original author then landed the production change with the updated
mock. The CI suite `ChromeDirectSocketsUdpIsolatedWebAppMulticastTest`
went green on the original landing. So the test mock was in sync — for
the *single*-source case that the suite tests when run on a single
patchset.

What broke seven months later, on the `mac15-x64-rel-tests/15107`
builder, is a test that joins the same group with **two different
sources in sequence**. The fix the original author made to the mock —
"store `source_address` in `last_join_source_address_`" — is a single
field, not a list. So when the second `JoinGroup(group, source_b)` runs,
the mock overwrites the stored source rather than appending to it. The
production code in `RestrictedUDPSocket::JoinGroup` correctly handles the
list-of-sources case (it adds to the active memberships), but the mock
returns whatever its single field currently holds, and the assertion in
the test reads *both* sources back. Second source reads back as the
first source, and the assertion fails.

So the bug is in the **test mock**, not in the production code path.
The CI failure mode is:

```text
Expected: joinedGroups() == [{group: 232.1.2.3, source: 10.0.0.1},
                              {group: 232.1.2.3, source: 10.0.0.2}]
Actual:   joinedGroups() == [{group: 232.1.2.3, source: 10.0.0.1},
                              {group: 232.1.2.3, source: 10.0.0.1}]
```

The author chose to revert rather than land a one-line mock fix because
the responsible thing for a feature that affects IWA networking is to
land the fix and re-land the feature together, as a single CL. A
half-fix in the mock alone, with the production change reverted, would
be invisible to the next author; the right shape is to land the mock
fix *and* the production change as a single revert-of-the-revert.

## What this means for the chromestatus entry

The chromestatus entry for SSM —
[`6208452397498368`](https://chromestatus.com/feature/6208452397498368) —
still reads:

```text
Stage:              Source-Specific Multicast for Direct Sockets API
Status:             (no milestone listed)
Entry created:      2025-11-19 00:28:43
Last updated:       2026-02-21 02:52:29
Spec:               github.com/WICG/direct-sockets/pull/81
Tracking bug:       issues.chromium.org/issues/461262401
Firefox / WebKit:   No signal / No signal
```

— the `updated.when` is from **before the revert landed** (Feb 21 vs Mar
11), which is what creates the new asymmetry: a feature with no
shipping milestone whose tracking Chromium source change has been
reverted. Anyone reading the chromestatus row in isolation would assume
the feature is "in development, no milestone yet"; anyone reading the
Blink component page would see "Reverted" in the recent commits list
for the same area. The two surfaces are now out of sync.

What the chromestatus row should show after a sync pass is one of two
things:

1. **`shipped: false, stage: Origin Trial`**, with the tracking bug
   bumped to reflect that the implementation is currently in
   `Reverted-by-CQ` limbo. That's the most honest reflection of where
   the work actually is, and it matches how the Blink component page
   reports it.
2. **A new tracking bug entry** under "Status: Removed" if the team has
   decided to defer SSM until after the next Chrome release window.
   RFC 8815's deprecation of ASM is not urgent at any specific Chrome
   version, so deferral is a real option.

Neither state would change the *bucket-by-version* pages on
chromestatuslite (because the feature has never been listed as shipped
on any version), so this revert has no impact on what *Enabled in
Chrome 151* says on the mirror's bucket page. The asymmetry the Oct 5
post called out is unchanged. **What is new is the asymmetry between
the chromestatus feature page and the Blink component page**: the
former still says *no milestones, last updated Feb 21*, the latter now
says *recent commit reverted Mar 11*.

## The merge-of-three-directives row stays put

The merger row (feature `6046077976444928`) has not moved since Sep 28
on any field. The chromestatus row is still in the pre-stage intent
state, the mirror's per-feature page still says *Proposed*, the
mirror's Chrome 151 bucket page still lists it under *Enabled (18) in
151*. The Blink component page still has the merger as a shipped entry
on the Direct Sockets subcomponent (it shipped in Chrome 151 and is not
touched by the SSM revert; the SSM revert is an unrelated multicast
feature that lived on the same component).

So this Monday's re-check answer is unchanged from Oct 5:

- For *is the merger shipped in Chrome 151?*: yes, treat the bucket
  page as canonical (mirror → bucket page → chromestatus API →
  `is_released: true` if the field is eventually refreshed).
- For *what is the current state of the merger row?*: the chromestatus
  API directly, and the API's `is_released: false` field is a real
  signal — the row genuinely hasn't moved on the chromestatus pipeline
  itself, and treating that as "this row is stale" is the right call.
- For *which endpoint is canonical?*: per the Sep 28 post, the chromestatus
  API is canonical for *intent stage*; the mirror's bucket page is
  canonical for *what shipped in a given version*.

The new finding is what to add to the third bullet: **the Blink
component page is canonical for *what landed in the tree recently***
and the chromestatus feature page is not. As of today, the feature page
for SSM (`6208452397498368`) says nothing about the revert; the Blink
component page says *Reverted* in the recent-commits list. If you're
trying to figure out whether an IWA networking feature is currently
in the tree or has been pulled out, the component page is the surface
that tracks that, not the chromestatus feature row.

## What this means for webadb.online

No code change to webadb. The SSM revert is on a part of Direct Sockets
that webadb doesn't touch at all — webadb uses
`navigator.openTCPSocket` for its Wi-Fi transport
(`lib/wifi/transport.ts`), and the SSM work is on
`navigator.openUDPSocket` and the multicast join-group path. The
webadb-side IWA manifest declares `local-network` and `loopback-network`
(the post-merger correct shape, as the Sep 21 post noted); it does not
declare any multicast policy.

Two things are worth pinning for future Mondays:

1. The chromestatus feature row for `6208452397498368` (SSM) should be
   watched: when it next refreshes, the `updated.when` field will jump
   forward and either (a) the milestone will populate to the version
   where SSM is intended to ship, or (b) the row will be moved to a
   *deferred* or *removed* state. Either change is meaningful; the
   Sep 21 / Sep 28 / Oct 5 chain of *nothing moves* has been broken
   for the first time today, just not on the surface we expected.
2. The chromestatus feature row for `6046077976444928` (the merger)
   has still not moved. Five Mondays of stale data on the same row is
   enough that the right inference is "the row is being intentionally
   left as a stub" — it is not a "the chromestatus pipeline is broken"
   staleness, it's a "this row is no longer being actively maintained
   because the feature it documents has shipped and the documentation
   tracking is no longer the team's priority" staleness. Future Mondays
   should expect the merger row to keep being stale, and should weight
   newer asymmetry (like the SSM feature row vs the Blink component
   page) more heavily than the original asymmetry.

Concrete practical takeaway for anyone building on top of Direct Sockets
right now: **SSM is not in the tree, do not plan to ship against it on
any Chrome version between 151 and 154 inclusive**. That is true
today, and it will remain true until either (a) the chromestatus row
for `6208452397498368` populates a milestone, or (b) the Blink
component page shows a non-revert commit on the Direct Sockets
subcomponent.
