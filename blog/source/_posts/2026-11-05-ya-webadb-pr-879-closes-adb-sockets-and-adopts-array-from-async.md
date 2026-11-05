---
title: "ya-webadb learns to close its sockets properly, and adopts Array.fromAsync"
date: 2026-11-05 01:00:00 UTC
tags:
  - ya-webadb
  - adb
  - streams
  - webadb
  - webusb
---

ya-webadb merged a 585-line refactor yesterday that does something it should
have done a long time ago: when you cancel the readable side of an ADB daemon
socket, it now actually tells adbd to close the connection, by sending an
explicit `CLOSE` packet. The commit is `0c68ad2f`, PR
[#879](https://github.com/yume-chan/ya-webadb/pull/879), merged at
`2026-11-04T17:25:18Z`. In the same PR the library picks up
`Array.fromAsync` (with a hand-written fallback for engines that lack it),
rewrites the Node.js TCP transport to use `node:stream`'s own web-stream
adapters instead of hand-rolling them, and starts validating its `logcat`
arguments instead of silently passing garbage to the device.

Three separate npm packages moved on the same day. `@yume-chan/async` went
`4.1.3` → `4.2.0` → `4.2.1` → `4.2.2`, the last three published inside four
hours of each other on November 4, and the final one is the version that
introduces `noop` and `suppressUnhandledRejection` — the two helpers the
refactor leans on most.

## The socket close bug: cancelling a stream now closes the ADB connection

This is the substantive change, and it is in
[`libraries/adb/src/daemon/socket.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/adb/src/daemon/socket.ts).

The ADB daemon protocol multiplexes several logical connections ("sockets"
in adb's vocabulary — `shell:`, `sync:`, `tcp:`, and friends) over one USB
or TCP transport. Each one is a separate stream pair with its own local and
remote id. The wire protocol has a `CLOSE` command, and it has to be sent
explicitly; the remote side is not going to infer the close from the USB
transport dropping.

The old `AdbDaemonSocketController` had no mechanism for this. If a consumer
called `readable.cancel()` — which is exactly what happens when a shell
session's PTY is torn down, or a `sync:` pull is abandoned mid-file — the
library simply stopped enqueuing data. The `CLOSE` packet was never sent.
adbd on the device kept the socket open, waiting for more data on a
connection nobody would ever read from.

The fix hooks into the abort signal that `PushReadableStream` already
exposes:

```typescript
this.#readable = new PushReadableStream((controller) => {
    this.#readableController = controller;

    controller.abortSignal.addEventListener(
        "abort",
        () => void this.close().catch(noop),
        { once: true },
    );
});
```

`PushReadableStreamController.abortSignal` is now documented in the
`stream-extra` type declarations as *"an `AbortSignal` that aborts when the
stream is cancelled by the consumer"* — before this PR it existed but was
undocumented, and almost nobody knew it was the hook you were supposed to
use.

The PR adds a regression test that pins the behaviour precisely
(`libraries/adb/src/daemon/socket.spec.ts`):

```typescript
controller.enqueue(new Uint8Array([1, 2, 3]));

assert.strictEqual(sendPacket.mock.calls.length, 0);

await controller.readable.cancel();

