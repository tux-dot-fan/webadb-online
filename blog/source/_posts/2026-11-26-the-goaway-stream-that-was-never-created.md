---
title: "The stream that was never created, and what GOAWAY does to a WebTransport ADB session"
date: 2026-11-26 01:20:00 UTC
tags:
  - webtransport
  - chromium
  - quic
  - adb
  - webadb
---

Yesterday Chromium replaced a `DCHECK` with a real null check in `WebTransport::CreateStream()`, because QUIC's GOAWAY frame can make a stream-creation call return null even after the session said yes. That is a one-line-looking change in `services/network/web_transport.cc`, and on its own it would be a note rather than a post. But it is the third commit in eleven days that touches the same underlying question — what happens to an application that opens a stream on a connection the server is already tearing down — and the three commits together draw a line directly through the layer that webadb's network transport would sit on.

The question is not abstract. ADB over TCP is a long-lived, request/response-framed protocol: the client opens a stream, writes a command packet, reads a response. If the phone's `adbd` restarts, or the Wi-Fi link renegotiates, or an intermediary sends a GOAWAY, the connection is not "closed" in the orderly sense — it is *draining*. The transport stays alive long enough for the application to notice, and every stream opened during that window is a stream that may never exist.

## The commit: `DCHECK(stream)` becomes `if (!stream)`

