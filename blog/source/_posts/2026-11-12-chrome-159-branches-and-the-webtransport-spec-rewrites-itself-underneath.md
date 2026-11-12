---
title: "Chrome 159 branches, and the WebTransport spec rewrites itself underneath"
date: 2026-11-12 01:00:00 UTC
tags:
  - webtransport
  - chrome-159
  - w3c
  - datagrams
  - getstats
---

Chrome 159 branched to Beta yesterday, which freezes the WebTransport wave this blog has been tracking since Nov 8 into a shippable milestone. Twenty-two hours before that branch, the W3C WebTransport Working Group's GitHub repository received **fourteen new pull requests inside a twenty-three-minute window** — and in the week before it, the group's spec editor merged four normative changes that Chromium has not implemented. The branch and the churn are the same story seen from two ends: 159 locks in what exists, while the spec underneath it is still deciding what the *next* milestone should even mean.

## The branch: M159 is now real

The Chrome milestone schedule for M159 was unusually compressed. Branch point and feature freeze both landed on November 9, earliest beta November 11, final beta cut November 18, early stable November 18, stable December 8. That is a three-week gap between beta and stable, which is the holiday stretch the release calendar normally absorbs by giving a milestone more room. Chrome 158 went stable the same week it was supposed to branch into beta, so the two milestones are overlapping in a way that makes the beta channel the only place to test anything new.

The branch itself is visible in Chromium's own infrastructure. The `projects/chromium-m159` config set on LUCI points at revision `84480ae178055411e6bc73507798a597178cd51a`, committed **2026-11-10 15:15:47 UTC** by `chrome-branch-day@chops-service-accounts.iam.gserviceaccount.com` — the bot that cuts release branches. The first tag on that head, `159.0.8152.0`, was created on **November 9, 2026** with `Cr-Branched-From: refs/heads/main@{#1737478}`, and the branch-head config file `chrome_branch_deps.json` for branch 8152 follows from the same `main` position.

So the ordering is: feature freeze and branch point on Nov 9, the `chrome-branch-day` branch head cut on Nov 10, beta builds going out on Nov 11. Whatever was in `main` at `{#1737478}` is what Chrome 159 is.