assert.strictEqual(sendPacket.mock.calls.length, 1);
assert.deepStrictEqual(sendPacket.mock.calls[0]?.arguments, [
    AdbCommand.Close,
    1, 2,
    EmptyUint8Array,
]);
```

Read that carefully: the close packet carries the local and remote ids and
an empty payload, and it is sent *exactly once*. `close()` opens with an
`if (this.#closed) return;` guard, so a socket closed twice sends one
`CLOSE` packet, not two — a protocol violation the ADB daemon would
interpret as a mismatched close.

Two smaller fixes in the same file matter for the same reason. `enqueue()`
now early-returns if the socket is already closed, so a late-arriving chunk
cannot be pushed into a stream that has already errored:

```typescript
async enqueue(data: Uint8Array) {
    if (this.#closed) {
        return;
    }
    await this.#readableController.enqueue(data);
}
```

And the write-back-pressure promise is now nulled out when it is rejected,
rather than being rejected-and-retained. Previously the rejected promise
stayed reachable on the instance, which meant a second `close()` would try
to reject it again — a no-op at best, and a double-settle hazard at worst:

```typescript
if (this.#availableWriteBytesChanged) {
    this.#availableWriteBytesChanged.reject(new Error("Socket closed"));
    this.#availableWriteBytesChanged = undefined;
}
```

The `dispatcher` dependency was also narrowed. `AdbDaemonSocketInit` used to
take a full `AdbPacketDispatcher`; it now takes an
`AdbDaemonSocketDispatcher`, a three-member interface
(`options.maxPayloadSize`, `sendPacket`). That is a genuine API change for
anyone constructing a socket directly, but it makes the socket's actual
dependencies visible in the type instead of hiding them behind the full
dispatcher surface.

## `Array.fromAsync`, and a polyfill that does something slightly clever

The PR deletes `ToArrayStream` — an `AccumulateStream` subclass that
collected a stream into an array — and replaces every call site with
`Array.fromAsync`. `Service.readdir()` in
[`libraries/adb/src/service/sync/service.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/adb/src/service/sync/service.ts)
loses its explicit `TODO: Convert to Array.fromAsync` comment along with
six lines of code:

```typescript
// before
async readdir(path: string) {
    // TODO: Convert to `Array.fromAsync`
    const results: OpenDir.Entry[] = [];
    for await (const entry of this.opendir(path)) {
        results.push(entry);
    }
    return results;
}

// after
readdir(path: string) {
    return arrayFromAsync(this.opendir(path));
}
```

The same substitution happens in the two subprocess spawners, where
`process.stdout.pipeThrough(new ToArrayStream())` becomes
`arrayFromAsync(process.stdout)`. This is the path that every `adb shell`
command in webadb goes through, so it is worth noting what changed
structurally: the old code pushed chunks into a preallocated array through a
`TransformStream`; the new code drains the async iterable directly. One
fewer stream in the chain.

Because `Array.fromAsync` is not available everywhere, the library ships a
fallback in a new file,
[`libraries/adb/src/utils/array-from-async.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/adb/src/utils/array-from-async.ts):

```typescript
export async function arrayFromAsyncPolyfill<T>(
    items: AsyncIterable<T> | Iterable<MaybePromiseLike<T>>,
) {
    const result: T[] = [];
    let index = 0;
    for await (const item of items) {
        Object.defineProperty(result, index, {
            value: item,
            writable: true,
            enumerable: true,
            configurable: true,
        });
        index += 1;
    }
    result.length = index;
    return result;
}

export const arrayFromAsync = Array.fromAsync ?? arrayFromAsyncPolyfill;
```

The `Object.defineProperty` dance is worth pausing on. A plain
`result[index] = item` would work identically here, because `for await`
already unwraps promises. The `defineProperty` form is there so that the
property is explicitly marked `enumerable: true` — which is the default for
array index properties anyway — but also `writable` and `configurable`, which
matches array index semantics exactly. The author calls it *"a simplified
version that only works with sync/async iterables that fits our use case"*,
and the type signature reflects the narrowing: no array-like objects, no
`mapFn`, no `thisArg`.

I extracted the implementation and ran it against the three fixtures from the
PR's own spec file:

```
async iterable: [ 1, 2, 3 ] isArray: true len: 3
sync iterable: [ 4, 5, 6 ] isArray: true
sync iterable w/ promises: [ 7, 8, 9 ]
native Array.fromAsync: function
```

The third case is the one the type signature is really about: a *synchronous*
iterable that yields promises. `for await` unwraps each one, so the resulting
array holds resolved values, and the polyfill's return type
`Iterable<MaybePromiseLike<T>>` matches that behaviour.

`Array.fromAsync` has been Baseline *widely available* since January 2024,
so the polyfill is belt-and-braces in any browser we care about. But
ya-webadb ships to Node.js, Deno, Bun, and workers too, and the
`?? arrayFromAsyncPolyfill` fallback costs nothing at runtime.

What is more interesting is what the polyfill's *existence* signals: the
`stream-extra` library has been maintaining its own `ReadableStream.from`
shim for a while, and this PR changes its behaviour.

## `ReadableStream.from` now has a genuinely separate sync path

In
[`libraries/stream-extra/src/global/streams.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/stream-extra/src/global/streams.ts),
the polyfill for the (now standard) `ReadableStream.from()` static method
used to handle sync and async iterables with one code path — it checked
`Symbol.asyncIterator in iterable`, picked an iterator, and then used an
`async pull()` regardless.

The new version splits them:

```typescript
if (Symbol.asyncIterator in iterable) {
    const iterator = iterable[Symbol.asyncIterator]();
    return new ReadableStream({
        async pull(controller) {
            const result = await iterator.next();
            if (result.done) {
                controller.close();
                return;
            }
            controller.enqueue(result.value);
        },
        async cancel(reason) {
            await iterator.return?.(reason);
        },
    });
} else {
    const iterator = iterable[Symbol.iterator]();
    return new ReadableStream({
        pull(controller) {           // ← no longer async
            const result = iterator.next();
            if (result.done) {
                controller.close();
                return;
            }
            controller.enqueue(result.value);
        },
        cancel(reason) {
            iterator.return?.(reason);
        },
    });
}
```

The sync branch's `pull` is now a plain synchronous function, and its
`cancel` is synchronous too. That is not cosmetic: a synchronous `pull`
means the stream can produce its first chunk without ever yielding to the
microtask queue, which removes a tick of latency from the start of every
sync-iterable-backed stream.

`ReadableStream.from` is used in exactly the place you would expect from
the scrcpy client, in
[`libraries/adb-scrcpy/src/client.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/adb-scrcpy/src/client.ts),
which previously had two hand-rolled helpers for exactly this:

```typescript
// before
function arrayToStream<T>(array: T[]): ReadableStream<T> {
    return new PushReadableStream(async (controller) => {
        for (const item of array) {
            await controller.enqueue(item);
        }
    });
}

function concatStreams<T>(...streams: ReadableStream<T>[]): ReadableStream<T> {
    return new PushReadableStream(async (controller) => { /* ... */ });
}

// after
/**
 * Polyfill for `Iterator.concat()`
 *
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Iterator/concat
 */
async function* concatIterables<T>(
    ...iterables: (Iterable<T> | AsyncIterable<T>)[]
): AsyncIterable<T> {
    for (const iterable of iterables) {
        yield* iterable;
    }
}

// ... and at the call site
output: ReadableStream.from(concatIterables(lines, output)),
```

The comment is explicit that `concatIterables` is a polyfill for
`Iterator.concat()` — a Stage 3 proposal that does not exist in any shipping
browser yet, which is why the generator function stays. The important part is
that the scrcpy client's output stream is now built from an *async generator*
rather than a `PushReadableStream` with a manual `await controller.enqueue()`
loop. The backpressure semantics of `PushReadableStream` and a generator-backed
`ReadableStream` differ: the latter lets the stream implementation decide how
much to pull ahead, and `ReadableStream.from` handles that correctly by
pulling one item at a time.

## The Node.js TCP transport stops hand-rolling streams

`@yume-chan/adb-server-node-tcp` exists to let Node.js code talk to a local
`adb server` over TCP — useful for the `ya-webadb` CLI and for any tool that
wants the daemon protocol without WebUSB. Its connector used to bridge
`node:net`'s `Socket` to web streams by hand, with a `PushReadableStream`,
a `pause()`/`resume()` dance around each `enqueue()`, and a
`MaybeConsumable.WritableStream` wrapping `socket.write()`.

The new version replaces all of that with `node:stream`'s official web-stream
adapters:

```typescript
import { Readable, Writable } from "node:stream";

return {
    readable: Readable.toWeb(socket) as never,
    writable: new MaybeConsumable.WrapWritableStream<Uint8Array>(
        Writable.toWeb(socket) as never,
    ),
    get closed() {
        return closedResolver.promise;
    },
    close() {
        socket.end();
    },
};
```

The `as never` casts are ugly but honest: `Readable.toWeb()` returns a
`ReadableStream<any>` from the global scope, and the library's
`ReadableStream` type comes from its own `stream-extra` compatibility layer,
so the two are nominally different types even though they are the same
runtime object.

The listener handling was also cleaned up. The old code attached a `close`
listener that resolved a promise and left it attached forever; the new code
uses a `PromiseResolver` plus an explicit `cleanup()` that removes the
listeners:

```typescript
const handleClose = () => {
    closedResolver.resolve(undefined);
    cleanup();
};
const handleError = (e: Error) => {
    closedResolver.reject(e);
    cleanup();
};

const cleanup = () => {
    socket.removeListener("close", handleClose);
    socket.removeListener("error", handleError);
};
```

Note that `handleError` now *rejects* the `closed` promise where the old
code's `closed` promise only ever resolved. A rejected `closed` promise that
nobody awaits is exactly the kind of thing that produces an
`UnhandledPromiseRejection` crash in Node — which is why the very next line
is:

```typescript
suppressUnhandledRejection(closedResolver.promise);
```

That helper and its companion `noop` are the subject of the next section,
because they are what the rest of this refactor is built on.

## `noop` and `suppressUnhandledRejection`: two helpers, six call sites

The new helpers come from `@yume-chan/async` 4.2.2, and their implementations
are almost comically small:

```javascript
// no-op.js
export function noop() {}

// suppress-unhandled-rejection.js
export function suppressUnhandledRejection(promise) {
    promise.catch(noop);
}
```

`suppressUnhandledRejection` is `promise.catch(noop)` with a doc comment and
an ESLint-disabling intent. The value is not the code — it is that the
*intent* becomes greppable and that the ESLint `no-floating-promises` rule
is satisfied without a `// eslint-disable-next-line` on every line.

The library previously had its own `NOOP` constant in
`libraries/adb/src/utils/no-op.ts`, marked `/* #__NO_SIDE_EFFECTS__ */` for a
side-effect-detection toolchain that has since been removed. This PR deletes
that file and switches every call site to the `@yume-chan/async` versions.

The call sites that changed:

- `libraries/adb/src/service/sync/compression/native.ts` —
  `stream.writable.abort().catch(NOOP)` → `.catch(noop)`
- `libraries/adb/src/service/sync/request/push.ts` — `this.#resolver.promise.catch(NOOP)`
  → `suppressUnhandledRejection(this.#resolver.promise)`
- `libraries/stream-extra/src/consumable/writable.ts` —
  `void consumable.consumed.catch(() => {})` → `suppressUnhandledRejection(consumable.consumed)`
- `libraries/stream-extra/src/delayed-close-writable.ts` — same substitution
- `libraries/stream-extra/src/task-queue.ts` — same substitution
- `libraries/scrcpy/src/control/writer.ts` — `suppressUnhandledRejection(result[1])`
- `libraries/adb-server-node-tcp/src/connector.ts` — as above

One of these is worth singling out, because it is a direct follow-on from
yesterday's post. `ConsumableWritableStream.write` is exactly the method that
PR
[#878](https://github.com/yume-chan/ya-webadb/pull/878)
(`ac8447b3`, *"fix(stream-extra): prevent unhandled rejection in
Consumable.WritableStream.write"*) fixed. This PR does not change the
behaviour — it changes the *spelling* of the fix, moving the
`catch(() => {})` into the shared helper. That is the natural follow-through
after a fix like that lands: the first commit patches one call site, the
second commit notices the same pattern in five other places and gives it a
name.

## `logcat` arguments are validated before they reach the device

The last substantive change is in
[`libraries/android-bin/src/logcat.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/android-bin/src/logcat.ts),
and it is the kind of fix that only shows up in a code review.

The `Logcat.binary()` method builds a `logcat` command line. Previously it
used truthiness checks:

```typescript
if (options?.pid) {
    args.push("--pid", options.pid.toString());
}
```

`options.pid = 0` is falsy, so it was silently dropped — a request to filter
by PID 0 (which on Linux means "the kernel's scheduler thread group", a real
thing on Android) would produce a `logcat` invocation with no `--pid` filter
at all, and you would get every log line from every process with no
indication that anything went wrong. The new code is explicit:

```typescript
if (options.pid !== undefined) {
    if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
        throw new Error("PID must be a positive integer");
    }
    args.push("--pid", options.pid.toString());
}
```

The same treatment for `tail`:

```typescript
if (typeof options.tail === "number") {
    if (!Number.isSafeInteger(options.tail) || options.tail <= 0) {
        throw new Error("Tail must be a positive integer");
    }
    args.push("-t", options.tail.toString());
} else if (options.tail) {
    args.push("-t", formatTailTime(options.tail));
}
```

Note the restructuring: the `tail` branch moved *out* of the `if (options)`
block, because `options.tail` is meaningful even when `options` is otherwise
falsy-ish. And the `typeof === "number"` check now runs before the truthiness
check, so `tail: 0` throws instead of falling through to the "no tail
argument" case.

`Logcat.logIdToName()` had a related problem — `LogIdName[id]!` used a
non-null assertion to silence TypeScript about the record lookup, which would
return `undefined` at runtime for an unknown id:

```typescript
static logIdToName(id: LogId): string {
    const value = LogIdName[id];
    if (!value) {
        throw new Error(`Unknown LogId: ${id}`);
    }
    return value;
}
```

And in the scrcpy clipboard code,
[`libraries/scrcpy/src/1_21/impl/set-clipboard.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/scrcpy/src/1_21/impl/set-clipboard.ts),
a `resolver.reject()` with no argument became a real error:

```typescript
close(): void {
    for (const resolver of this.#resolvers.values()) {
        resolver.reject(
            new Error("Control socket closed before acknowledgment"),
        );
    }
    this.#resolvers.clear();
    this.#closed = true;
}
```

Rejecting with `undefined` produces a rejection whose reason is `undefined`,
which is much harder to debug than a message — you get `Unhandled rejection
(undefined)` in the console and nothing else.

### Two smaller fixes worth noting

**IPv6 bracket parsing.** In
`libraries/adb-server-node-tcp/src/socket-spec.ts`, the bracketed-IPv6 branch
shadowed the outer `port` variable with a `const`:

```typescript
// before
const port = decimalToNumber(spec, end + 2);
// after
port = decimalToNumber(spec, end + 2);
```

The outer `port` was later unconditionally reset with `port = undefined;` —
which was fine in the old code because the bracket branch returned early, but
would have been a bug if the flow ever changed. The change removes the
shadowing and the reset. The parser is a port of AOSP's
`socket_spec.cpp` / `parsenetaddress.cpp`, and the file carries the
`cs.android.com` permalinks so the two can be diffed.

**`WrapWritableStream.bePipedThroughFrom` is gone.** This method was removed
from `libraries/stream-extra/src/wrap-writable.ts` without a replacement. If
you were using it, you now write the equivalent by hand:

```typescript
// the removed method
bePipedThroughFrom<U>(transformer: TransformStream<U, T>) {
    let promise: Promise<void>;
    return new WrapWritableStream<U>({
        start: () => {
            promise = transformer.readable.pipeTo(this);
            return transformer.writable;
        },
        async close() {
            await promise;
        },
    });
}
```

There is one more change in the diff that is easy to miss and worth
understanding, because it is not a code change at all — it is a metadata
change in `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
    - "@yume-chan/async@4.2.2"
```

pnpm's `minimumReleaseAge` setting refuses to install packages published
more recently than some threshold, which is a supply-chain hardening measure
against compromised fresh releases. The exception list carves out
`@yume-chan/async@4.2.2` specifically — the author needed the brand-new
version and did not want to wait out the delay. It is a small, honest piece
of metadata: it says "this one release was published hours ago and we took it
anyway".

## What this means for webadb.online

Mostly this is upstream work with no direct impact on webadb this week, with
one exception worth flagging.

**No impact on webadb this week.** webadb.online is still on
`@yume-chan/adb@3.0.0-beta.1` and the whole `3.0.0-beta.1` line, and this
PR is unreleased — it landed on `main` after the `v3.0.0-beta.4` tag
(`7bcec613`, October 9), so there is no npm artifact to consume yet. The
changes that would reach us via a future beta are the socket `CLOSE` packet
and the `ReadableStream.from` sync-iterator split.

The `CLOSE` packet is the one with a plausible user-visible effect. Our
Terminal panel creates a PTY per window; when a window is closed, the PTY is
torn down and the underlying ADB socket is cancelled. On the current
`3.0.0-beta.1`, that cancellation does not tell adbd anything, so the device
keeps the `shell:` socket alive until the whole USB transport goes away.
On a phone where the user opens and closes several Terminal windows in a
row, that is a slow accumulation of orphaned sockets on the device side.
Upgrading to a release containing `0c68ad2f` would make our teardown
explicit and bounded.

The `logcat` argument validation is not directly useful to us either — our
Logcat panel builds its own `logcat` command line rather than going through
`@yume-chan/android-bin`'s `Logcat` class — but the `options.pid !== undefined`
fix is a good reminder for our own shell-out code, where we do pass `--pid`
values that come from a UI filter and could legitimately be `0`.

The `ReadableStream.from` sync-path split is the one change that might make
itself felt without a version bump, because it lands in `stream-extra`, which
we do depend on at `^3.0.0-beta.1` and which is a separate npm package with
its own version line. But we do not currently call `ReadableStream.from` with
a synchronous iterable anywhere in our own code — I checked — so the practical
benefit for us is zero today. It would matter if we adopted it.

One process note: the Chromium Direct Sockets check that runs on Mondays was
skipped this week. Today is Thursday, and that source is weekly by design.
