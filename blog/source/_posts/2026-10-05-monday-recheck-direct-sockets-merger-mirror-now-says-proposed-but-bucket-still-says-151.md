---
title: Monday re-check — Direct Sockets policy merger mirror has split in two; chromestatuslite now disagrees with itself
date: 2026-10-05 01:00:00
tags:
  - direct-sockets
  - chromestatus
  - chromestatuslite
  - chrome-151
  - chrome-155
  - iwa
  - monday-recheck
  - wifi
  - source-specific-multicast
  - blink-dev
---

Last two Mondays
([`2026-09-21`](https://webadb.online/blog/2026/09/21/monday-recheck-direct-sockets-chrome-151-shipped-but-policy-merger-entry-still-stale/)
and
[`2026-09-28`](https://webadb.online/blog/2026/09/28/monday-recheck-direct-sockets-chromestatus-still-stale-across-the-board/))
flagged a one-line asymmetry on the
[*Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network"*](https://chromestatus.com/feature/6046077976444928)
row on `chromestatus.com`: the underlying JSON still had
`updated.when: "2026-06-22 13:32:10.563438"` and `is_released: false`,
while the `chromestatuslite.com` mirror's Chrome 151 page enumerated
the feature under *Enabled by default in 151*. Asymmetry between two
halves of the same pipeline.

This Monday the JSON row is **byte-identical to the Sep 28 snapshot** —
`updated.when` and `is_released` unchanged, the channel calendar hasn't
moved at all (stable 155 still targeting 2026-10-06, beta 156, dev 157,
identical to the values Sep 28 read). What's changed is that the
`chromestatuslite` mirror's own per-feature page now reads
`Status: Proposed (Chrome Proposed)` with a freshly-rendered
**Motivation** blockquote, while the mirror's Chrome 151 page still
slots the feature under *Enabled by default in 151*. The mirror now
disagrees with itself. That is the new finding — and it's worth pinning
down on the record because it changes which endpoint you should treat
as canonical, and it changes what *Enabled by default in 151* on the
mirror's Chrome-version bucket pages actually means.

There is also one new piece of upstream activity to talk about: a
**Source-Specific Multicast for Direct Sockets API** blink-dev thread
went to *Ready for Developer Testing* on 2026-02-20, eight months into
the chromestatus row's freeze. That breaks the "nothing has moved
anywhere on Direct Sockets" framing the prior two Monday re-checks
were using, even if the chromestatus pipeline itself still shows no
movement.

## What changed in the mirror's per-feature page

On Sep 28 the mirror's feature page rendered as a bare title plus a
one-paragraph summary plus *View on chromestatus.com*. Today's mirror
page renders the same content but inserts four new metadata blocks
above the summary:

```
Category   Isolated Web Apps-specific API
Type       New or changed feature
Status     Proposed (Chrome Proposed)
Intent stage None
```

— followed by a `<h2>Motivation</h2>` block I am going to quote in full
because it is the only new piece of written explanation on the page
that wasn't there on Sep 28:

> *This change introduces essential user consent before granting
> potentially sensitive network access to IWAs, aligning with the
> principle of least privilege. The granular manifest policies ensure
> that apps only request the specific network access they need.*

— then the existing *Standards & signals* block (spec link to
`wicg.github.io/direct-sockets/#permissions-policy-pna`, Firefox /
Safari both *No signal*, *No signals* from web developers) — then the
same *View on chromestatus.com* footer as before.

The Status block is the contradiction. The mirror's per-feature page
says the feature is *Proposed* (intent stage `None`, value 0, which in
the chromestatus pipeline is the "no intent yet" pre-stage); the same
mirror's Chrome 151 bucket page still lists the feature under *Enabled
by default in 151* alongside 17 other entries in the `Enabled (18)`
group. Two endpoints of the same data source, two different
verdicts. On Sep 28 they both said *Enabled*; today one says *Enabled*
and the other says *Proposed*.

## What the underlying chromestatus JSON actually says

The JSON has not moved. Same `curl -sL --compressed
'https://chromestatus.com/api/v0/features/6046077976444928'` I quoted
in the Sep 28 post gives the same two fields that matter:

```json
"updated": {"by": "bhaskarsharma@google.com",
            "when": "2026-06-22 13:32:10.563438"},
"accurate_as_of": "2026-06-22 13:32:10.563438",
"is_released": false,
"browsers": {"chrome": {"status": {"text": "Proposed", "val": 2,
                                   "milestone_str": "Proposed"},
                        "desktop": 151, ...}},
```

`motivation` has been there since 2026-04-09 — the
`created.when` of the row — so the new text on the mirror page is not
a chromestatus edit. It's the chromestatuslite render layer either
finally pulling fields it had been ignoring, or being rewritten to
surface more of the chromestatus schema. The mirror's commit history
is not exposed in the page itself; I can only observe that on
2026-09-28 the per-feature page did not render a Motivation block,
and on 2026-10-05 it does.

The `intent_stage_int: 0` / `intent_stage: "None"` pair is also
informative. The chromestatus intent-stage values are
`None(0) → Proposed(7) → In-Developer-Trial(110) →
Origin-Trial(120) → In-Review(130) → Ship-Ready(140) →
Enabled-by-Default(150) → Removed(160)`, with
`is_released` set to `true` only after the *Enabled-by-Default* stage
gets a `desktop_first` milestone value. The merger row's
`intent_stage_int` is `0`, the latest stage's `stage_type` is `160`
(*Enabled-by-Default*), and the same stage has `desktop_first: 151`
and `android_first: null` and `ios_first: null` — i.e. *all the data
needed to flip `is_released` to `true` is already present in the row*,
and nobody has flipped the bit. That is the same situation as Sep 28,
same as Sep 21, and at this point the staleness is more than ten
weeks old (`accurate_as_of` 2026-06-22 → today 2026-10-05 = 75 days).
For comparison, when the Direct Sockets API itself shipped in Chrome
125 the same gap was about four weeks; this one is on track to
double that without breaking.

## The channel calendar is unchanged too

For completeness, the channels endpoint
(`https://chromestatus.com/api/v0/channels`) returns the same
mstone values as the Sep 28 post:

```
stable: mstone=155, stable_date=2026-10-06
beta:   mstone=156, stable_date=2026-10-20
dev:    mstone=157, stable_date=2026-11-03
```

Chrome 155 has not yet gone to stable — that happens Tuesday
2026-10-06. Today (2026-10-05 UTC) the most recent stable build is
still Chrome 154, which matches the dev → beta → stable four-week
cadence. So if anything, the *binary* side of the original Sep 21
observation ("the merger shipped in stable around M151") is now even
*more* true: the merger has been in stable Chrome for three milestone
releases (151 → 152 → 153 → 154), totalling **fourteen weeks** since
Chrome 151 went stable on 2026-07-08 per
[developer.chrome.com/release-notes/151](https://developer.chrome.com/release-notes/151).
The chromestatus row has been frozen the entire time.

## Source-Specific Multicast went to Ready for Developer Testing

The chromestatus row isn't the only Direct Sockets surface on the
internet. On 2026-02-20 a blink-dev thread titled
[*Ready for Developer Testing: Source Specific Multicast for Direct Sockets API*](https://groups.google.com/a/chromium.org/g/blink-dev/c/vMmLZVd7rQI)
went out to the public mailing list. The proposal adds
Source-Specific Multicast (SSM, RFC 4607) on top of the existing
Any-Source Multicast (ASM) support in Direct Sockets — i.e. the
ability for an IWA to join a multicast group with `(source, group)`
filtering instead of accepting every packet sent to the group.

The relevant extract from the thread:

> Adds Source-Specific Multicast (SSM) support to the Direct Sockets
> API, allowing Isolated Web Apps to optionally specify a source
> address when joining multicast groups to receive UDP packets only
> from that source. The Direct Sockets API currently supports
> Any-Source Multicast (ASM), which receives packets from any source
> sending to the multicast group. SSM is essential to using multicast
> outside of private networks, simplifying packet routing, and
> filtering traffic at the network level by source address, preventing
> spoofing and denial of service attacks.

The status text on the blink-dev thread is *Ready for Developer
Testing*, which sits earlier in the pipeline than an Origin Trial and
ships behind a flag —
`chrome://flags#source-specific-multicast-in-direct-sockets`, Finch
feature name `SourceSpecificMulticastInDirectSockets`, tracking bug
[issues.chromium.org/issues/461262401](https://issues.chromium.org/issues/461262401).
It also has a non-standard "Will this feature be supported on all six
Blink platforms" answer — *"No: Windows, Mac, Linux, ChromeOS"*, with
the same `WPT cannot test this` issue (`web-platform-tests/wpt#55304`)
that blocked the existing Direct Sockets multicast support from being
in the wpt.fyi dashboard. That WPT gap is the main reason Direct
Sockets entries don't show up in wpt.fyi at all, even after the API
itself shipped to stable — and it looks like the SSM extension has
inherited the same gap rather than closing it.

This is upstream-only news: nothing has landed in a stable Chrome
binary yet, and there is no corresponding row on chromestatus.com
itself (a search for `direct-sockets` in `category=22` returns the
same eight rows as the Sep 28 post enumerated, no SSM row yet). The
blink-dev thread is the source-of-truth; the chromestatus entry for
the same proposal has not been created yet — when it is, that will be
the next round of staleness-tracking for the same Friday pattern.

## The chromestatus vs chromestatuslite divergence is now the actionable bit

Practical consequence for anyone (us included) who uses
`chromestatuslite.com` as a faster read of
`chromestatus.com`:

1. The mirror's *per-feature page* is no longer a safe stand-in for
   the chromestatus API. Use the API directly when the question is
   *is this feature in a stable Chrome binary?* (check `desktop`,
   `android`, `webview`, `ios` first fields, then `is_released` as
   the bit the chromestatus UI uses to render the green ✓). The
   mirror's per-feature page now displays the row's `motivation` and
   its `intent_stage_int` value (rendered as *Proposed* / *None*),
   neither of which is a shipping signal — both can be populated
   before the feature has touched any Chrome binary.
2. The mirror's *bucket-by-version page* (`?version=N`) still works
   as a shipping signal — it's the bucket that *Enabled (18) in 151*
   came from, and that bucket is the same source-of-truth the chromestatus
   *Release notes* column pulls from on
   `developer.chrome.com/release-notes/151`. So if you want to know
   *what shipped in Chrome 151*, use the mirror's bucket page; if you
   want to know *what state a specific feature is currently in*, use
   the chromestatus API and ignore the mirror's per-feature page.
3. The bucket page and the per-feature page now disagree for at
   least one entry (the merger). For now that's a single entry; it
   would be worth checking whether the same divergence is present
   on other long-stale rows the Sep 28 post enumerated — a future
   re-check item.

## What this means for webadb.online

No code change to webadb. The merger shipped in Chrome 151 and has
been in stable for fourteen weeks; webadb's Wi-Fi transport
(`lib/wifi/transport.ts`) was written against the spec at
[wicg.github.io/direct-sockets](https://wicg.github.io/direct-sockets/)
and does not declare `permissions_policy.direct-sockets-private` in
the IWA manifest — instead it declares both `local-network` and
`loopback-network`, which is the post-merger correct shape. So the
shipped merger is what the manifest already assumes.

The chromestatus vs chromestatuslite divergence is mostly an
upstream-process story that we are tracking because we cite chromestatus
in our blog posts (e.g. the Sep 21, Sep 28, and Sep 14 weekly roundups
all link to chromestatus feature IDs). For accuracy in future
references, the rule is now: bucket pages for shipping signal, API
JSON for pipeline state. The mirror's per-feature page is no longer
the canonical read for either question.

The Source-Specific Multicast proposal is also no-impact-for-now on
webadb: webadb's Wi-Fi transport uses TCP, not UDP multicast, and
our target use case (an ADB-over-Wi-Fi transport for devices that
have already been put into `adb tcpip` mode) doesn't need ASM, let
alone SSM. If a future feature wants mDNS-style local-device
discovery, the SSM feature would be the right primitive to build
against — but that's a v-next feature, not this week's. No
follow-up needed today.
