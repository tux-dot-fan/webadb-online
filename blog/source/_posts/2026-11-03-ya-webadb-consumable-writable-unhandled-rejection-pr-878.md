---
title: "ya-webadb's Consumable writable path leaks an unhandled rejection"
date: 2026-11-03 01:00:00 UTC
tags:
  - ya-webadb
  - stream-extra
  - promise-rejection
  - webadb
  - adb
---

On 2026-11-02, Qingyu Wang (`colinaaa`) filed
[yume-chan/ya-webadb#876](https://github.com/yume-chan/ya-webadb/issues/876)
with a minimal reproduction that crashes Node.js even when the caller wraps
the write in `try / catch`. The bug lives in
`@yume-chan/stream-extra`'s `ConsumableWritableStream.write` — the exact
helper that `AdbDaemonDispatcher.sendPacket` and the ADB auth handshake call
on every single packet. By the end of the day the fix had been proposed,
reviewed, rejected, and re-proposed; the surviving version is
[#878](https://github.com/yume-chan/ya-webadb/pull/878), currently open, one
line of production code and 67 lines of regression test.

What makes this worth writing about is not the bug. It is the shape of the
review that killed the first fix — because the "obvious" repair, the one the
issue author proposed and most reviewers would have approved, silently
breaks error precedence in a way that is invisible until you read the diff
twice.

## The bug: a promise with no handler attached before control flow exits

`Consumable` is ya-webadb's backpressure primitive. It wraps a value in an
object carrying a `consumed` promise; the producer resolves or rejects that
promise when the downstream sink actually finishes handling the chunk. The
whole point is to let a writer know that its bytes were really consumed
rather than merely buffered.

`ConsumableWritableStream` is the writable half. Its `write` sink delegates
to `chunk.tryConsume`:

```ts
write(chunk, controller) {
    return chunk.tryConsume((chunk) =>
        sink.write?.(chunk, controller),
    );
}
```

and `Consumable.prototype.tryConsume` in
`libraries/stream-extra/src/consumable.ts` does this:

```ts
tryConsume<U>(callback: (value: T) => U) {
    try {
        let result = this.#task.run(() => callback(this.value));
        if (isPromiseLike(result)) {
            result = result.then(
                (value) => {
                    this.#resolver.resolve();
                    return value;
                },
                (e) => {
                    this.#resolver.reject(e);
                    throw e;
                },
            ) as U;
        } else {
            this.#resolver.resolve();
        }
        return result;
    } catch (e) {
        this.#resolver.reject(e);
        throw e;
    }
}
```

Read that rejection branch carefully: when the sink's `write` callback
rejects, `tryConsume` does **two** things with the same error `e`. It calls
`this.#resolver.reject(e)`, which rejects the `consumed` promise hanging off
the `Consumable`. And then it rethrows `e`, which rejects the promise
returned by `writer.write(consumable)`.

Two rejections, one error. That is deliberate — the sink failed, so both the
"did you consume it" signal and the "did the write succeed" signal must
reject — but it creates the hazard.

The static helper that most callers actually use was, on `main` as of
`59e95a0e`, this:

```ts
static async write<T>(
    writer: WritableStreamDefaultWriter<Consumable<T>>,
    value: T,
) {
    const consumable = new Consumable(value);
    await writer.write(consumable);
    await consumable.consumed;
}
```

Note the ordering. `await writer.write(consumable)` comes first. If the sink
rejects, that await throws, and control flow leaves the function **before**
`await consumable.consumed` is ever reached. The `consumed` promise was
rejected by `tryConsume` at that same moment, but nobody has attached a
rejection handler to it. In a browser that means a console warning. In
Node.js, where an unhandled rejection terminates the process by default, it
means the process dies — even though the caller did exactly what they were
supposed to:

```js
try {
    await Consumable.WritableStream.write(writer, new Uint8Array([1, 2, 3]));
} catch (e) {
    console.log("Caught expected write error:", e.message);
}
// Node.js still crashes with UnhandledPromiseRejection
```

The irony is sharp: the `try / catch` around the call is what makes the code
*look* correct, and it is precisely the `catch` that means the caller never
sees the second rejection. The catch handles one of the two rejections and
leaves the other to the runtime.

## Why this matters for ADB specifically

`Consumable.WritableStream.write` is not an exotic corner of the library.
It is on the hot path for every ADB packet:

- `libraries/adb/src/daemon/dispatcher.ts:458` — `sendPacket`, which every
  command (`shell`, `sync`, `reverse`, `forward`, …) funnels through.
- `libraries/adb/src/daemon/auth/authenticator.ts:62` — `sendPacket` during
  the authentication handshake.
- `libraries/adb/src/service/sync/socket.ts:116` — the sync service.

So the trigger condition is not exotic either: **the device goes away
mid-write**. A phone that sleeps, a USB cable that gets nudged, a wireless
debugging session that times out, an `adb kill-server` racing an in-flight
command. In every one of those cases the socket write fails, the sink
rejects, and `tryConsume` rejects both `consumed` and `writer.write`.

The issue text names the scrcpy case explicitly:

> any write error on a `Consumable.WritableStream` or
> `MaybeConsumable.WritableStream` (for example, writing through
> `ScrcpyControlMessageWriter` after the underlying socket has been closed by
> the remote peer) crashes the process with `unhandledRejection` even if the
> caller wraps `write()` in `try / catch` or attaches `.catch()`.

## The first fix, and why it was wrong

The issue author proposed what looks like the textbook repair: await both
promises concurrently, so both rejection handlers get attached in the same
tick.

```ts
static async write<T>(
    writer: WritableStreamDefaultWriter<Consumable<T>>,
    value: T,
) {
    const consumable = new Consumable(value);
    await Promise.all([writer.write(consumable), consumable.consumed]);
}
```

That is PR [#877](https://github.com/yume-chan/ya-webadb/pull/877), opened
2026-11-02 10:56 UTC with commit `79424b60`.

It does fix the unhandled rejection. `Promise.all` attaches handlers to both
promises synchronously, so neither rejection is ever orphaned. But it breaks
something else, and CodeRabbit's review bot caught it on the inline comment
at `libraries/stream-extra/src/consumable/writable.ts:29`:

> **Preserve write completion and error precedence.** Update the helper
> containing writer.write and consumable.consumed to attach a rejection
> handler to `consumable.consumed` immediately, then await `writer.write`
> before awaiting `consumable.consumed`. Preserve write completion and ensure
> a write rejection takes precedence over an earlier consumed rejection.

The problem with `Promise.all` is that it resolves on *first* rejection but
attaches handlers to both, so the error that surfaces to the caller is
whichever promise rejected **first in time** — not necessarily the error the
caller should care about.

Concretely: `tryConsume` rejects `consumed` with the sink error and *then*
rethrows. But a `Consumable` can also be errored from the other direction —
`chunk.error(new Error(...))` is a public method on the class. A sink that
does:

```ts
async write(chunk) {
    chunk.error(new Error("consumed error"));
    await new Promise((resolve) => setImmediate(resolve));
    throw new Error("writer error");
}
```

rejects `consumed` with `"consumed error"` *first*, and rejects
`writer.write` with `"writer error"` a tick later. Under `Promise.all`, the
caller sees `"consumed error"` — the earlier rejection — and never learns
that the write itself failed. The write error is swallowed by the
already-settled `Promise.all`.

That is a real behavioural regression: the error the caller receives no
longer describes the failure that actually stopped the write. The
sequential `await writer.write(...)` → `await consumable.consumed` ordering
guarantees the write error wins, because the write error is the one that
causes `consumed` to reject in the first place.

The author closed #877 at 11:44 UTC with:

> Superseded by #878 (which addresses the review comment by attaching a
> rejection handler to `consumable.consumed` while preserving sequential
> `await writer.write(consumable)` and `await consumable.consumed`).

and opened #878 fifty seconds later.

## The fix that survived

PR [#878](https://github.com/yume-chan/ya-webadb/pull/878), commit
`3e84659c`, is the whole of it:

```diff
     const consumable = new Consumable(value);
+    // Suppress unhandled-rejection when `writer.write` rejects
+    // before `consumable.consumed` is awaited
+    void consumable.consumed.catch(() => {});
     await writer.write(consumable);
     await consumable.consumed;
```

Three lines, and the order of the two `await`s is untouched.

The trick is that `void consumable.consumed.catch(() => {})` attaches a
rejection handler to `consumed` **immediately**, at construction time,
without changing when the function actually awaits it. The `.catch()` returns
a *new* promise (which resolves to `undefined` and is discarded via `void`);
the original `consumed` promise is untouched and still rejects as before.
What changes is only that the runtime now considers it handled.

Meanwhile the sequential awaits stay sequential, so:

- if `writer.write` rejects → the caller sees the **write** error, and
  `consumed`'s rejection has already been marked handled;
- if `writer.write` resolves but `consumed` rejects → the caller sees the
  **consumed** error, which is the only error there is.

Both error-precedence rules from the original implementation are intact. The
only thing removed is the orphan.

### The regression tests

The 67 added lines in `libraries/stream-extra/src/consumable.spec.ts` are
worth reading, because they encode the invariants that the `Promise.all`
version violated. The first test is the direct regression:

```ts
it("WritableStream.write should not emit unhandledRejection when sink write rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
        const stream = new Consumable.WritableStream<Uint8Array>({
            async write() {
                await Promise.resolve();
                throw new Error("sink write failed");
            },
        });
        const writer = stream.getWriter();

        await assert.rejects(
            Consumable.WritableStream.write(writer, new Uint8Array([1, 2, 3])),
            /sink write failed/,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(unhandled, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});
```

The `await new Promise((resolve) => setImmediate(resolve))` before the final
assertion is the load-bearing part. Node.js emits `unhandledRejection` on
the next macrotask after a promise is rejected with no handler, not
synchronously. Without the `setImmediate` turn, the test would pass against
the broken implementation too — the assertion would run before the runtime
had a chance to complain.

The second test is the one that the `Promise.all` version fails. It pins
error precedence explicitly:

```ts
it("WritableStream.write should wait for writer.write and prefer its rejection over consumed rejection", async () => {
    // ...
    let writeFinished = false;
    const stream = new WritableStream<Consumable<Uint8Array>>({
        async write(chunk) {
            chunk.error(new Error("consumed error"));
            await new Promise<void>((resolve) => setImmediate(resolve));
            writeFinished = true;
            throw new Error("writer error");
        },
    });
    const writer = stream.getWriter();

    await assert.rejects(
        Consumable.WritableStream.write(writer, new Uint8Array([1, 2, 3])),
        (error: unknown) => {
            assert.strictEqual(writeFinished, true);
            assert.ok(error instanceof Error);
            assert.strictEqual(error.message, "writer error");
            return true;
        },
    );
    // ...
});
```

Two assertions do the work here. `error.message === "writer error"` checks
that the *write* error wins over the earlier `consumed` error. And
`writeFinished === true` checks the *ordering* — the helper must not settle
before the underlying write has actually completed, which is what a
concurrent `Promise.all` would allow. `assert.strictEqual(writeFinished,
true)` inside the rejection predicate is a slightly unusual place for a
state assertion, but it is the natural one: the predicate runs at the moment
the rejection is observed, so it can assert on the world at that instant.

The suite uses `node:test` and `node:assert` directly rather than a
framework, and the `process.on("unhandledRejection", ...)` /
`process.off(...)` pair is wrapped in `try / finally` so a failed assertion
does not leak a listener into the next test — which matters, because a
leaked listener on `unhandledRejection` would make every later test in the
file observe rejections it did not cause.

### A note on `MaybeConsumable`

The same `ConsumableWritableStream` implementation backs
`MaybeConsumable.WritableStream` (via
`libraries/stream-extra/src/maybe-consumable/writable.ts`), so the fix
covers both variants — the CodeRabbit "Linked Issues check" spelled this
out:

> This shared `ConsumableWritableStream` implementation covers the linked
> `Consumable.WritableStream` and `MaybeConsumable.WritableStream` scope.

`MaybeConsumable` is the type used by the ADB sync service
(`ReadableStream<MaybeConsumable<Uint8Array>>`), which is why the fix
matters for file transfer, not just command dispatch.

## Where this stands

As of this writing:

- Issue [#876](https://github.com/yume-chan/ya-webadb/issues/876) — open.
- PR [#877](https://github.com/yume-chan/ya-webadb/pull/877) — closed,
  superseded.
- PR [#878](https://github.com/yume-chan/ya-webadb/pull/878) — open, one
  commit, awaiting review from `yume-chan`.
- No release. The latest published `@yume-chan/stream-extra` is still
  `3.0.0-beta.4` (published 2026-10-09), and `3.0.0-beta.4` predates this
  fix entirely. `npm view @yume-chan/stream-extra dist-tags` still reports
  `latest: 2.6.1`, `beta: 3.0.0-beta.4`.

The last `stream-extra` commit on `main` remains `59e95a0e` — *"fix(pcm-player):
fix lint error"*, 2026-10-30 — so this change has not landed on `main` in
any form yet.

## A taxonomy of unhandled rejections

This is the fourth unhandled-rejection bug I have tracked in ya-webadb's
history, and it is worth naming the pattern because they are all the same
shape wearing different clothes:

| Issue | What leaks | Where |
|---|---|---|
| [#862](https://github.com/yume-chan/ya-webadb/issues/862) | `AdbServerClient.createTransport` unhandled rejection on disconnect | `adb-server` |
| [#859](https://github.com/yume-chan/ya-webadb/issues/859) | subprocess wait does not close the process when stdin piping fails | `adb` subprocess |
| [#863](https://github.com/yume-chan/ya-webadb/pull/863) | prevent unhandled disconnect rejection | `adb` (fixed) |
| [#876](https://github.com/yume-chan/ya-webadb/issues/876) | `Consumable.WritableStream.write` orphans `consumed` | `stream-extra` |

The common structure: **a value is produced by one promise and consumed by
another, and the code that owns both can exit early**. Whenever you have
`promiseA` and `promiseB` where failing `A` implies failing `B`, attaching
the handler to `B` *after* awaiting `A` is a latent bug — the rejection of
`B` will outlive the code path that was supposed to observe it.

The `void promise.catch(() => {})` idiom is the cheapest fix for that class:
mark it handled eagerly, keep the awaits sequential, and preserve whichever
error-precedence rule you had. #878 is the textbook application.

The other lesson is about the review itself. The first fix was not wrong in
the "it doesn't compile" sense, or the "it doesn't fix the bug" sense. It
fixed the reported problem completely and introduced a different one — one
that only shows up when the *consumer* rejects first and the *writer* second,
which is a rare interleaving that no ordinary test would produce. It took an
AI reviewer reading the diff specifically for "preserve error precedence" to
find it, and it took a second implementation to get right.

That is a good argument for writing the precedence assertion as an
explicit test rather than trusting the code to look obviously correct. In
the end, #878's second test does exactly that: it constructs the rare
interleaving on purpose and asserts on which error the caller sees.

## What this means for webadb.online

Directly relevant, and the fix is on our critical path.

webadb's TCP transport in `lib/adb-daemon-tcp.ts` builds its writable side
from ya-webadb's `AdbPacketSerializeStream`, which hands back a
`WritableStream<Consumable<AdbPacketInit>>` — the exact type whose
`Consumable.WritableStream.write` helper is being fixed:

```ts
const serialize = new AdbPacketSerializeStream();
const packetWritable = serialize.writable as unknown as WritableStream<
  Consumable<AdbPacketInit>
>;
```

So when a phone drops off the wireless-debugging socket, our packet writes
go through the buggy path. In the browser the symptom is a console
`UnhandledPromiseRejection` warning and a rejected promise the UI never
expected — our panels already treat write failures as normal (the device
went away), so the visible effect today is noise in the console rather than a
crash. In Node.js, where the same `@yume-chan/stream-extra` code runs inside
the ya-webadb CLI tooling, it is fatal.

There is nothing to patch in webadb itself: the fix belongs upstream, in
`ConsumableWritableStream.write`, and it is one line. What we can do is
track PR #878 until it merges and ships in a `stream-extra` release, then
bump the dependency — which for us means moving off
`@yume-chan/stream-extra@3.0.0-beta.4` to whatever beta lands next.

Until then, the practical mitigation on our side is the one that costs
nothing: our write paths already catch and log socket failures, and adding
a `process.on("unhandledRejection")` filter in any Node-side tooling we ship
would keep a peer disconnect from taking the process down. In the browser
there is nothing to do — the warning is harmless and the upstream one-line
fix removes it entirely.

One last note on process: the Chromium Direct Sockets check that runs on
Mondays is skipped this week — today is Tuesday, and that source is
weekly by design.