What that means concretely: as of yesterday, the twenty features [enabled by default in Chrome 159](https://chromestatuslite.com/) are frozen. The list includes seven WebTransport entries, and this blog has already covered the two most consequential ones in detail — the [datagram writable streams with `sendGroup` / `sendOrder` prioritization](https://webadb.online/blog/2026/11/09/chrome-159-webtransport-datagram-send-priority/) and the [`getStats()` implementation that ships five of the spec's thirteen dictionary members](https://webadb.online/blog/2026/11/10/webtransport-getstats-chrome-159-and-permissions-policy-for-workers/).

What has *not* been covered is the thing that will determine whether Chrome 160 is a drop-in replacement for Chrome 159, or a different API. Between Nov 3 and Nov 11 the specification changed in four places that alter observable behaviour.

## The spec editor merged four normative changes in one hour

Jan-ivar, who chairs the WebTransport Working Group and edits the spec, opened four pull requests against `w3c/webtransport` on the evening of November 3 and merged all four within roughly an hour on November 4. Each one closed an issue filed earlier that October, and each one is a behaviour change rather than an editorial cleanup.

### `outgoingMaxAge` is now non-nullable and defaults to `Infinity`

[PR #813](https://github.com/w3c/webtransport/pull/813), closing [issue #807](https://github.com/w3c/webtransport/issues/807), changes the IDL:

```diff
-  attribute unrestricted double? outgoingMaxAge;
+  attribute unrestricted double outgoingMaxAge;
```

and the corresponding internal slot from `null`-able to a plain `double`, with the initial value changing from `null` to `Infinity`. The `writeDatagrams` algorithm also loses its `implementation-defined` fallback:

```diff
-  1. If |duration| is null, then set |duration| to an [=implementation-defined=] value.
```

The rationale is that `null` was never a meaningful state. An application setting `outgoingMaxAge = null` either meant "never expire" or meant "use whatever the UA picked", and the second reading made the attribute untestable. `Infinity` is the same thing but says it out loud.

This is the change with the longest tail, because Chromium has not caught up. Chromium's `WebTransportDatagramDuplexStream::setOutgoingMaxAge()` still takes a `std::optional<double>`, and `null` is still the IDL type in the shipped implementation. An application written against the new spec that does `wt.datagrams.outgoingMaxAge = Infinity` will work today, but an application that *reads* the attribute back and compares against `null` will behave differently once Chromium implements the change. The WebKit implementation carries the same `std::optional` shape.

### The user agent can now cap the datagram send queue by bytes

[PR #815](https://github.com/w3c/webtransport/pull/815), closing [issue #806](https://github.com/w3c/webtransport/issues/806), adds a new normative concept — *send queue is full* — that can be triggered by a byte limit as well as by the existing datagram-count limit:

```diff
+ A {{WebTransportDatagramsWritable}} |writable|'s
+ <dfn for="WebTransportDatagramsWritable">send queue is full</dfn> if either of the following is
+ true:
+
+ * The length of |writable|.{{[[OutgoingDatagramsQueue]]}} is not less than
+   |writable|.{{WebTransportDatagramsWritable/[[Transport]]}}.{{[[Datagrams]]}}.{{[[OutgoingMaxBufferedDatagrams]]}}.
+ * The total byte length of the datagrams in |writable|.{{[[OutgoingDatagramsQueue]]}} is greater
+   than an [=implementation-defined=] positive byte limit.
```

The note attached to it explains the intent: the byte limit lets the user agent cap memory in the underlying sink regardless of `outgoingMaxBufferedDatagrams`, and datagrams beyond it wait in the `WritableStream`'s own queue rather than in the sink's.

This is the single most consequential change in the batch for anyone who writes datagram-heavy code, because it changes the *shape* of backpressure. The existing Chromium implementation of `WebTransportDatagramDuplexStream.createWritable()` — commit `ff66885fb0d785437f82f9ab7aaedd3d3dcc8812`, "WebTransport: Implement Datagram writable streams" — gates the API behind an experimental runtime feature and deliberately leaves the priority plumbing to a follow-up CL:

> This CL stores and validates sendGroup/sendOrder; plumbing those priorities through Mojo and the network service is intentionally left to a follow-up CL.

So the send-group prioritization that Chrome 159 ships is, at the Chromium level, currently a value that gets stored and validated but not yet honoured end-to-end. The Nov 9 post covered the *API surface* landing; this is the reminder that the surface and the semantics are two different milestones.

### `getStats()` members are now chosen once per session, not per call

[PR #814](https://github.com/w3c/webtransport/pull/814), closing [issue #808](https://github.com/w3c/webtransport/issues/808), replaces the phrase "the user agent wishes to expose" with a defined term, *chooses to expose*:

```diff
-A user agent can withhold stats members, e.g. for privacy. It
-<dfn>chooses to expose</dfn> a stats [=dictionary member=] if it makes this
-choice once per [=WebTransport session=], not per call. So a member present in
-one `getStats()` result won't disappear from later results in the same session.
```

The problem it solves is real and was reported against Chromium: a member could show up in one `getStats()` result and be missing from the next, with no way for the application to tell "the UA chose to withhold this" from "this field does not exist yet". The fix makes the choice stable for the lifetime of the session.

The same change applies to `WebTransportSendStream.getStats()`, `WebTransportSendGroup.getStats()` and `WebTransportReceiveStream.getStats()` — all four sites in the spec now say "chooses to expose" rather than "wishes to expose".

### Datagram reception moves to in-parallel processing

[PR #812](https://github.com/w3c/webtransport/pull/812) is the smallest of the four, and the most consequential for anyone benchmarking:

```diff
-  1. Let |datagram| be the result of [=session/receiving a datagram=] with |session|.
+  1. Let |datagram| be the result of [=session/receiving a datagram=] with |session| [=in parallel=].
```

One keyword. The `receiveDatagrams` loop now pulls each datagram concurrently rather than one-at-a-time, which is what makes a high-rate datagram stream actually saturate a link instead of running at one-message-per-round-trip.

## The specification is being rewritten by a newcomer, in bulk

The most striking thing in the repository this week is not the four merges. It is what happened on November 11.

Between **00:53:31Z and 01:16:57Z** — twenty-three minutes and twenty-six seconds — **fourteen** pull requests were opened against `w3c/webtransport` by a single account, `JinDX`. They are, in order:

| PR | Title |
|----|-------|
| [#819](https://github.com/w3c/webtransport/pull/819) | Serialize WebTransport datagram send passes for each writable |
| [#820](https://github.com/w3c/webtransport/pull/820) | Restore the WebTransport stream error code during deserialization |
| [#821](https://github.com/w3c/webtransport/pull/821) | Snapshot WebTransport TLS exporter label and context bytes |
| [#822](https://github.com/w3c/webtransport/pull/822) | Forward the write chunk to writeDatagrams |
| [#823](https://github.com/w3c/webtransport/pull/823) | Use the transport argument in the fetch response assertion |
| [#824](https://github.com/w3c/webtransport/pull/824) | Return the rejected promise from getStats() for failed transports |
| [#825](https://github.com/w3c/webtransport/pull/825) | Preserve the pending atomic writes when clearing the slot |
| [#826](https://github.com/w3c/webtransport/pull/826) | Use the same WebTransport object for construction and Fetch |
| [#827](https://github.com/w3c/webtransport/pull/827) | Use the BufferSource byte length for the datagram size check |
| [#828](https://github.com/w3c/webtransport/pull/828) | Compare the reserved WebTransport header as bytes |
| [#829](https://github.com/w3c/webtransport/pull/829) | Track closing send streams until their data is committed |
| [#830](https://github.com/w3c/webtransport/pull/830) | Bind the datagram duplex stream in receiveDatagrams |
| [#831](https://github.com/w3c/webtransport/pull/831) | Pass send group and send order through bidirectional stream creation |
| [#832](https://github.com/w3c/webtransport/pull/832) | Read the attached stream in WebTransportWriter.commit() |

A fifteenth PR arrived later the same day from a different author: [#833](https://github.com/w3c/webtransport/pull/833), "Pass an origin instead of a URL to 'obtain a connection'", opened at 11:11:03Z by `noamr` (Noam Ravid), following [whatwg/fetch#1968](https://github.com/whatwg/fetch/pull/1968). That one was **closed** at 17:32:53Z the same day, with Annevk (Anne van Kesteren) commenting:

> @noamr confirmed PAC still needs this at least in Chrome so I recommend closing this.

The account is new to the project. `JinDX` — 金东勋 / 김동훈 / Jin Dongxun — has a GitHub account created in 2011 and 166 public repositories, and its only prior contribution to `w3c/webtransport` was [PR #810](https://github.com/w3c/webtransport/pull/810), "Remove duplicated articles from WebTransport statistics steps", which merged on November 3 and was the setup commit for jan-ivar's four PRs the same evening.

These are not typo fixes. Read the diffs:

**#819** adds a new MUST that serializes the send passes per writable:

```diff
+For each writable, the user agent MUST complete an invocation's parallel steps and
+all of its queued [=dequeue outgoing datagrams=] tasks before starting another
+invocation of [=sendDatagrams=] for that writable.
```

**#831** changes the internal-slot signature of `WebTransportBidirectionalStream` creation so that a `sendGroup` is threaded through, not just a `sendOrder`:

```diff
-To <dfn for=BidirectionalStream>create</dfn> a {{WebTransportBidirectionalStream}} with a
-... a |sendOrder|, run these steps.
+To <dfn for=BidirectionalStream>create</dfn> a {{WebTransportBidirectionalStream}} with a
+... a |sendGroup|, and a |sendOrder|, run these steps.
```

**#824** changes what `getStats()` returns when the transport has already failed — from "abort these steps" to "return the promise":

```diff
-  1. If |transport|.{{[[State]]}} is `"failed"`, [=reject=] |p| with an
-        {{InvalidStateError}} and abort these steps.
+  1. If |transport|.{{[[State]]}} is `"failed"`, [=reject=] |p| with an
+        {{InvalidStateError}} and return |p|.
```

That last one is a genuine spec bug fix: the old text rejected a promise and then aborted, which meant the algorithm returned `undefined` where the caller expected a promise — so `await transport.getStats()` on a failed transport would have resolved with `undefined` instead of throwing.

**#830** binds the datagram duplex stream inside `receiveDatagrams`, and **#828** changes the reserved-header comparison to operate on bytes rather than on a string, which is the kind of detail that turns a header check from a locale-dependent comparison into a byte-exact one.

All fourteen are still open, and — as of this writing — **none has received a single review**. GitHub's pull-request list shows a `1/2` counter next to each, but that is a reaction count, not a review state: the `reviews` array on every one of them is empty, and the `reviewDecision` field is blank. That is worth stating plainly, because a batch of fourteen normative changes sitting unreviewed in a W3C specification repository is a queue, not a roadmap. None of it is merged, and the spec editor has not signed off on any of it.

That is also what makes the batch interesting to watch rather than to act on. The diffs are substantive and mostly correct — #824 in particular fixes a real spec bug — but "correct" and "will land" are different claims. For now they are sitting in the queue that *might* define Chrome 160.

## Three more PRs from the spec editor, and the question they raise

Between Nov 9 and Nov 11, jan-ivar opened three more:

- [#817](https://github.com/w3c/webtransport/pull/817), "Validate options.headers next to protocols in constructor" (Nov 9)
- [#818](https://github.com/w3c/webtransport/pull/818), "Don't create incoming streams after cleanup" (Nov 10)
- [#816](https://github.com/w3c/webtransport/pull/816), "Add WebTransport datagram concept" (Nov 4) — still open, fixes [#793](https://github.com/w3c/webtransport/issues/793)

#818 is the one worth reading closely, because it is a race that any application draining `incomingBidirectionalStreams` can hit:

```diff
  1. [=Queue a network task=] with |transport| to run these steps:
+    1. If |transport|.{{[[State]]}} is `"closed"` or `"failed"`,
+       [=reject=] |p| with an {{InvalidStateError}} and abort these steps.
     1. Let |stream| be the result of [=BidirectionalStream/creating=] a
```

The window it closes is real: a stream arrives from the network, the application is scheduled to handle it, the transport closes in between, and the stream gets enqueued into a closed transport's `IncomingBidirectionalStreams` — where it will never be read and never be cleaned up. The same guard is added to the unidirectional path.

And there is an open issue, [#811](https://github.com/w3c/webtransport/issues/811), from Vasil Vasylyev, that reads like a note from someone who ships QUIC:

> "Background" CCs like LEDBAT allow applications to send traffic that will proactively "yield" to other traffic on the network; I have had mobile app developers request this one for native QUIC libraries before, so I do wonder if we should add this as an option.

Chrome 159 ships `WebTransport.congestionControl` with three values — `default`, `throughput`, `low-latency`. A `background` mode would let an application mark its own traffic as yieldable, which is exactly the property you want for a device-management protocol that must not interfere with whatever else the network is carrying.

## Why the timing matters

There is a structural reason these two events landed on adjacent days.

Chrome's milestone process freezes the *implementation* at feature freeze. A CL that lands after the branch point is not in Chrome 159 — it is in Chrome 160, and it must satisfy the spec *as it stands when the CL lands*. The four normative changes merged on Nov 4 are now the spec that any Chromium CL touching `outgoingMaxAge`, datagram backpressure, or `getStats()` visibility must implement.

That means the Chrome 159 WebTransport surface — the one this blog has spent three posts describing — is going to be *revised* in Chrome 160, and in ways that are visible to application code:

- `outgoingMaxAge` changes type, from `double?` to `double`, with a different default.
- The datagram send queue can now report "full" for byte reasons, which changes when `WritableStream` backpressure fires.
- `getStats()` member presence becomes stable within a session, which changes what an application can cache.
- Datagram reception becomes concurrent, which changes throughput characteristics.

None of these is a breaking change in the usual sense. They are changes in *observable timing and defaults* — the category of change that breaks code which was written against the old behaviour and tested against it.

There is also a parallel thread: `w3c/webtransport` PR [#809](https://github.com/w3c/webtransport/pull/809), "Assert reliance on fetch partitioning before pooling", merged on Nov 4, adds an assertion to the *obtain a WebTransport connection* algorithm:

```diff
+  1. Assert: |newConnection| is not "`no`", or |networkPartitionKey|[1] is neither
+     null nor a fixed value.
+
+     Issue: Fetch currently allows |networkPartitionKey|[1] to be null. See
+     <a href="https://github.com/whatwg/fetch/issues/1926">whatwg/fetch#1926</a>.
```

That is the pooling-privacy question: whether two WebTransport sessions to the same origin can share one underlying connection. It is unresolved, and the same question came up in a different form on Nov 11 in PR #833 ("Pass an origin instead of a URL to 'obtain a connection'"), which was opened and closed the same day because Chrome's Private Access Controls still need the URL form.

## What this means for webadb.online

No direct impact on webadb this week — the webadb side of the project did not ship anything new in the last 24 hours beyond yesterday's `pm install -S` work, and `ya-webadb` upstream has been quiet since `v3.0.0-beta.5` on November 6.

The relevance is forward-looking and narrow. webadb's ADB transport runs over WebUSB, not WebTransport, so none of these changes touch the core path. But the ADB protocol is a *stream* protocol with a request/response discipline, and the shape of the stream API is exactly what is being rewritten underneath Chrome 159:

- If you are running an ADB-over-WebTransport experiment (WebTransport to a TCP bridge in front of `adbd`), then the `outgoingMaxAge` type change and the byte-based send-queue cap are both things you will hit when Chrome 160 lands, because they change when backpressure fires on a stream you are writing into.
- The `getStats()` stability guarantee is what you would want before writing any telemetry that samples connection health over a session — before this change, a member could vanish between two calls in the same session and your sampler would have to treat "missing" as "unknown" forever.
- The in-parallel datagram reception change is the kind of thing that makes a real-time channel work; if you ever map ADB's `shell:` protocol onto datagrams rather than streams, the throughput ceiling moves.

The practical advice is unchanged from the last three posts and is worth restating because the branch just made it concrete: **feature-detect, do not version-gate.** Chrome 159's WebTransport API is stable in the sense that it is enabled by default and will not be removed, but four of its behaviours are about to change underneath it. Code that reads `datagrams.outgoingMaxAge` and compares it to `null`, or that computes backpressure from `outgoingMaxBufferedDatagrams` alone, or that re-reads `getStats()` members every poll, will need revisiting.

Chrome 159 reaches stable on December 8. The spec churn that will define Chrome 160 is already in the repository, twenty-three minutes at a time.
