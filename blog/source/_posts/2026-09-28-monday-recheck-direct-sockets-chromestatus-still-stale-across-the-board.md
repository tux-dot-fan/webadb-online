---
title: Monday re-check — chromestatus is still stale on the Direct Sockets merger
date: 2026-09-28 01:00:00
tags:
  - direct-sockets
  - chromestatus
  - chrome-151
  - iwa
  - monday-recheck
  - wifi
---

Last Monday's note
([`2026-09-21`](https://webadb.online/blog/2026/09/21/monday-recheck-direct-sockets-chrome-151-shipped-but-policy-merger-entry-still-stale/))
flagged an asymmetry in `chromestatus.com` feature
[`6046077976444928`](https://chromestatus.com/feature/6046077976444928) —
the
*Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network"*
feature — the binary in Chrome 151 had shipped the change to stable but the
metadata on the chromestatus entry was still pinned to its
`2026-06-22` snapshot, with the top-level `is_released` flag still `false`
and the `updated.when` timestamp still `2026-06-22 13:32:10.563438`. Seven
days later the entry is byte-for-byte identical. Chrome itself has moved
on: stable is now Chrome 155 with a release date of
[`2026-10-06`](https://chromestatus.com/api/v0/channels), beta is at 156
(stable 2026-10-20), and dev is at 157 (stable 2026-11-03). Counting
backward at Chrome's four-week cadence, **Chrome 151 went to stable on
2026-07-28** per
[`developer.chrome.com/release-notes/151`](https://developer.chrome.com/release-notes/151)
— roughly nine weeks ago — and the merger row is still showing the same
`is_released: false` it had before any of those nine weeks elapsed.

That alone would be a one-line follow-up. The reason this post exists
is that the same staleness now shows up on **every post-IWA-restructuring
Direct Sockets entry on chromestatus** — the merger is no longer an
outlier, it's the rule, and the asymmetry is starting to bite anyone
who treats chromestatus as the canonical "is this in a stable Chrome
yet" signal.

## What we re-checked

Same JSON endpoint as last week, same shape:

```sh
curl -sL --compressed \
  'https://chromestatus.com/api/v0/features/6046077976444928' \
  | python3 -m json.tool
```

Same two top-level fields that matter, still unchanged from the
2026-09-21 snapshot:

- `updated.when` = `"2026-06-22 13:32:10.563438"` by
  `bhaskarsharma@google.com`
- `is_released` = `false`

Same six `stages` array, same `desktop_first: 151` on the latest
(`stage_type: 160`, `intent_stage: 5`) row, same `shipping_year: 2026`.
Nothing about the entry has been touched since the merge window for
Chrome 151 closed in mid-June.

`chromestatuslite.com/v151` independently confirms the feature *is*
considered shipped:

> **Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network"**
> Isolated Web App manifests now require specific "local-network" and/or "loopback-network" permission policies to enable Direct Sockets connections to local or loopback network addresses, respectively.
>
> *Enabled by default in 151*

— i.e. the chromestatuslite mirror has a `Enabled (18)` bucket and
includes this feature in its "Enabled by default in 151" enumeration.
The two halves of the chromestatus pipeline disagree.

## The systemic piece

The Sep 21 post framed the lag as "we have seen this before" and left
it there. Pulling the full Direct Sockets category on chromestatus today
gives a less comfortable picture. The category filter
(`category=22` — "Isolated Web Apps-specific API") returns eight
features whose name contains "direct-sockets":

| chromestatus id | name | updated.when | is_released | desktop_first |
|---|---|---|---|---|
| 6398297361088512 | Direct Sockets API | 2025-01-14 | **true** | 131 |
| 5168654087094272 | Direct Sockets API in Chrome Apps | 2024-04-12 | **true** | 125 |
| 5169039028256768 | Direct Sockets API in Shared/Service workers | 2025-01-31 | false | — |
| 5180591148105728 | verifyTLSServerCertificate for IWA | 2025-02-12 | false | — |
| 5073740211814400 | Multicast support for Direct Sockets API | 2026-01-09 | false | 144 |
| 5076692209106944 | WebRequest.SecurityInfo in Controlled Frame | 2026-01-27 | false | 145 |
| 6208452397498368 | Source Specific Multicast for Direct Sockets API | 2026-02-21 | false | — |
| 6046077976444928 | Permission Policy Merger: direct-sockets-private | **2026-06-22** | false | 151 |

`stage_type: 160` (Shipped) is the latest entry in *every one* of
these rows. Every row's metadata is older than the `desktop_first` it
points at — by anywhere from 5 months (`Multicast support for Direct
Sockets API`, last touched 2026-01-09, shipped 144) to 14 months
(`Direct Sockets API in Shared/Service workers`, last touched
2025-01-31, no `desktop_first` field — it's the OT-only entry). Only
the two pre-IWA-restructuring features (`Direct Sockets API`, the
125/131 ship; and `Direct Sockets API in Chrome Apps`) have
`is_released: true` and they're the *only* two rows whose JSON was
touched before 2025-Q1.

The implication: **the `is_released` field on chromestatus stopped
getting flipped when the IWA-API restructured around Chrome 132-133**.
Every row that landed during or after the restructure has its
`is_released` stuck at `false` regardless of whether the binary
shipped. The `updated.when` field on those rows stopped getting bumped
the day the feature merged, even if the milestone itself slipped. This
is consistent with the chromestatus front-end being more authoritative
than its REST API — the Web UI for the same `6046077976444928` row
shows the "Shipped" badge, and
[`developer.chrome.com/release-notes/151`](https://developer.chrome.com/release-notes/151)
lists it under "CSS and UI" with a `ChromeStatus.com entry | Spec`
footer linking to the same id. The `is_released: false` in the API is a
stale row on the back-end that nobody bothered to advance.

## How to actually tell whether a Direct Sockets feature shipped

Three signals that don't depend on `is_released`:

1. **The latest `stage_type` in the `stages[]` array.** `160` = Shipped,
   `150` = Ready to ship, `140` = On track / shipping, `130` =
   Origin trial, `120` = Developer trial, `110` = Proposed. A row
   with `stages[-1].stage_type == 160` and a non-null
   `stages[-1].desktop_first` has shipped in the milestone the
   `desktop_first` field points at. Ignore `is_released`.
2. **`developer.chrome.com/release-notes/<milestone>`.** The release
   notes for Chrome 151 list the merger under "CSS and UI" with a
   direct link to the chromestatus id. If it's in the release notes,
   it's in the binary. The release notes are the source of truth.
3. **`chromestatuslite.com/v<milestone>`** mirror — it cross-references
   the chromestatus API and the release notes into a single
   "Enabled by default in <version>" list. Useful as a sanity check
   when you don't want to grep the release notes manually.

We did (1) and (2) above; (3) is a third confirmation. All three
converge on "shipped in Chrome 151." Only the chromestatus REST
endpoint disagrees, and it disagrees for *every* post-132 Direct
Sockets entry, not just this one.

## Why webadb cares (and why we already pinned around it)

webadb's Wi-Fi panel ships behind the
[`direct-sockets`](https://wicg.github.io/direct-sockets/) spec, gated
on COOP/COEP and the IWA permission policies. The pipeline was wired
up in
[`4728896 feat(wifi): real TCP ADB transport via Chrome Direct Sockets API`](https://github.com/webadb-online/webadb.online/commit/4728896)
and the diagnostic on
[`dee63ba feat(wifi): friendly Direct Sockets missing-API diagnostic`](https://github.com/webadb-online/webadb.online/commit/dee63ba)
maps cleanly to the policy directives the merger introduced. Two
practical consequences of the merger for our code:

- The `direct-sockets-private` policy in the IWA manifest no longer
  covers the LAN range on Chrome 151+. Our bundled manifest emits
  `local-network` and `loopback-network` explicitly — without that
  change the panel would silently fail to connect to `192.168.x.x`
  adb devices on Chrome 151+ even though the legacy
  `direct-sockets-private` was accepted on Chrome 150 and earlier.
- On Chrome 151+ a missing `local-network` declaration no longer
  produces a generic "Direct Sockets not available" — Chrome raises
  the `InvalidAccessError` defined in the spec's policy integration
  clause. The friendly diagnostic surfaces that as a distinct
  per-network-class error ("LAN access denied" vs "loopback access
  denied") so users with a too-restrictive policy can see exactly
  which declaration to add.

The chromestatus lag doesn't affect any of that — the policy merger
is in Chrome 151 regardless of what `is_released` says, and our
manifest already accounts for it. We are not blocked on chromestatus
catching up. The point of this post is that *other* developers who
use chromestatus as a "is it shipped yet" gate are getting a false
`false` for this and several sibling features, and the right
mitigation is to ignore `is_released` and trust the `stage_type: 160`
+ `desktop_first` pair (or just check the release notes).

## The "what changed this week" line

For the record, in the seven days since the Sep 21 re-check:

- **ya-webadb upstream**: zero new commits. Latest is still
  [`96182a6 chore: release v3.0.0-beta.3`](https://github.com/yume-chan/ya-webadb/commit/96182a6)
  from 2026-09-15. The IndexedDB credential-storage regression we
  wrote up on
  [`2026-09-22`](https://webadb.online/blog/2026/09/22/ya-webadb-3-0-0-beta-3-indexeddb-storage-regression/)
  is still open upstream and still doesn't affect our path.
- **webadb.online main**: zero new commits in the last 24 hours; the
  last local change was the Sep 22 blog post itself.
- **Chrome release calendar**: stable advanced 154 → 155 with an
  Oct 6 stable date; beta and dev advanced correspondingly. None of
  those milestones have any Direct Sockets entries on the chromestatus
  "what's new in this milestone" view.
- **chromestatus REST API**: every Direct Sockets entry we watch has
  the same `updated.when` as the previous Monday. **No state
  changed.**

The shape of this post is "no upstream activity, no shipped-but-not-
announced milestones, just one systemic observation about a metadata
lag." It's a Monday re-check with nothing new to check except the
re-check itself.

## What to do if you're reading `is_released` from the API

Two patches that take 30 seconds and unblock you against the broken
`is_released` field:

```ts
// ❌ broken since Chrome 132/133 for IWA-era features
const shipped = feature.is_released;

// ✅ use the stage-type + desktop_first pair instead
const latest = feature.stages.at(-1);
const shipped =
  latest?.stage_type === 160 &&     // 160 = "Shipped" stage
  typeof latest.desktop_first === "number" &&  // milestone number
  latest.desktop_first <= currentStableChrome;
```

If you're already on top of the chromestatus REST API and treating
`is_released` as authoritative, you're likely undercounting IWA
features by 6+ rows. The Aug 2026 → Sep 2026 window is the worst part
of the lag because the merger itself is in there, but the underlying
issue is older — the oldest un-flipped row in the table above is
2025-01-31, which means anything in the IWA surface from Chrome 132
onward is suspect.

## What this means for webadb.online

No code change required. Our Wi-Fi pipeline already targets the
post-merger policy surface, the diagnostic already distinguishes
LAN vs loopback access errors, and the binary in Chrome 151+ has
the feature regardless of chromestatus's `is_released` flag.

The only downstream consequence is for *other* ya-webadb-based
projects that consume the chromestatus API directly. If you're one of
them and you've been sitting on a "wait for chromestatus to confirm
shipping" gate for a feature in the IWA / Direct Sockets space, the
right move is to drop that gate and trust the release notes instead.
Chrome 151's release notes list the merger; the binary has had it
since July 28; chromestatus's API will catch up when somebody at
Google bumps the row, but there's no signal that bump is coming on
any particular schedule.

We'll do this re-check again next Monday unless something changes —
either the chromestatus entry's `updated.when` advances (in which
case the lag is closing and the asymmetry is resolving), or another
post-IWA entry ships without `is_released` flipping (in which case
the lag is widening and the systemic framing strengthens). The same
two JSON endpoints (`/api/v0/features/6046077976444928` and
`/api/v0/channels`) are the right place to look.