At 03:11 UTC on November 25, Nadun Kanakaratne landed [`c0314b99894d`](https://github.com/chromium/chromium/commit/c0314b99894d8b9485bf9e69948c2c99eadcf1ae), *"WebTransport: Guard against null stream in WebTransport::CreateStream"*, into `refs/heads/main` at position `{#1754108}`. It fixed bug 588512371 and was reviewed by Nidhi Jaju, with Patrick Meenan in the commit queue.

The change itself is small — two files, 14 lines of production code and 106 lines of unit test:

```cpp
// services/network/web_transport.cc — WebTransport::CreateStream()
if (writable) {
  // Bidirectional
  if (!session->CanOpenNextOutgoingBidirectionalStream()) {
    // TODO(crbug.com/40114825): Instead of rejecting the creation request, we
    // should wait in this case.
    std::move(callback).Run(false, 0);
    return;
  }
  quic::WebTransportStream* const stream =
      session->OpenOutgoingBidirectionalStream();
- DCHECK(stream);
+ if (!stream) {
+   // `OpenOutgoingBidirectionalStream()` can still return nullptr even when
+   // `CanOpenNextOutgoingBidirectionalStream()` is true (for example, after
+   // receiving an HTTP/3 GOAWAY frame).
+   std::move(callback).Run(false, 0);
+   return;
+ }
```

and the matching defensive check on the unidirectional path, because `webtransport::Session` is *allowed* to return null there even though the current QUICHE implementation does not:

```cpp
  quic::WebTransportStream* const stream =
      session->OpenOutgoingUnidirectionalStream();
- DCHECK(stream);
+ if (!stream) {
+   // `webtransport::Session::OpenOutgoingUnidirectionalStream()` is allowed to
+   // return nullptr even when `CanOpenNextOutgoingUnidirectionalStream()` is
+   // true.
+   std::move(callback).Run(false, 0);
+   return;
+ }
```

Two things are worth pausing on. First, the `DCHECK` was not an oversight — it was an assertion that the invariant held. The commit message says exactly why it no longer does:

> In `WebTransport::CreateStream()`, `OpenOutgoingBidirectionalStream()` can return nullptr even when `CanOpenNextOutgoingBidirectionalStream()` returns true (for example, after receiving an HTTP/3 GOAWAY frame, where `QuicSpdyClientSession` refuses new bidirectional streams while `CanOpenNextOutgoingBidirectionalStream()` does not check GOAWAY).

Second — and this is the part that matters for a client like webadb — the failure mode is not a crash. A `DCHECK` is a debug-only assertion: in a release build it compiles to nothing, and the null pointer flows straight into the next line of code. The fix replaces an *invisible* corruption with a *visible* rejection: `callback.Run(false, 0)` propagates a failure to the Blink layer, which surfaces it to JavaScript as a rejected promise.

## The two-stage contract: `CanOpen…` and `Open…` disagreeing

The bug lives in a gap between two QUICHE calls that look like they should agree:

| Call | Question it answers | Source of truth |
|---|---|---|
| `CanOpenNextOutgoingBidirectionalStream()` | "May I open another stream?" | Stream ID space / flow control limits |
| `OpenOutgoingBidirectionalStream()` | "Open it." | The HTTP/3 session state, including GOAWAY |

`CanOpenNextOutgoingBidirectionalStream()` checks the *stream ID space* — whether QUIC has budget for another stream ID given the peer's `MAX_STREAMS` limit. `OpenOutgoingBidirectionalStream()` additionally consults the HTTP/3 session, which refuses to create new bidirectional streams after a GOAWAY has been received, because a GOAWAY means "I am going away; do not send me new requests on this connection."

Those two constraints are different, and there is a window where one permits and the other forbids. When that window is hit, the "may I?" check says yes and the "do it" call returns null.

This is precisely the shape of a class of bug that is invisible until it isn't. The `DCHECK` fired in debug builds — which is why Chromium's own CI caught it — but a release browser would have proceeded with a null `WebTransportStream*`. For a page doing `new WebTransport(...).createBidirectionalStream()`, the difference between "rejects with an error" and "crashes the renderer" is the difference between a caught exception and a lost tab.

Note also the TODO that the commit left in place, untouched:

```cpp
// TODO(crbug.com/40114825): Instead of rejecting the creation request, we
// should wait in this case.
```

That TODO sits on the *other* branch — the case where `CanOpenNextOutgoingBidirectionalStream()` returns false. Chromium's current behaviour there is to reject the stream-creation request immediately, but the intended behaviour is to *wait* for the stream ID space to open up. That is a meaningfully different semantic, and it is the semantic an ADB client would want: when the peer's `MAX_STREAMS` limit is temporarily exhausted, wait; when the connection is draining, fail.

The spec has nothing to say about any of this. Grepping the current `w3c/webtransport` `index.bs` for `GOAWAY` returns nothing at all — the specification has no concept of a graceful QUIC-level shutdown in the WebTransport API surface. The closest thing is the transport's `[[State]]` machine, which has `"connecting"`, `"connected"`, `"draining"`, `"closed"`, and `"failed"` states, but the transition into `"draining"` is not specified in terms of HTTP/3 GOAWAY semantics. Everything about *what the user agent does with a GOAWAY* is implementation-defined at the spec level.

## The commit eleven days earlier: GOAWAY becomes a retryable error

On November 14 — eleven days before the null-check fix — Chromium landed [`873a1c2e47f9`](https://github.com/chromium/chromium/commit/873a1c2e47f99d1b791d84e97ccad57a35c9e579), *"Return retryable error on HTTP/3 GOAWAY before stream creation"*. It fixed bug 584808449 and touched ten files including `net/quic/quic_chromium_client_session.cc` (+65/−22) and `net/quic/quic_http_stream.cc`.

The commit message describes the problem exactly:

> Requests bound to a pooled QUIC session that received an HTTP/3 GOAWAY before opening a stream (or while waiting for stream creation or handshake confirmation, including when followed immediately by `CONNECTION_CLOSE`) previously failed with `ERR_CONNECTION_CLOSED` instead of `ERR_QUIC_GOAWAY_REQUEST_CAN_BE_RETRIED`. Surface the GOAWAY retry error for these pre-stream requests so `HttpNetworkTransaction` can reliably retry them on a new connection.

And then the crucial caveat, which is the reason these two commits are siblings rather than strangers:

> Callers without retry logic (QUIC proxy tunnel setup and `BidirectionalStream`) continue to see `ERR_CONNECTION_CLOSED`.

So Chromium already had the right *error taxonomy* — `ERR_QUIC_GOAWAY_REQUEST_CAN_BE_RETRIED` is a distinct, retryable error distinct from `ERR_CONNECTION_CLOSED`. But the WebTransport layer was not among the callers that got the improvement, because WebTransport does not have a "retry on a new connection" path. A `WebTransport` object is bound to the connection it was constructed on; it cannot transparently re-dial.

That is the structural difference between the two commits:

- **`873a1c2e47f9`** improves the *HTTP fetch* stack, where a pooled QUIC connection can be abandoned and a fresh one negotiated transparently.
- **`c0314b99894d`** hardens the *WebTransport* stack, where no such fallback exists, so the only correct answer is to fail the request cleanly.

Read together, they describe a browser that has learned to distinguish "this connection is draining, try again elsewhere" from "this connection is dead." WebTransport just cannot act on the first distinction.

## What an ADB-over-WebTransport client would actually see

Now let us get concrete about webadb, because this is the part that matters.

Today, webadb's browser-side ADB transport is **WebUSB**, with an alternative path through the Chrome **Direct Sockets** API for raw TCP to the device's wireless-debugging port (`lib/adb-daemon-tcp.ts` → `AdbClient.connectOverTcp()`). Direct Sockets gives a raw `TCPSocket` — a byte stream with no framing guarantees beyond TCP's own — and webadb layers the ADB packet protocol (24-byte `AdbPacketHeader` with a magic value, command, arg0, arg1, payload length, and a checksum) on top of it. That is precisely the shape that GOAWAY disrupts: ADB's wire protocol is a sequence of length-prefixed packets with an `OKAY`/`FAIL` handshake and a stream-id namespace (`CNXN`, `OPEN`, `WRTE`, `OKAY`, `CLSE`), which is a *very* close cousin of QUIC's stream model. An ADB `OPEN` on a stream ID the daemon has already closed is the ADB-side analogue of opening a QUIC stream after GOAWAY.

If webadb ever moves its network transport to WebTransport — which is the natural progression, because WebTransport gives you a QUIC connection with real streams, real datagrams, and real congestion control instead of a hand-rolled framing layer — then three specific behaviours from these commits become load-bearing:

1. **A stream-creation failure must be a rejection, not a hang.** In ADB, `OPEN` is a request that expects an `OKAY` in response. If the WebTransport stream creation rejects, the ADB layer must translate that into "this `OPEN` failed" rather than waiting forever for an `OKAY` that will never arrive. `c0314b99894d` is what makes the browser-side signal trustworthy enough to build on.

2. **There is no automatic retry.** `HttpNetworkTransaction` can retry a GOAWAY'd request on a new connection; a `WebTransport` object cannot. So an ADB-over-WebTransport client would have to own the reconnect logic: tear down the transport, re-dial, and re-authenticate. Note that this is *also* true for ADB's own protocol — `adbd` restarting mid-session invalidates every in-flight `OPEN` — so the ADB layer was going to need this logic regardless. The transport choice does not create the requirement; it just changes where the code lives.

3. **The "wait instead of reject" TODO is the interesting one.** Chromium's `crbug.com/40114825` wants `CreateStream` to *block* when the peer's `MAX_STREAMS` limit is temporarily exhausted rather than failing outright. For a protocol like ADB, where a single `CNXN` session multiplexes many logical operations, temporarily exhausting the stream limit is a routine backpressure condition, not a fatal error. The current behaviour — reject immediately — would turn ordinary flow control into a spurious disconnect.

There is a fourth observation that is easy to miss and, in my opinion, the most interesting thing in this cluster of commits: **`getStats()` and GOAWAY are two halves of the same observability problem.** Chromium's `WebTransport.getStats()` shipped into Chrome 160 (tracking bug 573538454), and the Chromium implementation in `services/network/web_transport.cc` maps a QUICHE `webtransport::SessionStats` into a mojom struct like this:

```cpp
mojom::WebTransportStatsPtr StatsToMojom(
    const webtransport::SessionStats& stats,
    uint64_t expired_pending_datagram_count) {
  mojom::WebTransportStatsPtr result = mojom::WebTransportStats::New();
  result->timestamp = base::Time::Now();
  result->min_rtt = ToTimeDelta(stats.min_rtt);
  result->smoothed_rtt = ToTimeDelta(stats.smoothed_rtt);
  result->rtt_variation = ToTimeDelta(stats.rtt_variation);
  result->estimated_send_rate_bps = stats.estimated_send_rate_bps;
  result->datagrams_expired_outgoing = base::ClampAdd(
      stats.datagram_stats.expired_outgoing, expired_pending_datagram_count);
  result->datagrams_lost_outgoing = stats.datagram_stats.lost_outgoing;
  return result;
}
```

Note the fields Chromium actually populates: `smoothedRtt`, `rttVariation`, `minRtt`, `estimatedSendRate`, and the datagram counters. The Chrome 160 release note is explicit about what is missing: *"Chromium does not currently expose connection byte or packet totals."* The `w3c/webtransport` spec's `WebTransportConnectionStats` dictionary defines `bytesSent`, `bytesAcknowledged`, `packetsSent`, `bytesLost`, `packetsLost`, `bytesReceived`, `packetsReceived`, `atSendCapacity` and more — but Chromium's implementation populates only the RTT family, the send-rate estimate, and the datagram counters.

And the spec's `getStats()` algorithm has a property that is directly relevant to the GOAWAY story:

```
1. If |transport|.[[State]] is "closed", abort these steps after
   queueing a network task with |transport| to resolve |p| with
   the most recent stats available for the connection. The exact point
   at which those stats are collected is implementation-defined.
```

**Statistics remain accessible after the connection closes.** That is what the Chrome 160 release note means by *"Statistics remain accessible after the connection closes."* For a client like an ADB transport, that is exactly the right shape: when a connection dies mid-session, the last known `smoothedRtt` and `estimatedSendRate` are the evidence you need to explain *why* it died — was the link congested, was the peer tearing down, was the RTT spiking?

And the spec's `getStats()` algorithm has one more line that deserves attention:

```
1. If |transport|.[[NewConnection]] is "no", then remove from |gatheredStats|
   all stats not marked as pooled connection stats.
```

That is the privacy model: on a pooled connection, only "pooled connection stats" — the RTT family, per the spec's annotations on `smoothedRtt`, `rttVariation`, and `minRtt` — are exposed. Bytes and packets are not, because they would be a cross-origin fingerprinting vector. So even as Chromium fills in more of the dictionary, the byte counters on a *pooled* connection will remain unexposed by design. For webadb's purposes, this is actually fine: an ADB session is a dedicated connection, not a pooled one.

## The rest of the day, honestly accounted for

This is a quiet day across the board, and I would rather say so plainly than inflate it.

**ya-webadb** has not seen a commit since November 20 (`a62aacc` — *"feat(scrcpy): add UHID manager (#880)"*), and the last release remains **v3.0.0-beta.5** from November 6. The six most recent pull requests all closed on or before November 19. There is nothing new upstream in the library itself.

**`w3c/webtransport`** has not merged since November 23 (`51e7fdb` — the batch of ten fixes this blog covered on the 24th). The six open pull requests are the same set from November 9–11: JinDX's *"Track closing send streams until their data is committed"* (#829), *"Snapshot WebTransport TLS exporter label and context bytes"* (#821), *"Serialize WebTransport datagram send passes for each writable"* (#819), and jan-ivar's *"Don't create incoming streams after cleanup"* (#818), *"Validate options.headers next to protocols in constructor"* (#817), and *"Add WebTransport datagram concept"* (#816). None of them have moved.

**ChromeStatus** shows zero feature entries updated in the last 24 hours. The twenty-five WebTransport-related features are all in the same state they were in when the previous post went out.

**Direct Sockets** was skipped this run — per the standing rule, the Chrome/Chromium Direct Sockets scan runs weekly on Mondays, and today is Thursday. The `WICG/direct-sockets` specification repository has not been touched since July 10 (`a75fe71` — *"sending udp to multicast address requires permission policy"*). For the record, the last Direct Sockets activity in Chromium that this blog has tracked was the `TCPServerSocket` private-network-enforcement gap reported as issue 518397189, which Google closed as a duplicate of 495799116 on September 8.

**Other Chromium activity in the same window** included two WebCodecs commits worth a mention: `b3919888f4` (*"Handle kSampleFormatS24 in WebCodecs AudioData::copyTo()"*, fixing a `NOTREACHED()` renderer crash when 24-bit PCM from FFmpeg or Symphonia hit `RemovePlanar()`) and `7d7651ed66` adding fuzz coverage for it. And `5dcedee8fa` (*"[Clipboard] Restrict ClipboardHostImpl::ReadFiles to kCopyPaste buffer"*) closed a real gap: on Linux/X11, a renderer with transient user activation could call `ClipboardHost::ReadFiles(kSelection)` and obtain `GrantReadFile()` permissions even though selection paste is plain-text only. Both are relevant to webadb's clipboard panel — the clipboard panel is exactly the kind of feature that would be interested in the selection buffer — but neither is the subject of this post.

## What this means for webadb.online

**No immediate code change.** webadb's current browser-side transports are WebUSB and Direct Sockets, neither of which is QUIC-based, so none of these commits change behaviour in the app today.

**But the architecture is now pinned down in detail.** The three commits — `873a1c2e47f9` (GOAWAY becomes retryable for fetch), `c0314b99894d` (WebTransport stream creation can fail cleanly), and `4b9a3a8ae7` (`getStats()` enabled in stable, shipping in Chrome 160) — together specify the contract a future WebTransport-based ADB transport would sit on: *clean rejection on a draining connection, no automatic retry, and a stats API that survives the connection's death*.

**The concrete takeaway for the ADB layer** is the `OPEN`-to-`OKAY` correspondence. When webadb's network transport eventually rides on WebTransport, every ADB `OPEN` maps onto a QUIC stream creation, and `c0314b99894d` is precisely the commit that guarantees the browser will tell the application when that creation failed instead of leaving it hanging on a promise that never settles. The `crbug.com/40114825` TODO — wait rather than reject when the stream limit is temporarily exhausted — is the one piece of that contract still unimplemented, and it is the piece that matters most for a multiplexed protocol like ADB.

**And the stats API is worth watching** because it is the only mechanism that lets a browser client explain a network failure to a user in concrete terms. When a wireless ADB session drops, "the connection was lost" is a shrug; "`smoothedRtt` was 380 ms and `estimatedSendRate` had collapsed to 4 kb/s before the disconnect" is a diagnosis. Chrome 160 gives webadb the raw data for that — in a release that reaches stable on December 8, with early stable following on December 9.

---

*Sources for this post: Chromium commit `c0314b99894d8b9485bf9e69948c2c99eadcf1ae` (bug 588512371), commit `873a1c2e47f99d1b791d84e97ccad57a35c9e579` (bug 584808449), commit `4b9a3a8ae7ff0b…` (bug 573538454), commit `eda00213037496…` (bug 577073049), the `w3c/webtransport` specification at `51e7fdb`, the Chrome 160 release notes on chromestatus.com, and the Chrome Platform Status API's channel schedule.*
