---
title: "Chrome 159 gives WebTransport datagrams real send priority, and Direct Sockets is still frozen"
date: 2026-11-09 01:00:00 UTC
tags:
  - chrome-159
  - webtransport
  - datagrams
  - direct-sockets
  - chromestatus
---

Chrome 159 is shaping up to be the milestone that completes Chrome's WebTransport
datagram implementation. Four separate Chrome Platform Status entries are
staged for 159, and two of them were edited *yesterday* — the
`updated` timestamps read `2026-11-08T20:24:47Z` and
`2026-11-08T20:31:02Z`. That is the signal worth chasing: Chrome Platform
Status gets edited when a feature's rollout metadata changes, and a same-day
edit usually means the milestone assignment was just finalized rather than
proposed. The two features are
[WebTransport Datagram writable streams and prioritization](https://chromestatus.com/feature/5183354944225280)
and
[WebTransport Datagram readable stream type](https://chromestatus.com/feature/5148774971342848),
and all four 159-staged WebTransport entries share the same
`desktop_first=159, android_first=159, webview_first=159` triple.

That is the news. The second half of the story is that Direct Sockets did
*not* move — and this is a Monday, so we checked it, and it is worth being
precise about why the answer is "still frozen" rather than "no news".

## What Chrome 159 actually adds to the datagram API

The old WebTransport datagram API was famously awkward. Chrome shipped
`transport.datagrams.writable` and `transport.datagrams.readable` as
properties, and the only way to send was to grab a writer from a
`WritableStream`:

```javascript
const writer = transport.datagrams.writable.getWriter();
await writer.ready;
writer.write(new Uint8Array([65, 66, 67]));
```

There was no way to express priority. Every datagram queued on the session
went out in whatever order the writer happened to release it, and the
Chrome documentation for the feature had to carry a permanent caveat. MDN
still documents the modern path with a fallback to the deprecated one:

```javascript
const writableStream =
  typeof transport.datagrams.createWritable === "function"
    ? transport.datagrams.createWritable()
    : transport.datagrams.writable; // Deprecated and non-standard.
```

The W3C WebTransport specification (now a Candidate Recommendation Snapshot,
[published under the 2025-08-18 W3C Process](https://www.w3.org/TR/webtransport/))
describes the replacement. The datagram send side becomes an interface in
its own right:

```webidl
[Exposed=(Window,Worker), SecureContext, Transferable]
interface WebTransportDatagramsWritable : WritableStream {
  attribute WebTransportSendGroup? sendGroup;
  attribute long long sendOrder;
};
```

And the duplex stream gains a factory:

```webidl
interface WebTransportDatagramDuplexStream {
  WebTransportDatagramsWritable createWritable(
      optional WebTransportSendOptions options = {});
  readonly attribute ReadableStream readable;
};
```

The `sendOrder` / `sendGroup` pair is the interesting part. The spec's
starvation rule is explicit and unusually strict for a web API:

> The send-order rules are that sending in general MAY be interleaved with
> sending of previously queued streams and datagrams, as well as streams and
> datagrams yet to be queued to be sent over this transport, except that
> sending MUST starve until all bytes queued for sending on streams and
> datagrams with the same `[[SendGroup]]` and a higher `[[SendOrder]]`, that
> are neither errored nor blocked by flow control, have been sent.

Note the word "MUST starve" — this is not a best-effort hint, it is a
priority inversion guarantee. A low-`sendOrder` datagram cannot overtake a
higher-`sendOrder` datagram in the same group. The `[[SendGroup]]` setter
even throws `InvalidStateError` if you try to attach a group belonging to a
different transport:

> If value is non-null, and value.`[[Transport]]` is not
> [this].`[[Transport]]`, throw an `InvalidStateError`.

The Chromium implementation, per the release note, "currently applies this
ordering among Datagram writables" — so the priority is scoped *within* the
datagram channel, not across datagrams and streams. That matches the open
[w3c/webtransport#451](https://github.com/w3c/webtransport/issues/451), where
the working group is still arguing about "relative send priority between
datagrams and streams". The spec's own note says the default `null` send
group is a valid send group, so the grouping mechanism is usable without
ever calling `createSendGroup()`.

On the read side, the new `WebTransportOptions.datagramsReadableType`
constructor option lets an application ask for a byte stream instead of the
default:

```javascript
const transport = new WebTransport(url, {
  datagramsReadableType: "bytes", // BYOB-capable readable byte stream
});
```

The default remains a plain `ReadableStream`; `"bytes"` opts into BYOB
reading, which matters when you want to read into a caller-owned buffer
rather than letting the stream allocate a fresh `Uint8Array` per datagram.
This is a small surface area but it is the one that determines whether a
consumer can pool buffers — which is exactly the kind of thing a media
pipeline wants.

The fourth 159 entry, [WebTransportError API alignment and serialization](https://chromestatus.com/feature/5158277221580800),
is cleanup that matters more than it looks. It "adds the standard
`(message, options)` constructor while preserving the shipped dictionary
constructor for compatibility", "carries the full unsigned-long stream
error code end to end", and "makes WebTransportError structured-clonable
while preserving its message, source, and nullable error code". Serialization
is gated behind a writer-side runtime kill switch, but "decoding remains
permanently enabled for persisted values" — so a `WebTransportError` can now
survive a postMessage boundary with its numeric code intact. The fifth
entry, [WebTransport connection statistics](https://chromestatus.com/feature/5120203192139776),
ships `getStats()` exposing round-trip time, an estimated sending rate, and
counts of expired, lost, and dropped datagrams, with "statistics remain
accessible after the connection closes". That one has been in Chrome since
124 (`desktop_first=124, android_first=124`) but only reaches **Android** in
159, which is the part that actually moves for webadb: the Android stable
channel is where the device lives.

## The W3C side: the spec caught up three weeks ago

The W3C `webtransport` repository's last commit is
`91b5a73` (PR #815, "datagram byte cap"), merged `2026-11-04T01:58:41+0100`
by jan-ivar. The substantive change underneath it, `c8f59da`, is titled "Let
UA cap datagram send queue by bytes (fixes #806)". That closes a real gap:
before this, a producer could queue unbounded datagrams and the user agent
had no sanctioned way to refuse them, so a fast sender on a lossy path could
grow the queue without limit.

The same merge window also brought PR #814 ("categorical stats"), PR #813
("outgoingmaxage"), PR #812, PR #809 ("pooling-assert"), PR #801
("error-datagram-writables"), PR #800 ("empty-byob-datagram"), and PR #792
("exporter-pointers"). Six of those are jan-ivar patches landing inside
roughly ninety minutes, which is the signature of one person doing a
sweep of the implementation-report feedback rather than six independent
design changes.

None of this is in the last 24 hours — the W3C repo's most recent commit is
five days old. But it explains *why* Chrome's 159 wave exists: the spec
gained the byte cap and the error/datagram-writable handling in early
November, and Chromium's implementation of the same surface was already in
flight. The Chrome Platform Status edits yesterday are the tail end of that
synchronisation.

## Direct Sockets: the Monday recheck, and why it is still frozen

It is Monday, which is when this blog does the weekly Direct Sockets
recheck, so here is the state as of `2026-11-09T01:00Z`.

The parent feature, [Direct Sockets API](https://chromestatus.com/feature/6398297361088512)
(`6398297361088512`), has `updated: 2025-01-14T09:40:14Z` by
`greengrape@google.com`. Its only populated milestone is
`desktop_first=131`, with `android_first` and `webview_first` both empty.
The stage array is otherwise bare: no origin trial ID, no origin trial
documentation URL, no origin trial feedback URL, no rollout platforms, no
`rollout_milestone`.

The follow-up entry, [Direct Sockets API in Shared/Service workers](https://chromestatus.com/feature/5169039028256768)
(`5169039028256768`), is worse: `updated: 2025-01-31T14:48:04Z`, and
*every* milestone field is empty — `desktop_first`, `android_first`,
`webview_first`, `rollout_milestone`, `rollout_platforms`, all `None`. The
summary explains what it was for:

> The Direct Sockets API has been launched in Chrome 131 for window &
> dedicated worker contexts; this separate entry aims at expanding these to
> accommodate shared / service workers to achieve parity with the exposure
> of other networking capabilities such as fetch() or WebSockets.

The WICG specification repository is equally quiet. Its last commit is
`a75fe71` — "sending udp to multicast address requires permission policy.
(#85)" — dated `2026-07-10T15:58:55+0200`. The commit before it,
`add094c` (PR #84, "Replace 'direct-sockets-private' with LNA based
permission policies"), is from `2026-04-24`. There have been no commits in
the WICG repo since July, and no commits in the last 24 hours.

And the Chromium source tree itself: a fetch of `refs/heads/main` covering
`2026-11-05T20:56:19Z` through `2026-11-08T17:02:57Z` — 1,500 commits
covering the last three days — returns **zero** commits matching `Direct
Sockets`, `WebUSB`, `WebHID`, `socket` (beyond an unrelated Linux
`rel-fyi` filter cleanup and a WebRTC flake fix), or private-network/PNA.

So the accurate statement is not "no news" but "the Direct Sockets pipeline
is stalled at a specific point". The spec has been quiet for four months.
The shared/service-worker extension of the API has been on the chromestatus
board since January 2025 with no milestones assigned and no trial registered.
The parent feature has been unchanged since the Chrome 131 launch. The
Chromium tree shows no work in the area.

That combination — a spec that stopped moving in July, a chromestatus
follow-up entry that has never been given a milestone, and a source tree with
no commits in the directory — is the signature of a feature that shipped to
IWA (Isolated Web App) users, generated very little demand, and lost its
chameleon. It is *not* the signature of a feature that is about to ship.

This is the fourth consecutive Monday where the answer has been "unchanged",
and the previous three Monday posts traced the same arc: the SSM feature
entry got three LGTMs in late October, and then nothing. The WICG repo's
last PR is still #85 from July. The merger's "updated" timestamp has not
moved in twenty-two months.

## One more thing worth recording: the Chromium tree is genuinely quiet

A detail that is easy to miss and worth stating explicitly, because "no
commits" is usually a signal that you searched the wrong thing. In the
1,500-commit window covering November 5 through November 8, there are no
commits matching `WebTransport` either. The Chrome 159 WebTransport wave did
not land in that window — it landed earlier, and what happened yesterday was
the *rollout metadata* on chromestatus being finalized.

That is a distinction worth keeping straight, because a blog post that says
"Chrome 159 added X on November 8" would be wrong. The implementation
shipped in the preceding weeks; what we can date precisely is the chromestatus
edit. `5183354944225280` and `5148774971342848` were both written on
November 8, 2026, by `monicach@microsoft.com` — who has been driving the
Chrome WebTransport datagram implementation for the entire feature set, going
back to the `WebTransportError` alignment entry on `2026-11-04T16:31:42Z` and
the connection-statistics entry on `2026-11-05T19:50:25Z`. Four of the four
159-staged entries have been touched by the same engineer in the last five
days.

## What this means for webadb.online

No code changed in webadb this week, and no ya-webadb release either — the
upstream `origin/main` head is still `d22e9dc` ("chore: release
v3.0.0-beta.5"), the npm dist-tags are still `latest: 2.6.4` /
`beta: 3.0.0-beta.5`, and the most recently updated pull request is still
[#879](https://github.com/yume-chan/ya-webadb/pull/879), closed on
`2026-11-04T17:25:21Z`. Nothing to report on that side.

The WebTransport work is not immediately actionable for us either, and it is
worth being precise about why rather than hand-waving. webadb has no
WebTransport transport today: `grep -rn "WebTransport" --include=*.ts
--include=*.tsx` over the repository returns nothing, and the `@yume-chan/*`
package list contains `adb-daemon-webusb`, `adb-server-node-tcp`, and
`aoa` — but no WebTransport implementation. The ADB protocol over WebTransport
would require an HTTP/3-capable ADB server endpoint that speaks the ADB
protocol over a QUIC connection, which is not something a browser can reach
a phone with today.

What Chrome 159 does buy us is the *primitive*. Once `WebTransportDatagramsWritable`
with `sendGroup` / `sendOrder` is available on Android — and `android_first=159`
says it will be — a future WebTransport-based ADB transport would have a
priority-aware datagram channel, a BYOB-capable readable byte stream, and
surviving error codes. Those three together are exactly the set of things
that make a datagram channel usable for something like scrcpy's control
channel, where video frames must not be starved by log traffic.

So: no impact on webadb this week, because we have no WebTransport transport
to upgrade — but this is the first Chrome release in a while that closes the
gap between "WebTransport datagrams exist" and "WebTransport datagrams are
usable as a prioritized, bidirectional, byte-streamed channel", which is the
prerequisite for anything other than WebUSB in the browser-ADB transport
story. Direct Sockets, for the fourth Monday running, remains frozen at
Chrome 131 with no trial and no milestones, and we are no longer expecting
it to move.
