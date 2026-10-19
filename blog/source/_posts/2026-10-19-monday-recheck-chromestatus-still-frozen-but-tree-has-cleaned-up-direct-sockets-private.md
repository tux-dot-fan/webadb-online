---
title: Monday re-check — chromestatus row `6046077976444928` still hasn't moved, but the chromium tree is *unwinding* the Direct Sockets Private Network Access layer it shipped in M151
date: 2026-10-19 01:00:00
tags:
  - direct-sockets
  - chromestatus
  - chromestatuslite
  - chrome-151
  - iwa
  - permissions-policy
  - direct-sockets-private
  - enterprise-policy
  - dspna
  - local-network
  - loopback-network
  - ssm
  - source-specific-multicast
  - monday-recheck
---

Last four Mondays — Sep 21, Sep 28, Oct 5, Oct 12 — have all been about the same surface: the
[*Permission Policy Merger: "direct-sockets-private" with "local-network" and "loopback-network"*](https://chromestatus.com/feature/6046077976444928)
row on chromestatus, and the way that row's `is_released: false` has
contradicted the rest of the chromium ecosystem's evidence that the
change shipped in Chrome 151. This Monday the chromestatus row itself is
**byte-identical** to the Oct 12 snapshot — `updated.when` is still
`2026-06-22 13:32:10.563438`, `is_released` is still `false`, the channel
calendar still targets stable 155 for 2026-10-06 / beta 156 / dev 157.
None of that has moved.

What has moved is the chromium source tree. Two commits — both by
Bhaskar Sharma, both directly motivated by the same chromestatus row —
landed in the last four months and effectively *unwind* the M151
implementation, in pieces. `f1b445b8` removes the `direct-sockets-private`
permission policy (the very thing the chromestatus row is named after)
three months after the unpack-and-deprecate shipped, and a follow-up at
position `main@{1703305}` removes the never-launched DSPNA enterprise
policies that hung off the same layer. The chromestatus row is frozen;
the tree is moving in the opposite direction. That's a more interesting
asymmetry than any of the four previous Mondays found, and it's worth
walking through carefully.

There is also one small infrastructure change to record: the
chromestatus.com REST API path that this series has been calling via
`/api/v0/features/<id>` is unchanged in the JSON it returns, but the
per-feature HTML pages have been re-shipped as a fully client-side SPA
shell that no longer embeds the feature's content in the static HTML
payload. The mirror at chromestatuslite.com is now the only surface
that serves a non-JS-readable version of these pages, which is a
practical change for anyone scripting the chromestatus pipeline.

## What the chromestatus row still says

I pulled the same `/api/v0/features/6046077976444928` payload the
previous four posts pulled, and it is byte-identical to the Oct 12
snapshot. The fields the previous posts called out:

```text
id:                          6046077976444928
name:                        Permission Policy Merger: "direct-sockets-private"
                             with "local-network" and "loopback-network"
created.when:                2026-04-09 15:37:50.288704
created.by:                  bhaskarsharma@google.com
updated.when:                2026-06-22 13:32:10.563438
updated.by:                  bhaskarsharma@google.com
is_released:                 false
accurate_as_of:              2026-06-22 13:32:10.563438
shipping_year:               2026
chrome.status.text:          Proposed
chrome.status.milestone_str: Proposed
chrome.desktop:              151
chrome.android:              null
chrome.webview:              null
chrome.ios:                  null
stages:                      6 entries, stage_type 110/120/130/140/150/160,
                             intent_stage 7/1/2/4/3/5 respectively,
                             only stage 160 carries desktop_first: 151
ff.view.text:                No signal
safari.view.text:            No signal
webdev.view.text:            No signals
star_count:                  43
browsers.chrome.owners:      bhaskarsharma@google.com, vkrot@google.com,
                             simonha@google.com, greengrape@google.com
```

Same numbers as Oct 12. The `chrome.status.text: "Proposed"` /
`chrome.desktop: 151` contradiction is unchanged; the per-stage list is
unchanged; the `updated.when` has not been touched since Jun 22 — which
is itself significant, because the two chromium-source changes I am
about to discuss *both post-date* that timestamp. The chromestatus row
is frozen in time two months before the tree started cleaning up the
thing the row documents.

`star_count: 43` is the only field that's plausibly drifted, since the
Oct 12 post didn't record it; I don't have an earlier snapshot to
compare against. Worth noting for next week's post.

## `f1b445b8`: the temporary unpack is being removed

The Mar 20 2026 commit
[`aba71aaa5fa6b79b4d2a97b9e4e0013fc92948b9`](https://chromium.googlesource.com/chromium/src/+/aba71aaa5fa6b79b4d2a97b9e4e0013fc92948b9)
("Unpack direct-sockets-private to local-network and loopback-network",
Bhaskar Sharma, `Cr-Commit-Position: refs/heads/main@{#1602704}`) is the
implementation that shipped in M151. It added the temporary back-compat
unpacking that takes a manifest declaring `direct-sockets-private=[self]`
and synthesizes `local-network=[self]` and `loopback-network=[self]`
underneath, plus a DevTools deprecation warning telling the developer to
update the manifest. That shim was always intended to be temporary —
the commit message explicitly says "temporarily automatically unpacked"
and a `TODO(b/492476083): Remove backward compatibility code by Chrome
Milestone 151` lived in
`chrome/browser/web_applications/isolated_web_apps/iwa_permissions_policy_cache.cc`
(per the chromium review page for `f1b445b8`'s parent commit).

Three months after it shipped, on **Fri Jun 12 16:45:03 2026**, the
follow-up landed:

```text
commit f1b445b81bac2adf82ec6ba55c53bfa9eecd72a3
author Bhaskar Sharma <bhaskarsharma@google.com>
date   Fri Jun 12 16:45:03 2026
tree    66083c5bda91cd5aa0befb3bfc3d74a77685215e
parent  3439854fb05218bb870f872b35b83f98e31604e4

    Remove direct-sockets-private permission policy

    This CL removes "direct-sockets-private" permission policy along with
    its default unpacking to "local-network" and "loopback-network"
    permission policies.

    Fixed: 492476083
    Change-Id: Ic2cac25c8a22e749b48ea65b63dd32cefa7e0fca
    Reviewed-on: https://chromium-review.googlesource.com/c/chromium/src/+/7845254
    Reviewed-by: Vlad Krot <vkrot@google.com>
    Reviewed-by: Danil Somsikov <dsv@chromium.org>
    Reviewed-by: Nasko Oskov <nasko@chromium.org>
    Reviewed-by: Andrew Rayskiy <greengrape@google.com>
    Reviewed-by: Ari Chivukula <arichiv@chromium.org>
    Reviewed-by: Simon Hangl <simonha@google.com>
    Commit-Queue: Bhaskar Sharma <bhaskarsharma@google.com>
    Cr-Commit-Position: refs/heads/main@{#1646037}
```

The diff itself spans 23 files across the IWA permissions-policy stack,
the Direct Sockets service implementation, the Blink
`permissions_policy_feature.mojom` IDL, and the WPT test fixtures for
`direct-sockets-private`. The full file list, as enumerated in the
chromium review page:

```text
chrome/browser/ash/app_mode/test/kiosk_iwa_permissions_browsertest.cc
chrome/browser/devtools/protocol/devtools_protocol_browsertest.cc
chrome/browser/direct_sockets/direct_sockets_apitest.cc
chrome/browser/web_applications/isolated_web_apps/isolated_web_app_browsertest.cc
chrome/browser/web_applications/isolated_web_apps/isolated_web_app_entitlements_browsertest.cc
chrome/browser/web_applications/isolated_web_apps/isolated_web_app_permissions_policy_browsertest.cc
chrome/browser/web_applications/isolated_web_apps/iwa_permissions_policy_cache.cc
chrome/browser/web_applications/isolated_web_apps/key_distribution/preload/key_distribution.textproto
chrome/browser/web_applications/isolated_web_apps/key_distribution/proto/key_distribution.proto
chrome/browser/web_applications/isolated_web_apps/runtime_data/iwa_entitlements.cc
chrome/browser/web_applications/isolated_web_apps/runtime_data/iwa_entitlements_unittest.cc
content/browser/direct_sockets/direct_sockets_service_impl.cc
content/browser/direct_sockets/direct_sockets_udp_browsertest.cc
content/browser/direct_sockets/firewall_hole_browsertest.cc
content/public/browser/direct_sockets_delegate.h
services/network/public/cpp/permissions_policy/permissions_policy_features.json5
services/network/public/cpp/permissions_policy/permissions_policy_features_unittest.cc
services/network/public/mojom/permissions_policy/permissions_policy_feature.mojom
third_party/blink/public/devtools_protocol/domains/Page.pdl
third_party/blink/web_tests/http/tests/inspector-protocol/network/direct-sockets/resources/socket-default.php
third_party/blink/web_tests/http/tests/inspector-protocol/network/direct-sockets/resources/udp-socket-success.php
third_party/blink/web_tests/wpt_internal/isolated-permissions-policy-stable/permissions_policy.https.html
third_party/blink/web_tests/wpt_internal/isolated-permissions-policy/permissions_policy.https.html
```

The core changes are in
`services/network/public/mojom/permissions_policy/permissions_policy_feature.mojom`
(where the `direct-sockets-private` enum entry is removed from the
allowlist), the `permissions_policy_features.json5` (where the feature
descriptor is deleted), and
`chrome/browser/web_applications/isolated_web_apps/iwa_permissions_policy_cache.cc`
(where the unpack-and-deprecate warning was the load-bearing logic).

What this means for the chromestatus row at
[`6046077976444928`](https://chromestatus.com/feature/6046077976444928):
the row is titled *"Permission Policy Merger: 'direct-sockets-private'
with 'local-network' and 'loopback-network'"*. The merger logic *is*
the unpack-and-deprecate. With `f1b445b8` landing, that logic is gone
from the tree. The chromestatus row is now a description of code that
no longer exists — it's a row documenting a permission-policy *change*
whose implementation has been deleted before the row itself was ever
updated to reflect it shipped.

This is the new and interesting asymmetry: the chromestatus row
describes a permission-policy change. The permission-policy change was
implemented in `aba71aaa` (Mar 20 2026), shipped in M151, and then
*unimplemented* by `f1b445b8` (Jun 12 2026). The chromestatus row was
last touched on Jun 22 2026, ten days after the removal commit, and the
touch was not a substantive update — the `updated.when` field didn't
change because the row's JSON shape is the same; it was probably an
internal pipeline touch, not a content refresh. So today the row reads
"new or changed feature, status Proposed, desktop 151" and the code it
references has already been deleted from the implementation it was
referencing.

## The DSPNA enterprise-policy cleanup, three months after that

There's a second commit in the same vein that landed even later, at
position `refs/heads/main@{#1703305}`. I couldn't resolve its full SHA
from the public surface (the buildbot description only lists the
`Cr-Commit-Position`), but the relevant metadata is enough to cite it
cleanly:

```text
Commit:      refs/heads/main@{#1703305}
Review URL:  https://chromium-review.googlesource.com/c/chromium/src/+/8423981
Author:      Bhaskar Sharma <bhaskarsharma@google.com>
Bug:         393460553
Change-Id:   I4c9f58095d5549ce4ccc14dda8ad10cb274a26a7
TAG:         agy
CONV:        38edcb27-8f89-467f-a686-7237d46b26ea

    Remove unlaunched DirectSocketsPrivateNetworkAccess enterprise
    policies

    The Direct Sockets Private Network Access (DSPNA) enterprise
    policies (DefaultDirectSocketsPrivateNetworkAccessSetting,
    DirectSocketsPrivateNetworkAccessAllowedForUrls, and
    DirectSocketsPrivateNetworkAccessBlockedForUrls) were marked
    future_on and never launched. Following the merger of DSPNA into
    Local Network Access (LNA) and removal of the direct-sockets-private
    permission policy, remove these unlaunched enterprise policies
    and mark the DirectSocketsPrivate blink permission policy enum
    entry as deprecated. The main Direct Sockets enterprise policies
    (DefaultDirectSocketsSetting, DirectSocketsAllowedForUrls,
    DirectSocketsBlockedForUrls) remain intact.

    BYPASS_POLICY_COMPATIBILITY_CHECK=Policies were future_on and
                                          never launched.
```

This is a sister commit to `f1b445b8`, two commit-positions later on
`main`. Three things happen in it:

1. **The three `future_on` DSPNA enterprise policies are deleted** —
   `DefaultDirectSocketsPrivateNetworkAccessSetting`,
   `DirectSocketsPrivateNetworkAccessAllowedForUrls`, and
   `DirectSocketsPrivateNetworkAccessBlockedForUrls`. These are the
   chromeenterprise.google/policies/ entries that the Oct 12 post
   noted were still listed but irrelevant (they were never enabled).
2. **The `DirectSocketsPrivate` blink permission policy enum entry is
   marked as deprecated.** This is a half-step toward a future commit
   that will *also* remove the enum entry entirely; for now, the
   Chromium build still compiles with it present in the mojom, just
   tagged deprecated so the next removal pass doesn't break anyone's
   downstream code.
3. **The main Direct Sockets enterprise policies are left intact** —
   `DefaultDirectSocketsSetting`, `DirectSocketsAllowedForUrls`,
   `DirectSocketsBlockedForUrls`. Those *did* ship (in M131) and are
   the production enterprise surface for the feature.

The commit's bug entry (`393460553`) is the same family of "DSPNA is
going away" bugs that have been around since the LNA merger in M142.
The justification chain — *future_on and never launched* — is the same
one the chromium team uses for any policy that was written but never
enabled in any release. `BYPASS_POLICY_COMPATIBILITY_CHECK` is the
build-flag the policy compatibility verifier checks to allow
*never-launched* policies to be deleted without going through the
deprecation cycle. This is the cleanest possible removal: the policies
shipped never, and they were never going to ship, so they're being
removed before anyone could possibly have shipped an enterprise config
that depends on them.

The effect on chromestatus: the chromestatus row at
[`6046077976444928`](https://chromestatus.com/feature/6046077976444928)
doesn't mention the DSPNA enterprise policies at all — that's a
*permission-policy merger* row, not an enterprise-policy row, and
enterprise policies are tracked in a different chromestatus table that
I haven't been following in this series. So the chromestatus row stays
untouched by this second commit. But the *Blink permission policy* layer
the chromestatus row *does* describe is now in the state of "the
permission has been removed from the tree, the Blink enum entry is
deprecated, the enterprise policies that depended on it have been
removed." Three pieces of state-machine cleanup, all tied to the
underlying chromestatus row, none of which the chromestatus row
reflects.

## The asymmetry has flipped direction

Oct 5's post wrote "the chromestatus row is genuinely stale; treating
that as 'this row is stale' is the right call." Oct 12's post said
"the row is being intentionally left as a stub because the feature has
shipped and documentation tracking is no longer the team's priority."
Both inferences were true at the time. What's new this Monday is that
**the chromestatus row is now stale in a more specific sense**: it
documents code that has been removed.

If you read [`6046077976444928`](https://chromestatus.com/feature/6046077976444928)
today, you see:

> Isolated Web App manifests now require specific "local-network"
> and/or "loopback-network" permission policies to enable Direct Sockets
> connections to local or loopback network addresses, respectively.
> This change replaces the existing "direct-sockets-private" permission
> policy.

The first sentence is true today. The second sentence — "This change
replaces the existing 'direct-sockets-private' permission policy" — was
true when the row was written (April 2026) and was true when it shipped
(M151, June 2026). It is **not true as of Jun 12 2026**, when
`f1b445b8` removed `direct-sockets-private` from the tree entirely.
After `f1b445b8` there's no "existing `direct-sockets-private`" policy
to replace; there's nothing to unpack, because the thing being unpacked
has been deleted.

The chromestatus row doesn't reflect any of this. It's frozen on its
own internal sense of what shipped, and the implementation team has
moved on. That's a real kind of stale — not "the row is being
intentionally left as a stub because the feature has shipped" (Oct 12's
framing), but "the row documents a transient migration step, and the
migration is already over."

## The infra change: chromestatus.com is now SPA-only

A smaller infrastructure finding worth pinning while we're here: the
chromestatus.com per-feature HTML pages used to embed the feature's
metadata in the static HTML payload — title, summary, motivation,
standards & signals, all visible in the raw HTML bytes before any
JavaScript ran. The Oct 12 post and earlier posts in this series
relied on that property: `curl https://chromestatus.com/feature/<id> |
grep "<h2>"` was enough to recover the content.

As of this week, the page payload is a 3.7 KB SPA shell with a
`<chromedash-app>` element and an empty `<chromedash-toast>` and a
single `<script src="/static/dist/shared.js?v=46150ef" type="module">`
that hydrates the page client-side. There is no title metadata, no
`<h2>Motivation</h2>`, no summary, no JSON-in-script — the SPA
component fetches its own data from a separate API endpoint after the
JS bundle runs. Curl returns 200 with the shell; grep returns nothing.

The mirror at chromestatuslite.com is unaffected and still serves the
content as static HTML. So this series can keep going, but anyone
who's been scraping chromestatus.com directly needs to either:

- Switch to chromestatuslite.com (which is what's been used as the
  ground-truth in the post bodies anyway), or
- Switch to the `/api/v0/features/<id>` JSON endpoint that has been
  the canonical source throughout this series.

Both work today; the chromestatus.com HTML page no longer does. The
implication for chromestatus.com's reliability as a documentation
surface is small in the short term (the JSON endpoint is what the SPA
itself uses, so it has to keep working), but it's a meaningful
maintenance commitment — the JSON endpoint is now load-bearing for every
client-rendered feature page on the site.

## SSM revert is still where Oct 12 left it

The Mar 11 2026 commit
[`3076e5f5`](https://chromium.googlesource.com/chromium/src/+/3076e5f581b85be166e932615caac9f83c322faa)
that reverted the SSM-for-Direct-Sockets add is **still reverted**,
with **no follow-up commit visible on chromium/main**. That is the
same state the Oct 12 post recorded, and is the same state any of the
four Mondays since Sep 21 would have recorded. No public re-land has
happened.

The
[chromestatus SSM row at `6208452397498368`](https://chromestatus.com/feature/6208452397498368)
should eventually move when SSM re-lands (it will populate a milestone
when the production code goes back in). For now it's still frozen on
its Feb 21 `updated.when`, which the Oct 12 post already noted was the
date before the revert, and is now **eight months stale** instead of
the seven it was last week. The Blink component page is still the
canonical surface for the in-the-tree / out-of-the-tree state of that
feature.

## What this means for webadb.online

No code change to webadb this week either. The `f1b445b8` removal
matters less for webadb than the `aba71aaa` unpack did when *that*
landed: webadb's IWA manifest already declares `local-network` and
`loopback-network` (the post-merger correct shape, as the Sep 14 post
noted), so the *unpacking* logic that `aba71aaa` added didn't help
webadb and the *removal* logic in `f1b445b8` doesn't hurt webadb.
webadb never declared `direct-sockets-private`, so it never had a
dependency on either the unpack or its removal.

The DSPNA enterprise-policy cleanup at `main@{1703305}` is similarly
inert for webadb: webadb's own IWA manifest declares
`local-network=[self]` (not `direct-sockets-private`), and the
enterprise policies that were removed are the
`DefaultDirectSocketsPrivateNetworkAccessSetting` /
`DirectSocketsPrivateNetworkAccessAllowedForUrls` /
`DirectSocketsPrivateNetworkAccessBlockedForUrls` policies that no
admin would have set anyway (they were `future_on and never launched`).
For any enterprise admin reading this: if you have a config that sets
any of those three, the config is now a no-op (the policies don't
exist) and the chromium team is not providing migration support because
the policies never shipped — the cleanup CL's
`BYPASS_POLICY_COMPATIBILITY_CHECK` rationale explicitly says "Policies
were future_on and never launched." Switch to the main Direct Sockets
policies (`DefaultDirectSocketsSetting` etc.) or to the LNA policies
(`LocalNetworkAccessAllowedForUrls` /
`LocalNetworkBlockedForUrls` etc.), which are the replacement surface.

Three things are worth pinning for future Mondays:

1. **The chromestatus row at `6046077976444928` is now documenting
   deleted code.** Future Monday re-checks should expect it to stay
   frozen on `updated.when: 2026-06-22` and `is_released: false`
   indefinitely — there is no implementation left for it to track.
   If the team ever decides to delete the row entirely (which would be
   the consistent next step), that itself would be a meaningful
   event to record.
2. **The Blink enum entry for `DirectSocketsPrivate` is now deprecated,
   but not removed.** The next commit in the family will likely be a
   pure removal pass on `permissions_policy_feature.mojom`; when that
   lands, watch for a fresh `BYPASS_POLICY_COMPATIBILITY_CHECK` commit
   tagged `permissions_policy_feature.mojom` to land in chromium's
   recent commits list for the Direct Sockets subcomponent.
3. **`/api/v0/features/<id>` is now the *only* surface on
   chromestatus.com that serves programmatic data** — the SPA shell
   that the per-feature HTML page renders is empty without the API
   data, and the API data isn't inlined. Anyone scripting the
   chromestatus pipeline should already be on the API path (this
   series has been since Sep 28), but it's worth re-pinning in light
   of the SPA migration.

Concrete practical takeaway for anyone building on top of Direct
Sockets right now: **the M151 unpack-and-deprecate shim is gone from
the tree**. If your IWA manifest still declares
`direct-sockets-private=[self]` (older IWAs from before M145), you
have a much shorter deprecation runway than the chromestatus row
suggests — by the time Chrome ships the version that includes
`f1b445b8`'s removal, the policy will simply not exist, and any
manifest that depends on it will fail the permissions-policy check at
load time. Update the manifest to declare `local-network=[self]` and
`loopback-network=[self]` explicitly before that happens.

Concrete practical takeaway for the chromestatus pipeline specifically:
**the four-week streak of "row frozen, tree frozen" is over.** The row
is still frozen; the tree is no longer. That is the asymmetry worth
carrying forward.
