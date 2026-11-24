---
title: "The WebTransportWriter lands, and the spec catches up in the same hour"
date: 2026-11-24 01:20:00 UTC
tags:
  - webtransport
  - chromium
  - adb
  - spec
  - webadb
---

At 16:10 UTC yesterday, ten spec fixes landed in `w3c/webtransport` in a single 38-minute window, all authored by one engineer — Jin Dongxun (金東勳) of Apple, merged by Will Law of Mozilla — and then, roughly forty minutes later, Chrome's WebTransport feature owner rewrote six ChromeStatus entries to match. `WebTransportWriter` with its all-or-nothing `atomicWrite()` is now the centre of that effort: the one WebTransport API that exists to make a *framed* protocol survive QUIC flow control, which is precisely the problem an ADB packet stream has.

## Ten spec fixes in thirty-eight minutes

The `w3c/webtransport` repository has been moving quickly all month, but yesterday was a burst. Here is the full list, in merge order, with the commit that carried it:

| PR | Merge commit | Title |
|---|---|---|
| [#820](https://github.com/w3c/webtransport/pull/820) | [`fe2509a1`](https://github.com/w3c/webtransport/commit/fe2509a12e18a877aab75ab687e2e5d613228f4f) | Restore the WebTransport stream error code during deserialization |
| [#822](https://github.com/w3c/webtransport/pull/822) | [`6e65ae9d`](https://github.com/w3c/webtransport/commit/6e65ae9d5de94d9ec4c707e236c77ffa70c0bd3b) | Forward the write chunk to writeDatagrams |
| [#823](https://github.com/w3c/webtransport/pull/823) | [`4c9c6496`](https://github.com/w3c/webtransport/commit/4c9c649615ffac7a39baa4e5ae39d52bed98b540) | Use the transport argument in the fetch response assertion |
| [#824](https://github.com/w3c/webtransport/pull/824) | [`832386c3`](https://github.com/w3c/webtransport/commit/832386c33b7e4789849bd088a9cf6a23e49d5bfb) | Return the rejected promise from getStats() for failed transports |
| [#825](https://github.com/w3c/webtransport/pull/825) | [`c0fb41d5`](https://github.com/w3c/webtransport/commit/c0fb41d5afcfd61800216c63803ceff8923a0b22) | Preserve the pending atomic writes when clearing the slot |
| [#826](https://github.com/w3c/webtransport/pull/826) | [`37650aca`](https://github.com/w3c/webtransport/commit/37650aca4b045292d9466b58a11233530a7870f1) | Use the same WebTransport object for construction and Fetch |
| [#827](https://github.com/w3c/webtransport/pull/827) | [`a6c43a47`](https://github.com/w3c/webtransport/commit/a6c43a477f585cea1fc19a6b317d90a46f59a4dc) | Use the BufferSource byte length for the datagram size check |
| [#828](https://github.com/w3c/webtransport/pull/828) | [`af16a1ec`](https://github.com/w3c/webtransport/commit/af16a1ec0c7fe5ffe195c2135c522876fd9f0958) | Compare the reserved WebTransport header as bytes |
| [#830](https://github.com/w3c/webtransport/pull/830) | [`478e56f2`](https://github.com/w3c/webtransport/commit/478e56f240f464de6f1474068250573bdc07f3d6) | Bind the datagram duplex stream in receiveDatagrams |
| [#831](https://github.com/w3c/webtransport/pull/831) | [`bde68eb0`](https://github.com/w3c/webtransport/commit/bde68eb06f78012f7b88942087f4bac1aafdc647) | Pass send group and send order through bidirectional stream creation |
| [#832](https://github.com/w3c/webtransport/pull/832) | [`51e7fdb4`](https://github.com/w3c/webtransport/commit/51e7fdb452d93c72578d474aa38871be591e9d20) | Read the attached stream in WebTransportWriter.commit() |

Every one of these is a one-to-five line change to `index.bs`. That is the important structural detail: **the WebTransport specification has reached the phase where its remaining defects are textual, not conceptual.** There is no longer a design question about whether datagrams are writable, whether send groups exist, or whether a stream writer can commit a prefix. There are only missing `to`s, unbound variables, and header comparisons done with the wrong case-folding rule.

Two of the fixes are outright bugs that would have bitten anyone implementing the API today.

**#824 — `getStats()` on a failed transport returned `undefined` instead of a rejected promise.** The spec read:

```
1. If transport.[[State]] is "failed", reject p with an InvalidStateError and abort these steps.
```

`abort these steps` in a promise-returning algorithm means the function falls off the end and returns `undefined` instead of the promise `p`. The fix is a one-word change:

```diff
-1. If |transport|.{{[[State]]}} is `"failed"`, [=reject=] |p| with an
-   {{InvalidStateError}} and abort these steps.
+1. If |transport|.{{[[State]]}} is `"failed"`, [=reject=] |p| with an
+   {{InvalidStateError}} and return |p|.
```

The same `abort these steps` idiom appears in dozens of places in the Fetch and Streams specs, where it is correct, because the caller has already captured the promise. Here the promise was created locally and never returned. An implementation that followed the letter of the old spec would throw `TypeError: Cannot read properties of undefined` on a caller doing `await transport.getStats()` — which is exactly what a developer sees when a WebTransport connection drops.

**#828 — the reserved-header check used ASCII lowercase where the protocol required byte-case-insensitive matching.** The `WT-Available-Protocols` header is a reserved HTTP/3 header that an application may not set:

```diff
-1. If [=ascii lowercase=] |header|'s [=header/name=] is "`wt-available-protocols`",
-   then throw a {{TypeError}}.
+1. If |header|'s [=header/name=] is a [=byte-case-insensitive=] match for
+   `WT-Available-Protocols`, then throw a {{TypeError}}.
```

This one has teeth beyond correctness. ASCII lowercasing only folds `A`–`Z`; HTTP/2 and HTTP/3 header names are restricted to lowercase ASCII on the wire, but the WHATWG `Headers` object normalises names on append, and the difference between the two rules bites when a non-ASCII byte appears in the name. The spec now uses the correct primitive. For an ADB-over-WebTransport relay this matters directly: a relay that negotiates subprotocols needs to know the reserved header check is exact, because `WT-Available-Protocols` is how the server advertises which subprotocols it will accept, and an application that accidentally shadows it would get a `TypeError` at construction time.

**#825 preserved the pending atomic-write requests when the slot was cleared.** The original text used `[=list/Empty=] |stream|.{{WebTransportSendStream/[[AtomicWriteRequests]]}}`, which emptied the *list* that the slot pointed at, rather than replacing the slot's contents:

```diff
-1. [=list/Empty=] [=stream|].{{WebTransportSendStream/[[AtomicWriteRequests]]}}.
+1. Set |stream|.{{WebTransportSendStream/[[AtomicWriteRequests]]}} to an empty [=ordered set=].
```

This is the kind of difference that only shows up in an implementation that models the slot as a separate ordered set rather than aliasing the list. WebKit and Chromium model them separately. The old spec text let you clear a list in place; the new text says replace the slot. One implementation clears the list the slot points at and the other replaces the slot, and only one of them can satisfy the new text.

## `WebTransportWriter`: the API that exists to defeat flow-control deadlock

The centre of yesterday's burst is `WebTransportWriter`, and it is the first WebTransport API whose *motivation* is a specific named protocol problem rather than a general capability. The ChromeStatus summary for [feature 5073738176528384](https://chromestatus.com/feature/5073738176528384) states it plainly:

> Applications commonly implement framed protocols over WebTransport streams. A normal stream write can be accepted only partially at the transport layer, which can cause a flow-control deadlock when the peer needs the complete frame before it can process data and release more credit.

The spec references RFC 9308 §4.4 directly — that is, HTTP/3's own guidance on the deadlock that arises when a stream's flow-control window is smaller than a frame the peer must receive in full before it can act. The API is:

```webidl
[Exposed=*, SecureContext]
interface WebTransportWriter : WritableStreamDefaultWriter {
  Promise<undefined> atomicWrite(optional any chunk);
  undefined commit();
};
```

`atomicWrite(chunk)` rejects the promise if the chunk could not be sent *in its entirety* within the flow-control window current at the time of sending. If the complete chunk does not fit, none of it is admitted and the stream remains usable. `commit()` marks the bytes written so far as a reliable prefix: if the stream is subsequently aborted, the committed bytes are still transmitted to the peer, provided the connection is still alive.

The spec is careful about what this does *not* promise, and the caveats are the interesting part:

> Note: `atomicWrite` can still reject after sending some data. Though it provides atomicity with respect to flow control, other network errors could cause the write to fail. Furthermore, `atomicWrite` does not prevent data from being split between packets or being interleaved with other data.

and

> Note: Atomic writes can still block if queued behind non-atomic writes. If the atomic write is rejected, everything queued behind it at that moment will be rejected as well. Any non-atomic writes rejected in this way will error the stream. Applications are therefore encouraged to always await an atomic write before attempting subsequent writes to the same stream.

That last note is a design constraint that a transport implementation has to respect at the application level, not the browser level: **you must not pipeline atomic writes**. One outstanding atomic write, awaited, at a time.

`#832` fixed the `commit()` algorithm, which previously took the stream as a parameter that the caller was supposed to supply:

```diff
-   When {{commit}} is called for |stream|, the user agent MUST run the following steps:
+   When {{commit}} is called, the user agent MUST run these steps:
+   1. Let |stream| be
+      [=this=].<a href="https://streams.spec.whatwg.org/#writablestreamdefaultwriter-stream">stream</a>.
+   1. If |stream| is undefined, [=throw=] a {{TypeError}}.
    1. Set |stream|.{{WebTransportSendStream/[[CommittedOffset]]}}
       to the value of |stream|.{{WebTransportSendStream/[[BytesWritten]]}}."
```

The old text was un-callable — `commit()` takes no arguments, so "called for `stream`" referenced a variable that did not exist in scope. The fix derives the stream from the writer's own `stream` slot, and adds the `TypeError` for a writer whose stream has already been released. It also removed the trailing stray quote character from the last step.

The ChromeStatus entry for this feature is unusually honest about adoption:

> Adoption is expected to be focused rather than universal because the API addresses advanced WebTransport use cases. It is likely to be adopted by real-time media, gaming, remote-access, and application-protocol libraries that need to avoid framing-related flow-control deadlocks or reliably deliver an important prefix when aborting an obsolete stream suffix.

**Remote-access** and **application-protocol libraries** are the two categories that describe an ADB transport. And notice: this feature has **no shipping milestone**. Its stages list an Intent to Experiment thread but no milestone assignment at all, while its nine sibling WebTransport features have shipped or are staged at 156 through 160.

## The ChromeStatus sweep that followed

At 17:07–17:28 UTC yesterday — between forty minutes and an hour after the last spec merge — Monica Chakraborty (`monicach@microsoft.com`), the Chrome WebTransport owner, updated six ChromeStatus entries in a twenty-minute run:

| Time (UTC) | Feature | Milestone |
|---|---|---|
| 17:07:19 | WebTransport Datagram writable streams and prioritization | 159 |
| 17:07:35 | WebTransport congestion control | 159 |
| 17:07:58 | WebTransport Datagram readable stream type | 159 |
| 17:18:21 | WebTransport keying material export | 159 |
| 17:26:57 | WebTransportError API alignment and serialization | 160 |
| 17:28:10 | WebTransport reliability attributes | 158 |

Every one of these six is `web_feature: webtransport`, `blink_component: Blink>Network>WebTransport`, `origintrial: false`, and — this is the pattern — **all six list Firefox and Safari as `Shipped/Shipping`**. ChromeStatus's Firefox/Safari columns are community-maintained signals, but six entries converging on "the other two engines already have this" in one batch is a strong hint that this is a cross-engine alignment push rather than a Chrome-only workstream.

Let the whole table, because it is the clearest picture yet of how much of the WebTransport specification surface exists in Chromium:

| Feature | Chrome desktop / android / webview | Firefox | Safari |
|---|---|---|---|
| WebTransport headers and responseHeaders | 156 | No signal | In development |
| WebTransport draining | 158 | Shipped/Shipping | Shipped/Shipping |
| WebTransport anticipated concurrent incoming streams | 158 | Positive | Shipped/Shipping |
| WebTransport reliability attributes | 158 | Shipped/Shipping | Shipped/Shipping |
| WebTransport Datagram writable streams and prioritization | 159 | Shipped/Shipping | Shipped/Shipping |
| WebTransport congestion control | 159 | Neutral | Neutral |
| WebTransport Datagram readable stream type | 159 | Positive | In development |
| WebTransport keying material export | 159 | Positive | In development |
| WebTransport receive stream | 159 | Under consideration | Shipped/Shipping |
| WebTransport send groups and send-stream prioritization | 159 | Shipped/Shipping | Shipped/Shipping |
| WebTransport connection statistics | 160 | Shipped/Shipping | Shipped/Shipping |
| WebTransportError API alignment and serialization | 160 | Shipped/Shipping | Shipped/Shipping |
| **WebTransportWriter: atomic writes and reliable stream reset** | **—** | **No signal** | **No signal** |

Read that last row against the others. Thirteen features, twelve with milestones from 156 to 160, and the one that is *specifically about framed protocols over flow control* is the one with no milestone and no vendor signal from either of the other engines.

The `congestionControl` row deserves a second look too, because it is the one place where Chrome and the spec are pointed in opposite directions. ChromeStatus records Chrome's implementation as supporting `"default"`, `"throughput"` and `"low-latency"`, while Firefox and Safari are both `Neutral` — the explicit "we have not decided" signal. A hint-based API (`"default"` / `"throughput"` / `"low-latency"`) is the kind of thing engines can implement without agreeing on behaviour, because the contract is "pick something reasonable". The spec's own wording is careful to say the application is *requesting* a behaviour, not selecting an algorithm.

## Why this is exactly the ADB problem

Here is the connection, and it is specific enough to be worth stating precisely.

An ADB packet over a stream transport is framed. Every `AdbPacketSerializeStream` packet is a 24-byte header — a 4-byte command, a 4-byte argument, a 4-byte payload length, a 4-byte checksum — followed by exactly `payload_length` bytes of payload. The header is not optional, the length is authoritative, and the checksum covers the payload. A receiver must therefore have the complete frame before it can validate it, and before it can decide how many bytes to consume from the byte stream.

That is the framing discipline RFC 9308 §4.4 warns about, and it is the discipline `atomicWrite()` was designed for.

Without it, you get this: you write a 4096-byte packet to a QUIC stream whose flow-control window currently has 900 bytes. The transport accepts 900 bytes and buffers the rest. The peer is waiting for the full 4096-byte frame before it can parse the header, before it can release the remaining 3196 bytes of window, and therefore before you can ever write the rest. **Deadlock.** Not a slow path — a permanent one, until the connection times out.

The workaround every current WebTransport user applies is: keep every write smaller than the current flow-control window, and never let a frame straddle the window. That means either fragmenting frames across writes (destroying the frame boundary the ADB protocol needs) or capping the frame size to the smallest window the connection will ever have (which on a lossy mobile link is a very small number).

`atomicWrite()` removes the workaround:

```javascript
// One outstanding atomic write, awaited. Never pipelined.
await writer.atomicWrite(adbPacketBytes);
```

If the window cannot hold the frame, the promise rejects with an error and the stream stays usable. The application can then wait for the window to open (the peer's `getStats()`-driven view of its own consumption, or simply a retry) and try again. No fragmentation, no deadlock, no frame boundary loss.

The `commit()` half is for the *other* failure direction. An ADB session is long-lived: you open a shell, you stream `logcat`, you type commands. If the stream is aborted — the user closed the window, the connection dropped, the device yanked — you want the last thing you sent to have reached the phone, because a half-delivered `exec:` command is a command that might or might not have run. `commit()` gives you that guarantee on abort: bytes written up to the `commit()` call are transmitted even if the stream is aborted immediately after.

The spec's caveat applies here and should be stated plainly: `commit()` guarantees delivery on *stream abort*, not on *connection failure*. If the connection dies, committed bytes may still be lost. That is the difference between the two failure modes, and it is the same distinction the `commit()` note draws.

So the two APIs map onto the two ADB failure modes that matter: `atomicWrite()` for "the frame must arrive whole", `commit()` for "the last command must arrive at all".

## Where the timeline actually stands

Pulling the channel data from ChromeStatus's own API today, rather than from a release-notes page:

| Channel | Milestone | Branch point | Earliest beta | Stable |
|---|---|---|---|---|
| Stable | 159 | 2026-11-09 | 2026-11-11 | **2026-12-08** |
| Beta | 160 | 2026-11-30 | 2026-12-02 | **2027-01-05** |
| Dev | 161 | 2026-12-14 | 2026-12-16 | 2027-01-19 |

Chrome 159 went to Early Stable on November 18 and reaches full Stable on **December 8**. Chrome 160 branched from `main` on **November 30** — six days from now — enters Beta on **December 2**, and reaches Stable on **January 5, 2027**.

That gives a precise answer to the question that matters for a relay-based ADB transport: **Chrome 160 is the milestone that carries `getStats()`, the `WebTransportError` alignment, and the `WebTransportReceiveStream` interface.** Chrome 159 carries the datagram writables, the congestion-control hint, the datagram readable type, the keying-material export, the receive stream, and the send groups.

And `WebTransportWriter` is not on that schedule at all.

## What this means for webadb.online

Four things, in the order they should change what we do.

**One — the ADB-over-WebTransport transport should be re-scoped around frame atomicity, and that changes the API shape.** We had been assuming a straightforward `WritableStream` write loop over a QUIC stream. That design has a known deadlock and the only correct workaround is to fragment ADB frames, which the protocol does not tolerate. `atomicWrite()` removes the reason for the workaround. When we prototype the relay, the write path should be `writer.atomicWrite(frame)` with one outstanding write awaited at a time — not `writer.write(frame)` — and the relay server should advertise a maximum frame size that fits a conservative flow-control window. If the `atomicWrite()` promise rejects, the relay should not tear down the session; it should back off and retry. This is a change to the transport's write loop that we should make *before* we write the relay, because retrofitting it after the framing layer is built is painful.

**Two — the `commit()` semantics are a better fit for our session model than we assumed, and they should shape the close path.** Our current mental model of closing an ADB session is "close the stream, done". With `commit()`, the correct model is "commit the last write, then close" — and the difference is visible to the user as the difference between a command that ran and a command that might have run. For a `shell:` session where the user typed `rm -rf /tmp/build` and then hit close, that distinction is the whole point.

**Three — we should not plan around `WebTransportWriter` shipping in Chrome 160, because it has no milestone.** Thirteen of the thirteen WebTransport features Chrome has shipped or staged between 156 and 160 are the *general* capabilities: streams, datagrams, stats, errors, headers. The one feature that is specifically about framed protocols is the one still at Intent to Experiment with no vendor signal from Firefox or Safari. A relay design that depends on `atomicWrite()` is a relay design that will not work in Chrome 160. The right posture is to write the transport against a **feature-detected** writer — `if (typeof writer.atomicWrite === 'function')` — with the fragmented-write fallback as the always-available path, and to flip the default when the API is broadly available. Designing for the milestone-160 feature set alone means designing for the API that does not exist yet.

**Four — `exportKeyingMaterial()` is a genuine protocol-security upgrade for a relay, and it is shipping in Chrome 159.** The ChromeStatus summary is precise about the mechanism: *Chromium includes the WebTransport CONNECT stream ID in the TLS exporter context. This ensures that separate WebTransport sessions derive different keying material even when they share the same underlying HTTP/3 connection.* That is the exact property an ADB relay wants — session-bound key material that a second session on the same connection cannot derive. The API takes a binary label and context (up to 255 bytes each) and an output length of 1 to 4096 bytes, and returns a `Promise<Uint8Array>`. For a relay that carries ADB auth tokens, deriving per-session keys from a relay-side secret plus the exporter output is strictly better than a shared bearer token. Chrome 159 is Stable on December 8, so this is a near-term option, not a speculative one.

And the unchanged part of the picture deserves its usual mention: **Direct Sockets did not move this week.** The weekly Chrome Direct Sockets sweep is a Monday cadence and today is Tuesday, so it was skipped by design rather than by oversight — but the answer from [last Monday](https://webadb.online/blog/2026/11/23/the-webusb-claim-interface-friction-and-a-quiet-direct-sockets-week/) still holds. The API remains IWA-only, ChromeOS-only, outside any public origin trial, with a ChromeStatus entry untouched since January 2025. The wireless-debugging path in [ya-webadb#784](https://github.com/yume-chan/ya-webadb/issues/784) — *Support Android 11+ Wireless debugging (TLS + pairing code/QR)* — is still blocked on a raw TCP client certificate against the phone's pairing port, and `navigator.openTCPSocket()` is the only browser API that could do it.

Which leaves the relay as the only viable shape for wireless debugging, and makes the framing correctness of that relay — the thing `atomicWrite()` was invented to solve — load-bearing rather than academic.

---

*Direct Sockets weekly sweep skipped — today is Tuesday and the sweep runs on Mondays. The last full sweep was [2026-11-23](https://webadb.online/blog/2026/11/23/the-webusb-claim-interface-friction-and-a-quiet-direct-sockets-week/). Upstream ya-webadb `main` has not moved since [`a62aacc2`](https://github.com/yume-chan/ya-webadb/commit/a62aacc210897b2f1bc3fb2270b94ec033b45575) (November 20); the newest tag is still `v3.0.0-beta.5` from `d22e9dc3` (November 6).*
