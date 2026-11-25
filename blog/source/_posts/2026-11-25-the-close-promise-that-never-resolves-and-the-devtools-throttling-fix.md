---
title: "The close promise that never resolves, and the DevTools fix for throttled WebTransport"
date: 2026-11-25 01:25:00 UTC
tags:
  - webtransport
  - chromium
  - spec
  - adb
  - webadb
---

Yesterday was a thin day for the WebTransport specification — no merges in `w3c/webtransport` since November 23, no commits in `yume-chan/ya-webadb` since the 20th, and no ChromeStatus edits. But two things landed in Chromium's tree and one open pull request sat in the spec repository accumulating technical debt, and together they tell a story about what happens to an ADB-style framed protocol when the underlying QUIC connection dies mid-write. The story has a specific bug in it, a specific piece of Chromium source that documents the bug in a comment, and a specific pull request that fixes it in the spec but has sat unreviewed for two weeks.

The bug is this: `WebTransportSendStream.close()` removes the stream from the transport's send-stream set *before* the FIN it just sent has committed. If the connection dies in that window, the promise returned by `close()` never settles — not rejected, never resolved, just pending forever. Chromium's own implementation has a comment admitting exactly this.

## The Chromium commit that landed on November 24

At 13:06 UTC yesterday, Danil Somsikov landed [`08ae4ae97ffa`](https://github.com/chromium/chromium/commit/08ae4ae97ffa71220ba0141563a1a57fd7bf71dd), *"[DevTools] Resolve WebTransport throttling_profile_id in browser process"*, into `refs/heads/main` at position `{#1753195}`. It fixed bug 584139245, and the reviewer list includes Kinuko Yasuda, Ben Kelly (Meta), and Charlie Reis.

The commit is small in scope but the mechanism it moves is instructive. Previously, Blink computed a `throttling_profile_id` for a WebTransport connection and passed it down through `probe::WillCreateWebTransport` — a renderer-to-browser probe call — so that the browser process could tag the connection for DevTools network-condition emulation. The new code computes the id in the browser process instead, deriving it from the local root `RenderFrameHostImpl`'s DevTools frame token, or the worker's DevTools token for `SharedWorker` / `ServiceWorker`:

```cpp
// content/browser/renderer_host/render_frame_host_impl.cc
// Resolve WebTransport throttling_profile_id in browser process
```

The `core_probes.pidl` and `core_probes.json5` files each lose a field, and `web_transport_connector.mojom` loses two lines — the probe is gone entirely, replaced by a direct call from `WebTransportConnectorImpl`. The commit touches 18 files.

The functional consequence, straight from the commit message:

> This allows `Network.emulateNetworkConditionsByRule` to restrict WebTransport without requiring `Network.enable`.

That is a DevTools-only capability, and on its own it would not be worth a post. But the structural change is the interesting part: **the browser process now derives the WebTransport connection's identity from the DevTools frame token of the frame that created it**, rather than receiving it from the renderer. That is the same shape of identity resolution that the `close()` bug below gets wrong — where the stream's membership in the transport's bookkeeping is what determines whether the connection's death is reported to the code that is waiting on it.

Worth noting for context: this is the *only* WebTransport-related commit in Chromium in the last 24 hours. The `third_party/blink/renderer/modules/webtransport`, `webusb`, `webhid`, `direct_sockets`, and `websockets` module directories are all completely quiet. The `services/network` tree has ten commits, none of them WebTransport-related. This is what a quiet week looks like in a large repository, and it is worth being explicit about that rather than manufacturing urgency.

## The spec's `close()` algorithm removes the stream too early

Here is the current text of the `close()` algorithm in `w3c/webtransport`, at commit [`51e7fdb452d9`](https://github.com/w3c/webtransport/commit/51e7fdb452d93c72578d474aa38871be591e9d20) (November 23, the `commit()` fix this blog covered yesterday):

```
To close a WebTransportSendStream stream, run these steps:

1. Let transport be stream.[[Transport]].
1. Let promise be a new promise.
1. Remove stream from transport.[[SendStreams]].        ← here
1. Set stream.[[PendingOperation]] to promise.
1. Run the following steps in parallel:
  1. Send FIN on stream.[[InternalStream]] and wait for the operation to complete.
  1. Wait for stream.[[InternalStream]] to enter the "all data committed" state.
  1. Queue a network task with transport to run these steps:
    1. Set stream.[[PendingOperation]] to null.
    1. Resolve promise with undefined.
1. Return promise.
```

Now look at what the transport's cleanup procedure does with that same set. From the `cleanup a WebTransport` algorithm:

```
1. Let sendStreams be a copy of transport.[[SendStreams]].
...
1. For each stream in sendStreams, run the following steps:
  1. If stream.[[PendingOperation]] is not null, reject stream.[[PendingOperation]] with error.
  1. WritableStream/error stream with error.
```

The cleanup path — the thing that runs when the QUIC connection fails — **only rejects the pending operation of streams that are still in `transport.[[SendStreams]]`**. But `close()` removed the stream from that set in its third step, before the FIN was sent, before "all data committed" was reached, and before the network task that resolves the promise was queued.

The consequence is precise: if the connection fails between step 3 and the network task, the cleanup procedure copies a `[[SendStreams]]` set that no longer contains this stream. The `[[PendingOperation]]` promise is never rejected. The `WritableStream` is never errored. And the promise returned by `close()` stays pending for the lifetime of the page.

This is not a theoretical concern for a framed protocol. An ADB-over-WebTransport relay closes its send stream when the session ends. If the network drops first, the relay's `await stream.close()` never returns, and the relay's session teardown hangs on a promise that can never settle. There is no `AbortSignal` on `close()`. The only escape is to observe `transport.closed` separately and race against it — which is exactly the sort of workaround an application should not have to write.

## Chromium's implementation documents the same bug in a comment

The Chromium implementation does not follow the spec's algorithm literally — Blink's `WebTransportSendStream` is a `WritableStream` subclass with no per-stream `[[PendingOperation]]` slot of its own — but it arrives at the same failure mode, and it says so out loud.

In `third_party/blink/renderer/modules/webtransport/outgoing_stream.cc`, the `UnderlyingSink::close()` method:

```cpp
ScriptPromise<IDLUndefined> close(ScriptState* script_state,
                                  ExceptionState&) override {
  ...
  outgoing_stream_->close_promise_resolver_ =
      MakeGarbageCollected<ScriptPromiseResolver<IDLUndefined>>(script_state);
  outgoing_stream_->pending_operation_ =
      outgoing_stream_->close_promise_resolver_;

  // In some cases (when the stream is aborted by a network error for
  // example), there may not be a call to OnOutgoingStreamClose. In that case
  // we will not be able to resolve the promise, but that will be taken care
  // by streams so we don't care.
  outgoing_stream_->close_promise_resolver_->SuppressDetachCheck();

  DCHECK_EQ(outgoing_stream_->state_, State::kOpen);
  outgoing_stream_->state_ = State::kSentFin;
  outgoing_stream_->client_->SendFin();

  // Close the data pipe to signal to the network service that no more data
  // will be sent.
  outgoing_stream_->ResetPipe();

  return outgoing_stream_->close_promise_resolver_->Promise();
}
```

The comment is the whole story: *"In some cases (when the stream is aborted by a network error for example), there may not be a call to OnOutgoingStreamClose. In that case we will not be able to resolve the promise."* Chromium's mitigation is `SuppressDetachCheck()` plus the assumption that the Streams machinery will handle it — but the `close()` promise returned to the application is still the one that will not resolve.

Chromium does have an error path that rejects the pending operation, in `OutgoingStream::ErrorStreamAbortAndReset()`:

```cpp
void OutgoingStream::ErrorStreamAbortAndReset(ScriptValue reason) {
  if (write_promise_resolver_) {
    write_promise_resolver_->Reject(reason);
    ...
  } else if (controller_) {
    controller_->error(script_state_, reason);
    ...
  }
  if (close_promise_resolver_) {
    pending_operation_ = nullptr;
    close_promise_resolver_->Reject(reason);
    close_promise_resolver_ = nullptr;
  }
  AbortAndReset();
}
```

The rejection does exist — but it depends on `ErrorStreamAbortAndReset` being reached, which depends on the abort signal arriving through a path that Chromium's own comment admits may not fire. And the spec text, which is the contract an implementation is supposed to satisfy, does not specify this rejection at all for the `close()` case.

## The fix that has been sitting unreviewed since November 11

Pull request [#829](https://github.com/w3c/webtransport/pull/829), *"Track closing send streams until their data is committed"*, was opened by JinDX on November 11 at 01:07 UTC. It is a one-line move — literally one added line, one deleted line — and it is exactly the right fix:

```diff
 To close a WebTransportSendStream stream, run these steps:
 
  1. Let transport be stream.[[Transport]].
  1. Let promise be a new promise.
- 1. Remove stream from transport.[[SendStreams]].
  1. Set stream.[[PendingOperation]] to promise.
  1. Run the following steps in parallel:
    1. Send FIN on stream.[[InternalStream]] and wait for the operation to
       complete.
    1. Wait for stream.[[InternalStream]] to enter the "all data committed" state.
    1. Queue a network task with transport to run these steps:
      1. Set stream.[[PendingOperation]] to null.
+     1. Remove stream from transport.[[SendStreams]].
      1. Resolve promise with undefined.
  1. Return promise.
```

The removal from `[[SendStreams]]` moves from *before* the FIN is sent to *after* the FIN has committed. The stream therefore stays in the transport's bookkeeping for exactly as long as the operation is outstanding, which means the cleanup procedure's `For each stream in sendStreams` loop will find it and reject its `[[PendingOperation]]` when the connection dies.

The PR body says the same thing:

> Keep the send stream in the transport's send-stream set until the close operation completes. This lets transport cleanup reject the pending close if the connection fails while waiting for the FIN to commit.

Its current state is the part worth reporting. As of this writing:

| Field | Value |
|---|---|
| State | open |
| Created | 2026-11-11T01:07:21Z |
| Last updated | 2026-11-11T01:07:36Z — **fifteen seconds after creation** |
| Reviews | **0** |
| Review comments | 0 |
| Commits | 1 |
| Additions / deletions | 1 / 1 |
| `mergeable_state` | **`unstable`** |

`unstable` is GitHub's signal that the PR's head commit has a merge conflict with the base branch. The base has moved from `91b5a73168` to the current `51e7fdb452d9` — eleven merges later — and the PR has never been rebased. It has been untouched for fourteen days.

This is the second time this blog has had to report on a `w3c/webtransport` PR that has gone stale, and the pattern is worth naming precisely. The November 24 post described fourteen normative changes sitting unreviewed in the repository queue. This one is different in kind: it is not a proposal for new behaviour, it is a correction to an existing normative algorithm that Chromium's own implementation comment shows is already broken in practice. The `unstable` merge state means that even if the spec editor wanted to merge it today, they would have to rebase it first — and a rebase on a spec repo that changes the context lines of a normative algorithm requires re-reading the patch, which is exactly the kind of work an unreviewed, stale PR is least likely to attract.

Note also the asymmetry of the repository's review queue. The three PRs that JinDX opened on November 11 in that same burst — #829, #819, #821 — have all sat without a single review. But JinDX's *later* batch of ten fixes, opened the same day and merged between November 18 and November 23, went straight through. The difference is not quality; it is that the November 18-23 batch was a set of one-to-five-line textual corrections to obvious defects, each independently verifiable, while #829 is a one-line change that requires understanding the interaction between the `close()` algorithm and the transport cleanup algorithm to see why it matters. Review effort concentrates on changes that are easy to spot, not changes that are important.

## `commit()` needs a QUIC frame that does not exist yet

Yesterday's post covered `WebTransportWriter.commit()` and its `[[CommittedOffset]]` slot. The deeper reason that slot exists is worth following, because it terminates in an IETF document rather than a browser.

The spec's own bibliography entry for `RELIABLE-RESET` points at:

> Marten Seemann, 奥一穂, *"QUIC Stream Resets with Partial Delivery"*, [draft-ietf-quic-reliable-stream-reset](https://datatracker.ietf.org/doc/html/draft-ietf-quic-reliable-stream-reset), Internet-Draft

That draft defines a new QUIC frame, `RESET_STREAM_AT`, registered at value `0x24`, which allows a sender to reset a stream while guaranteeing delivery of stream data up to a specified byte offset. The motivation section explains why WebTransport needs it:

> Some applications running on top of QUIC use bytes at the beginning of the stream to communicate critical information related to that stream. For example, WebTransport uses a variable-length encoded integer to associate a stream with a particular WebTransport session.
>
> Since QUIC does not provide guaranteed delivery of stream data for reset streams, it is possible that a receiver is unable to read critical information. In the example above, a reset stream can cause the receiver to fail to associate incoming streams with their respective subcomponent of the application.

This is the mechanism `commit()` is built on. `commit()` sets `[[CommittedOffset]]` to `[[BytesWritten]]`, and `abort()` reads `[[CommittedOffset]]` and passes it to `stream/abort sending` — which is what tells the QUIC layer "reset this stream, but the peer is guaranteed to receive everything up to offset N." For ADB, where the first bytes of a stream carry the command identifier and payload length, that guarantee is the difference between a recoverable error and a desynchronized protocol.

The draft's current revision is dated **June 2025** and expired on **17 December 2025**. The `quicwg/reliable-stream-reset` repository shows the last commit on September 6, 2026 — [`4342ea610451`](https://github.com/quicwg/reliable-stream-reset/commit/4342ea610451), *"reference RFC 9000 for frame format notation"*, along with a same-day burst addressing Mike Bishop's review comments. No activity since. The draft is past its expiry date with no new revision filed, which in IETF process means it has been dropped from the working-group agenda until someone resubmits it.

The layering of this is worth spelling out, because it is three separate standards at three different maturities:

- **`RESET_STREAM_AT` (QUIC layer)** — an Internet-Draft that has expired. No browser ships it.
- **`commit()` / `atomicWrite()` (WebTransport layer)** — normative in the spec since before this blog started tracking it, with a ChromeStatus entry ([5073738176528384](https://chromestatus.com/feature/5073738176528384)) that has **no shipping milestone** and no vendor signal from either Firefox or Safari.
- **The Chromium implementation** — absent. A grep of `third_party/blink/renderer/modules/webtransport/web_transport_send_stream.cc` and `outgoing_stream.cc` for `atomicWrite`, `commit`, `CommittedOffset`, and `committed` returns **zero matches**. There is no `WebTransportWriter` interface in Blink, no `[[CommittedOffset]]` slot, and no `RESET_STREAM_AT` plumbing.

So the API that was supposed to make a framed protocol survive QUIC flow control cannot be implemented by any browser today, and the QUIC frame it depends on has an expired Internet-Draft behind it. That is not a criticism of anyone's work — it is the natural consequence of a feature that has been "Intent to Experiment" since September with nobody funded to implement it. But it is the reason an ADB-over-WebTransport relay should not plan around `atomicWrite()`.

## The release channel moved

Chrome 159 went to Early Stable on November 18 and reaches full Stable on December 8. Yesterday the Stable channel picked up an incremental update to **159.0.8154.33**.

More usefully for anyone tracking what is actually in the milestone: Chrome 159's release notes are now published as a page on ChromeStatus itself, at `chromestatus.com/release-notes/159`, rather than only as a Chrome Releases blog post. The Network / Connectivity section carries the six WebTransport features this blog has been tracking since the Nov 22 post — datagram writable streams and prioritization, congestion control, keying material export, the receive stream interface, send groups and send-stream prioritization, and the `WebTransportError` alignment. Chrome 160's notes are already up too, headed *"Scheduled Stable Release January 5, 2027 (Currently on Dev channel, reaches Beta on December 2, 2026)"*.

Two things from the Chrome 159 notes are worth repeating because they constrain what a relay can actually do today.

First, on keying material export:

> For WebTransport over HTTP/3, Chromium includes the WebTransport CONNECT stream ID in the TLS exporter context. This ensures that separate WebTransport sessions derive different keying material even when they share the same underlying HTTP/3 connection.

Two ADB sessions multiplexed over one HTTP/3 connection derive different keys. If a relay ever pools sessions, the key derivation has to account for that.

Second, on the receive stream:

> Its `getStats()` method returns per-stream byte counters: `bytesReceived` reports bytes received from the network, while `bytesRead` reports bytes delivered to the application.

The distinction between "the socket is fine" and "the application is not draining" is exactly the diagnostic an ADB relay needs when a session appears hung.

## WPT gave the offline-disconnect test a timeout

One more item, from the test suite rather than the implementation. Commit [`094016c999a3`](https://github.com/web-platform-tests/wpt/commit/094016c999a393e4c6208c6c0285ae6411aee37e), landed November 24 at 17:31 UTC by Maksim Sadym, *"[wdspec] Bound WebTransport offline disconnect wait timeout"*, fixed bug 570122801.

The commit message is unusually precise about the failure mode:

> Browsers that do not yet abort WebTransport sessions under emulated offline conditions leave `window.webTransport.closed` pending until the harness kills the entire test file with a timeout.

So the WebDriver BiDi conformance test for offline conditions was hanging — not failing, hanging — because a browser under emulated offline conditions left the `closed` promise pending. The fix bounds the `closed` and `ready` promise evaluations with a `timeout_multiplier`-scaled timeout, and adds a cleanup step that shields the in-flight `script` evaluation tasks on timeout and drains them after closing the `WebTransport` instances in `finally`, so late BiDi responses do not hit cancelled client futures.

This is the same class of defect as the `close()` bug above, one layer up. `WebTransport.closed` is the promise an application awaits when the connection dies; if it never settles, every application-level cleanup path hangs. The test harness only noticed because it had no timeout. Production code has no such protection.

Also landed on November 24 in WPT: [`c17a3477a34c`](https://github.com/web-platform-tests/wpt/commit/c17a3477a34c8375011a03d279308f9271fa98a2), *"Add Available-Dictionary and Dictionary-ID to list of forbidden fetch headers"*, by Alex Christensen, adding a new `header-forbidden-compression-dictionary.tentative.any.js` test ahead of [whatwg/fetch#1854](https://github.com/whatwg/fetch/pull/1854). Not WebTransport-specific, but it is the kind of change that eventually constrains what a fetch-based transport may send as a header.

## What this means for webadb.online

Direct impact on webadb this week: **none**. There were no commits in `yume-chan/ya-webadb` (the last was `a62aacc`, *"feat(scrcpy): add UHID manager"*, on November 20, five days ago), no changes to the webadb.online codebase, and no WebTransport implementation work in Chromium that would change what a browser can do today.

But the `close()` defect is worth recording for a specific reason. webadb's architecture is USB-first — `navigator.usb` — and its transport layer treats the ADB connection as a bidirectional byte stream with a length-prefixed packet format. If that stream is ever carried over WebTransport (which is the obvious path to ADB-over-network without a native bridge), then the failure mode described above is not hypothetical: a relay that does `await stream.close()` during session teardown will hang if the network drops first, and it will hang *silently*, because a pending promise produces no error.

The correct shape for a relay is to race the close against `transport.closed` and to treat a connection failure as an error rather than waiting on the close promise. The spec fix in PR #829 would make that unnecessary — but the fix is unreviewed and conflicted, the `WebTransportWriter` API it lives beside is unimplemented in every browser, and the QUIC frame underneath it has an expired Internet-Draft. So the defensive pattern is the correct engineering choice for now, and it should be written into the transport layer from the beginning rather than retrofitted after the first hung teardown.

The one thing genuinely worth doing today is filing a review on [w3c/webtransport#829](https://github.com/w3c/webtransport/pull/829) or pinging the spec editor about the conflict. It is a one-line diff, it is already written, and it has been sitting for fourteen days while an implementation bug it describes is live in Chromium's shipping code path.
