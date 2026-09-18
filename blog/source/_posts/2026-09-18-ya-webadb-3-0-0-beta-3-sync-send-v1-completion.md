---
title: ya-webadb v3.0.0-beta.3 — sync send v1 actually waits for the device to ACK before resolving
date: 2026-09-18 01:00:00
tags:
  - ya-webadb
  - release
  - sync
  - push
  - webusb
---

ya-webadb cut [`v3.0.0-beta.3`](https://github.com/yume-chan/ya-webadb/commit/96182a6b) last night (release commit `96182a6b`, Sep 17 21:52 UTC+8). The bump to `3.0.0-beta.3` across the 20-package monorepo is mechanical — what's worth writing down is the single bug-fix that justifies the new tag: [`69fffaf0`](https://github.com/yume-chan/ya-webadb/commit/69fffaf0), Simon Chan + Qingyu Wang, `fix(adb): wait for sync send v1 completion (#869)`. The fix closes a race in `sendV1` (and the un-compressed branch of `sendV2`) where the writable returned to the caller could resolve before `adbd` had actually accepted the bytes — meaning a `.close()` on the upload stream silently lied about success.

This is the single most webadb-relevant upstream change since the `v3.0.0-beta.1` bump that the project is already on. Below: what the bug actually was, the new `DelayedCloseWritableStream` wrapper that fixes it, and the direct implication for webadb's file-upload path.

## What was wrong

`pushBytes` in `lib/adb-client.ts` is webadb's only sync send path; it calls into `@yume-chan/adb`'s `sync.send()` which delegates to either `sendV1` or `sendV2` depending on what `adbd` advertises. The relevant code lives in [`libraries/adb/src/service/sync/request/push.ts`](https://github.com/yume-chan/ya-webadb/blob/69fffaf0/libraries/adb/src/service/sync/request/push.ts).

The contract a sync `SendSession` advertises is straightforward: the `writable` is a `WritableStream`, you write your file body into it, you call `.close()`, and when the close promise resolves the device has acked the upload. Internally that means the stream needs to chain (a) the writer closing its end, (b) the internal pipe draining all bytes into `socket.writeRequest(RequestId.Data, ...)`, and (c) the `OkResponse` from `adbd` confirming the file landed.

The old `sendV1` did this:

```ts
const distributeStream = new DistributionStream(packetSize, true);
const sendStream = new SendWritableStream(pool, socket, mtime);
void distributeStream.readable.pipeTo(sendStream).catch(NOOP);

return {
    writable: distributeStream.writable,
    get bytesWritten() { return sendStream.bytesWritten; },
    ...
};
```

Three things are wrong at once:

1. The returned `writable` is `distributeStream.writable`, **not** the pipe-then-send chain. When the caller calls `.close()` on it, `distributeStream` shuts down its writable side, but the `pipeTo(sendStream)` was already kicked off as a fire-and-forget `void ... .catch(NOOP)` — meaning a rejection on that pipe (which would surface as "device dropped the socket mid-upload", "adbd sent FAIL", etc.) gets swallowed by the `.catch(NOOP)` and never reaches the caller's `await writable.close()`.
2. The `SendWritableStream` itself resolves its `#resolver` only when `readResponse(ResponseId.Ok, OkResponse)` completes — i.e. when `adbd` acks. That promise is what the `pipeTo` waits on. Because the caller's `close()` only awaits `distributeStream.writable.close()`, it doesn't transitively wait for the `pipeTo`.
3. `sendV2`'s un-compressed branch had the same shape: a `MaybeConsumable.WritableStream` wrapper around the distribute-writer whose `close()` only `await writer.close(); await pipe;` — which sounds right, but the `pipe` was a top-level local with no `.catch`, so a rejection on the pipe *before* close also fired as an unhandled rejection.

The user-visible symptom was specific: small file uploads worked. Large file uploads (anything that exceeded the device-side write buffer and forced `sendV1` to actually wait on the response) sometimes resolved with a "success" but the file was truncated on the device, or failed silently while the UI cheerfully reported "Uploaded 12,438,221 bytes" — because `bytesWritten` reflects what we *tried* to send, not what the device acknowledged. For webadb's File Manager "Upload" button, this has been the most likely cause of the rare "I uploaded a file, the panel said success, the file isn't there" reports.

## What changed

The fix is two new pieces plus a refactor of three.

**New: `DelayedCloseWritableStream`** ([`libraries/stream-extra/src/delayed-close-writable.ts`](https://github.com/yume-chan/ya-webadb/blob/69fffaf0/libraries/stream-extra/src/delayed-close-writable.ts), 78 lines, all in this PR). It's a `WritableStream` wrapper that takes a target writable *and* a `Promise<unknown>` representing the downstream work. Its `close()` runs `Promise.allSettled([writer.close(), promise])` — so it now actually waits for both halves of the upload pipeline to finish, and surfaces a clean `AggregateError([closeReason, pipeReason])` when both fail.

The constructor also attaches `void promise.catch(() => {})` to suppress the unhandled-rejection warning when callers don't await the pipe — the long-standing dance for fire-and-forget promises.

**New: `sendV1.spec.ts`** ([`libraries/adb/src/service/sync/request/push.spec.ts`](https://github.com/yume-chan/ya-webadb/blob/69fffaf0/libraries/adb/src/service/sync/request/push.spec.ts), 155 lines). Mocks a `SocketPool` and a `WritableStream` controller for the response, then asserts that closing `sendV1`'s returned `writable` only resolves after `OkResponse` comes back. The reproduction case: write N data chunks, close the stream, and verify the close promise stays pending until the test code enqueues an `OkResponse` into the response controller. Before the fix, `await sendV1.writable.close()` resolved the moment `distributeStream` drained, not the moment the device replied.

**Refactored: `sendV1` and `sendV2`'s un-compressed branch** in `push.ts`. Both now wrap their distributable writer + pipe-to-sendStream chain in `new DelayedCloseWritableStream(...)`. The diff for `sendV1` is the smallest:

```ts
// before — fire-and-forget pipe, returned writable never awaited the response
const distributeStream = new DistributionStream(packetSize, true);
const sendStream = new SendWritableStream(pool, socket, mtime);
void distributeStream.readable.pipeTo(sendStream).catch(NOOP);

return { writable: distributeStream.writable, ... };

// after — wrapper awaits the pipe AND the writer's close
return {
    writable: new DelayedCloseWritableStream(
        distributeStream.writable,
        distributeStream.readable.pipeTo(sendStream),
    ),
    get bytesWritten() { return sendStream.bytesWritten; },
    ...
};
```

`sendV2`'s compression branch gets the same treatment, with an additional `MaybeConsumable.WrapWritableStream` layer around `compressStream.writable` so the `bytesWritten` counter is updated *before* the bytes enter the compressor (matching the previous semantics where `bytesWritten` was un-compressed size).

`SuppressedError` is also used now in `SendWritableStream.#finish` — if a write throws and there's already an in-flight `Ok` or error response, the rejected write error is wrapped in `SuppressedError(e, priorError)` so the caller sees both reasons rather than losing one to a catch-override.

**Drive-by: WebUSB transport** ([`libraries/adb-daemon-webusb/src/device.ts`](https://github.com/yume-chan/ya-webadb/blob/69fffaf0/libraries/adb-daemon-webusb/src/device.ts)). The connection's writable was rebuilt with `pipeFrom(duplex.createWritable(...), new AdbPacketSerializeStream())` — but `pipeFrom` itself was being removed (see below). The replacement uses the same `serializeStream` + `DelayedCloseWritableStream` pattern: the serializer pumps packets into the USB endpoint, and the wrapper ensures `close()` waits for the serializer's tail packet (the zero-length one used to mark end-of-transfer on packet-aligned payloads). For WebUSB this is the same race: a `writable.close()` could resolve before the final zero-packet hit the device, which on some Android kernels means the last chunk gets dropped because the OS hasn't seen the transfer terminator.

**Removed: `pipeFrom`** from `libraries/stream-extra/src/pipe-from.ts` and `index.ts`. It was a small helper that did exactly the pipe-then-return-writable dance the sync-send code was using — and it had the same race. Now that the only callers were rewritten to use `DelayedCloseWritableStream` directly, it's gone. The `index.ts` export shrinks by one symbol.

**Also: `ReadableStream.from` polyfill** in `libraries/stream-extra/src/global/streams.ts` switched from `if (!ReadableStream.from) { ... }` guard to `ReadableStream.from ??= ...`. The previous guard *overwrote* the native `from` even when it existed; the `??=` assignment lets any native implementation win. Same for `ReadableStream.prototype.values` and `Symbol.asyncIterator`. This is in the same PR because the sync-send test file uses `ReadableStream.from` (via the test mock setup) and was getting the wrong behavior on Node 22+ where `ReadableStream.from` is native.

## What this means for webadb.online

The patch is already on npm under the `@3.0.0-beta.3` tag. webadb's `package.json` currently pins `^3.0.0-beta.1` for `@yume-chan/adb`, `@yume-chan/adb-credential-web`, `@yume-chan/adb-daemon-webusb`, and `@yume-chan/stream-extra`. The caret-range means `npm install` against the latest tag will resolve to `3.0.0-beta.3` automatically — the next `npm install` run on webadb.online will pull the fix without a `package.json` edit. The `DelayedCloseWritableStream` is additive (a new export from `@yume-chan/stream-extra`); nothing in webadb's `lib/adb-client.ts` needs to change because the fix lives entirely inside `sync.send()`'s `sendV1` / `sendV2`.

Concretely, the user-visible behaviors this fixes:

1. **File Manager "Upload" finishes accurately.** Today, large uploads can report success while the bytes are still in flight. After upgrade, the progress bar reaches 100% and stays there until the device actually acks. The "Upload" button stays disabled until the close promise resolves. No more silent truncation.
2. **APK install via the AppManager panel** — that path also flows through `sync.send()`. Same race; same fix. APK installs that previously appeared to succeed on a flaky USB connection will now fail loudly (with an `AdbSyncError` from the pipe) instead of appearing to complete while leaving a partial APK on `/data/local/tmp`.
3. **No more unhandled rejection warnings in DevTools** from the `void pipeTo(...)` paths when an upload fails mid-stream. The `DelayedCloseWritableStream` constructor attaches `.catch(() => {})` internally, so the wrapper itself doesn't leak unhandled rejections.

The fix is also a clean example of the project's stance on transport correctness: the PR's title is "wait for sync send v1 completion", not "make sync send v1 usually work" — the bar is that `await writable.close()` must be a *contract* that callers can rely on, not a best-effort signal. That's exactly the contract `lib/adb-client.ts`'s `pushBytes` was already written against; the upstream change just makes the implementation honor it.

**Action item**: when the next webadb dependency refresh runs (no `package.json` edit required), run `npm ls @yume-chan/adb` and confirm it resolves to `3.0.0-beta.3`. If anyone hits a "Upload failed: pipe aborted" in the File Manager after the bump — that *is* the fix working. Previously that error was eaten by `.catch(NOOP)` and the upload silently claimed success.
