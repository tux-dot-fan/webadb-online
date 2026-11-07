---
title: "ya-webadb v3.0.0-beta.5 ships: shared AudioContexts, a socket that closes, and one unhandled rejection less"
date: 2026-11-07 01:00:00 UTC
tags:
  - ya-webadb
  - scrcpy
  - web-audio
  - streams
  - release
---

ya-webadb v3.0.0-beta.5 was tagged at `2026-11-06T02:06:33Z` and pushed to npm roughly twenty minutes later. It is the first release in six weeks — beta.4 landed on October 9 — and it packages four commits into a single beta: the `Consumable.WritableStream.write` unhandled-rejection fix (`ac8447b3`, PR #878), a large "small improvements" refactor (`0c68ad2f`, PR #879), the scrcpy inject-key shorthands (`3a7d781c`), and a PCM player that shares `AudioContext` instances per sample rate and resumes them automatically (`93fce383`). If you consume `@yume-chan/*` on the `beta` dist-tag, this is a version bump with two breaking API removals in it. If you are on `latest` (`2.6.4` for `@yume-chan/adb`), nothing changes yet.

The release matters beyond the changelog because beta.5 is the first build where the library's *resource lifecycle* got deliberately reworked. Sockets close their ADB-side peer, `AudioContext`s stop being closed by their owners, and promises that are intentionally not awaited stop being reported as unhandled rejections. Those three things are the same fix applied to three different layers of the same stack, and the fact that they landed together suggests the author was working through a class of "the object outlives its handler" bugs rather than adding features.

## The AudioContext sharing change is the most user-visible one

`93fce383` rewrites the constructor of `PcmPlayer` in
[`libraries/pcm-player/src/index.ts`](https://github.com/yume-chan/ya-webadb/blob/v3.0.0-beta.5/libraries/pcm-player/src/index.ts).
Before this commit, every `PcmPlayer` allocated its own `AudioContext`:

```typescript
constructor(sampleRate: number, channelCount: number) {
    this.#context = new AudioContext({
        latencyHint: "interactive",
        sampleRate,
    });
    this.#channelCount = channelCount;
}
```

Now the constructor takes an optional context, and falls back to a module-level registry keyed by sample rate:

```typescript
const SharedContexts = new Map<number, AudioContext>();

function getSharedContext(sampleRate: number) {
    if (!SharedContexts.has(sampleRate)) {
        SharedContexts.set(
            sampleRate,
            new AudioContext({
                latencyHint: "interactive",
                sampleRate,
            }),
        );
    }
    return SharedContexts.get(sampleRate)!;
}
```

The corresponding change in `stop()` is the interesting half:

```typescript
async stop() {
    this.#worklet?.disconnect();
    this.#worklet = undefined;

    this.#buffers.length = 0;

    // Do not close the AudioContext as it might be shared.
}
```

The old code called `await this.#context.close()`. The new code deliberately does not, because the context may now be owned by someone else. `this.#buffers.length = 0` was added in the same place — previously the buffer array was not cleared on stop, so a stopped-then-restarted player would replay every buffered sample through the new worklet node. That is a real bug fix that rode along with the refactor.

The second half of the change is the automatic resume:

```typescript
/**
 * Starting the AudioContext if it is suspended and the user has interacted with the page.
 */
#tryResuming() {
    if (
        this.#context.state === "suspended" &&
        navigator.userActivation.hasBeenActive
    ) {
        void this.#context.resume().catch(() => {});
    }
}
```

It is called from both `feed()` and `start()`. The `navigator.userActivation.hasBeenActive` guard is the detail worth noting: browsers will not let an `AudioContext` resume without a user gesture, and attempting it anyway produces a rejected promise that surfaces as an unhandled rejection in the console. By gating on `hasBeenActive` — which is a sticky flag, not a transient one — the player only attempts the resume when the page has *ever* been interacted with, and swallows the rejection if the browser still refuses.

The worklet module registration got the same treatment. Because contexts are now shared, `audioWorklet.addModule()` would be called once per player against the same context, and the second call would fail with `InvalidStateError` (a module cannot be added twice under the same name):

```typescript
const AddModulePromises = new WeakMap<AudioContext, Promise<void>>();

function addWorkletModule(context: AudioContext) {
    if (!AddModulePromises.has(context)) {
        AddModulePromises.set(
            context,
            context.audioWorklet.addModule(
                new URL("./worker.js", import.meta.url),
            ),
        );
    }
    return AddModulePromises.get(context)!;
}
```

The `WeakMap` keyed by `AudioContext` is the correct shape here — it lets a context be garbage collected without the promise map holding it alive.

The practical consequence for anyone building an scrcpy client with audio: **you can now start and stop the audio player without tearing down the browser's audio hardware state.** A scrcpy session that stops video but keeps the microphone stream alive, or reconnects to the same device, no longer pays the cost of a fresh `AudioContext` construction, and no longer silently goes mute because the browser suspended the context when the tab lost focus. The `AudioContext` construction cost is not trivial — on Chrome it involves a thread handoff to the audio service, and it was the reason many web scrcpy implementations ended up with a permanently-suspended context after the first user gesture was consumed elsewhere on the page.

## PR #879 closes the ADB socket properly, and fixes a bug in the process

The bulk of `0c68ad2f` is described in the release notes as "small improvements", which undersells it. The commit touches 50 files across 12 packages and carries the actual socket-lifecycle fix in
[`libraries/adb/src/daemon/socket.ts`](https://github.com/yume-chan/ya-webadb/blob/v3.0.0-beta.5/libraries/adb/src/daemon/socket.ts).

The change is in `AdbDaemonSocketController`. Previously the `PushReadableStream` that carries the socket's inbound data had no cancellation path, so if a consumer called `readable.cancel()` — which is what happens when a WebUSB transfer fails mid-stream, or when the application tears down a panel — the ADB daemon was never told. The device kept the socket open, the local socket id stayed allocated, and the daemon-side resource leaked until the whole `adbd` connection dropped.

The fix wires the stream controller's `abortSignal` to the socket's `close()`:

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

And `enqueue()` now short-circuits on a closed socket:

```typescript
async enqueue(data: Uint8Array) {
    if (this.#closed) {
        return;
    }
    await this.#readableController.enqueue(data);
}
```

That second guard is the one that matters for correctness under race. `enqueue()` is called from the packet dispatcher when the device sends data; `close()` is called from the cancellation path. If a packet arrives in the same tick that the consumer cancels the readable, the pre-fix code would call `enqueue()` on an errored controller — which throws a `TypeError` from the stream machinery, at a point where the caller's own error handling was already unwinding. The guard makes the two paths commute.

The `close()` path also had a latent double-reject bug:

```typescript
- this.#availableWriteBytesChanged?.reject(new Error("Socket closed"));
+ if (this.#availableWriteBytesChanged) {
+     this.#availableWriteBytesChanged.reject(new Error("Socket closed"));
+     this.#availableWriteBytesChanged = undefined;
+ }
```

`PromiseResolver#reject` on an already-settled resolver is harmless in most implementations but not guaranteed to be, and the new code clears the field so a second `close()` cannot attempt to reject again.

The PR also introduces a proper type for the dispatcher, `AdbDaemonSocketDispatcher`, replacing the over-broad `AdbPacketDispatcher`:

```typescript
export interface AdbDaemonSocketDispatcher {
    options: {
        maxPayloadSize: number;
    };

    sendPacket(
        command: AdbCommand,
        arg0: number,
        arg1: number,
        payload: string | Uint8Array,
    ): Promise<void>;
}
```

A `socket.spec.ts` file was added alongside it, and it tests precisely the cancellation behavior:

```typescript
it("should close when readable stream cancels", async () => {
    const sendPacket = mock.fn<AdbDaemonSocketDispatcher["sendPacket"]>();

    const controller = new AdbDaemonSocketController({ /* ... */ });

    controller.enqueue(new Uint8Array([1, 2, 3]));

    assert.strictEqual(sendPacket.mock.calls.length, 0);

    await controller.readable.cancel();

    assert.strictEqual(sendPacket.mock.calls.length, 1);
    assert.deepStrictEqual(sendPacket.mock.calls[0]?.arguments, [
        AdbCommand.Close,
        1,
        2,
        EmptyUint8Array,
    ]);
});
```

That assertion — that cancelling the readable side causes exactly one `AdbCommand.Close` packet to be sent to the peer — is the contract that was previously implicit and untested. Note `sendPacket` is called with `AdbCommand.Close`, the local id, the remote id, and an empty payload, which is the ADB daemon's socket-close wire format.

## The unhandled-rejection story, and a new `@yume-chan/async` API

PR #878 (`ac8447b3`) is the smallest commit in the release and the one with the clearest rationale. The bug was in
[`libraries/stream-extra/src/consumable/writable.ts`](https://github.com/yume-chan/ya-webadb/blob/v3.0.0-beta.5/libraries/stream-extra/src/consumable/writable.ts),
in the static `write` helper:

```typescript
export static async write<T>(
    writer: WritableStreamDefaultWriter<Consumable<T>>,
    value: T,
) {
    const consumable = new Consumable(value);
    await writer.write(consumable);
    await consumable.consumed;
}
```

`writer.write(consumable)` can reject — the sink's `write` throws, or the stream is already errored — and when it does, the `await` on the next line never runs, so `consumable.consumed` is never awaited. `Consumable#consumed` is a promise that rejects with whatever the sink reported, and nobody attached a handler to it. Node.js and the browser both report that as an unhandled rejection, in a stack frame that has nothing to do with the actual failure.

The fix is two lines:

```typescript
const consumable = new Consumable(value);
// Suppress unhandled-rejection when `writer.write` rejects
// before `consumable.consumed` is awaited
void consumable.consumed.catch(() => {});
await writer.write(consumable);
await consumable.consumed;
```

The attached handler is installed *before* the `await`, so the rejection is always observed. The `await consumable.consumed` on the final line still surfaces the real error to the caller — the suppression handler is a no-op sink, not a state change on the promise.

The PR ships two spec files' worth of regression tests, and the second one is the interesting case. It asserts that `writer.write`'s rejection takes priority over the consumed-stream rejection, and that the write is actually complete before the error is raised:

```typescript
await assert.rejects(
    Consumable.WritableStream.write(
        writer,
        new Uint8Array([1, 2, 3]),
    ),
    (error: unknown) => {
        assert.strictEqual(writeFinished, true);
        assert.ok(error instanceof Error);
        assert.strictEqual(error.message, "writer error");
        return true;
    },
);
```

Both tests install a `process.on("unhandledRejection", ...)` listener and assert that the collected array is empty afterwards — so the tests fail if the fix regresses, not merely if the happy path breaks.

Underneath this sits a broader cleanup. `@yume-chan/async` was bumped from `4.1.3` to `4.2.2` across every package, and the new version adds two exported functions:

```typescript
/**
 * Suppress Node.js unhandled rejection warning for a Promise
 * @param promise The Promise to suppress unhandled rejection warnings for
 */
export declare function suppressUnhandledRejection(promise: Promise<unknown>): void;
```

```typescript
export declare function noop(): void;
```

`suppressUnhandledRejection` is `promise.catch(noop)` with a documented intent, and PR #879 replaces every ad-hoc `void promise.catch(() => {})` in the codebase with it — in `DelayedCloseWritableStream`, in `TaskQueue`, in the ADB sync `push` request's `SendWritableStream`, and in the scrcpy control writer:

```typescript
if (result instanceof Uint8Array) {
    await this.write(result);
} else {
    suppressUnhandledRejection(result[1]);
    await this.write(result[0]);
    await result[1];
}
```

The `noop` export matters because PR #879 also **deleted** the local `NOOP` constant that used to live in `libraries/adb/src/utils/no-op.ts` and in `libraries/stream-extra/src/duplex.ts`. In the released beta.5 package, `@yume-chan/adb`'s `esm/utils/no-op.js` now exports a completely different function:

```javascript
export function unreachable(...args) {
    // Trigger runtime's unhandled rejection event.
    throw new Error("Unreachable. Arguments:\n" + args.join("\n"));
}
```

That is a **breaking change** for anyone importing `NOOP` from `@yume-chan/adb`. The name changed, the semantics inverted (it now throws instead of doing nothing), and the intent flipped — it exists to make the runtime's unhandled-rejection machinery fire deliberately, which is the opposite of `NOOP`'s old job.

## Two API removals that will break a beta.4 consumer

If you are tracking the `beta` dist-tag, these are the two changes that will fail your build.

**`ToArrayStream` is gone from `@yume-chan/adb`.** It was a public export from
`libraries/adb/src/service/subprocess/utils.ts`:

```typescript
export class ToArrayStream<T> extends AccumulateStream<T, T[]> {
    constructor() {
        super(
            [],
            (chunk, current) => {
                current.push(chunk);
                return current;
            },
            (output) => output,
        );
    }
}
```

PR #879 deleted it and replaced every internal use with the new `arrayFromAsync` helper, added at
`libraries/adb/src/utils/array-from-async.ts`:

```typescript
// A simplified version that only works with sync/async iterables that fits our use case.
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

The `Object.defineProperty` + `result.length = index` dance is deliberate: it makes the array behave like a genuine `Array.fromAsync` result for a sync iterable whose items are promises, where the *element positions* are fixed at iteration time but the *values* settle later. A plain `result.push(item)` would not produce the same ordering semantics. The native `Array.fromAsync` is used when the runtime provides it, and the polyfill fills in otherwise — Chrome 121+ ships the native version.

Both the shell-protocol and none-protocol spawners were rewritten to use it:

```typescript
const [, stdout, stderr, exitCode] = await Promise.all([
    options?.stdin?.pipeTo(process.stdin),
    arrayFromAsync(process.stdout),
    arrayFromAsync(process.stderr),
    process.exited,
]);
```

**`NOOP` is gone** — covered above. `ToArrayStream` was also removed from the `side-effect-test` toolchain's export allowlist, which is how the toolchain caught that it was a public API.

## The logcat options tightened, and the arguments are now built eagerly

`libraries/android-bin/src/logcat.ts` got a quieter but user-visible rewrite. The `binary()` method used to build its argument list lazily inside the `WrapReadableStream` factory callback; it now builds it eagerly, before the stream is even constructed:

```typescript
binary(options?: LogcatOptions): ReadableStream<AndroidLogEntry> {
    const args = ["logcat", "-B"];
    if (options) {
        if (options.dump) {
            args.push("-d");
        }

        if (options.pid !== undefined) {
            if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
                throw new Error("PID must be a positive integer");
            }
            args.push("--pid", options.pid.toString());
        }

        if (options.ids) {
            args.push("-b", Logcat.joinLogId(options.ids));
        }

        if (typeof options.tail === "number") {
            if (!Number.isSafeInteger(options.tail) || options.tail <= 0) {
                throw new Error("Tail must be a positive integer");
            }
            args.push("-t", options.tail.toString());
        } else if (options.tail) {
            args.push("-t", formatTailTime(options.tail));
        }
    }

    return new WrapReadableStream(async () => {
        const process = await this.#adb.subprocess.noneProtocol.spawn(args);
        return process.output;
    })/* ... */;
}
```

Three things changed. First, **argument validation now happens at call time, not at stream-consumption time** — a bad `pid` throws synchronously out of `binary()` instead of surfacing later as a spawn failure. Second, `pid` and numeric `tail` are validated as positive safe integers; the old code would happily produce `--pid 0` or `--pid -1`, which `logcat` rejects with a message that does not say which option was wrong. Third, the `typeof options.tail === "number"` branch was pulled out of the `if (options?.tail)` truthiness check — the old code treated `tail: 0` as absent, which is fine, but it also meant a numeric `tail` had to pass a truthiness test before its type was checked.

`Logcat.logIdToName` also stopped silently returning `undefined`:

```typescript
static logIdToName(id: LogId): string {
    const value = LogIdName[id];
    if (!value) {
        throw new Error(`Unknown LogId: ${id}`);
    }
    return value;
}
```

The old `return LogIdName[id]!` used a non-null assertion on a reverse lookup into a `Record<number, string>`. The assertion was a lie the type system could not check — the map is indexed by number but `LogId` is a string enum, so a mismatch between the two would produce `undefined` at runtime and the `!` would silence TypeScript's complaint about it.

## Smaller changes worth naming

**The Node TCP connector now uses `Readable.toWeb` / `Writable.toWeb`.** PR #879 rewrote `nodeSocketToConnection` in
[`libraries/adb-server-node-tcp/src/connector.ts`](https://github.com/yume-chan/ya-webadb/blob/v3.0.0-beta.5/libraries/adb-server-node-tcp/src/connector.ts),
replacing a hand-rolled `PushReadableStream` that paused and resumed the socket around every `enqueue`:

```typescript
return {
    readable: Readable.toWeb(socket) as never,
    writable: new MaybeConsumable.WrapWritableStream<Uint8Array>(
        Writable.toWeb(socket) as never,
    ),
    get closed() {
        return closedResolver.promise;
    },
    /* ... */
};
```

The old code had a subtle flow-control bug: it called `socket.pause()`, awaited `controller.enqueue(data)`, then called `socket.resume()`. If `enqueue` rejected (because the consumer cancelled), the socket was never resumed and the Node stream stalled. Node's own `toWeb` adapters handle backpressure with `ReadableStreamDefaultController#desiredSize` and resume the socket when the consumer drains.

**`ReadableStream.from` got a real sync-iterable path.** In `libraries/stream-extra/src/global/streams.ts`, the polyfill used to drive *both* sync and async iterables through an `async pull`, which meant every chunk of a sync iterable cost a microtask turn and an `await`. The new version branches:

```typescript
ReadableStream.from ??= function (iterable) {
    if (Symbol.asyncIterator in iterable) {
        const iterator = iterable[Symbol.asyncIterator]();
        return new ReadableStream({
            async pull(controller) { /* ... */ },
            async cancel(reason) { /* ... */ },
        });
    } else {
        const iterator = iterable[Symbol.iterator]();
        return new ReadableStream({
            pull(controller) {
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
};
```

The sync path's `pull` is no longer `async` and its `cancel` is no longer `async`, so a sync iterable drains synchronously as the consumer reads.

**`adbd` subprocess signalling, `scrcpy` clipboard acks, and `Iterator.concat`.** PR #879 also deleted the `bePipedThroughFrom` method from `WrapWritableStream` (it was unused and its `promise` variable was definitely-assigned only in `start()`, a latent TDZ hazard), made the scrcpy clipboard ack handler reject with a real message instead of `undefined`:

```typescript
close(): void {
    for (const resolver of this.#resolvers.values()) {
        resolver.reject(
            new Error("Control socket closed before acknowledgment"),
        );
    }
    /* ... */
}
```

and replaced a hand-written `concatStreams` helper in `adb-scrcpy/src/client.ts` with `ReadableStream.from(concatIterables(lines, output))`, where `concatIterables` is documented as a polyfill for `Iterator.concat()`.

**`pnpm-workspace.yaml` gained `minimumReleaseAgeExclude`.** The new stanza is:

```yaml
minimumReleaseAgeExclude:
    - "@yume-chan/async@4.2.2"
```

pnpm 10.16+ has a `minimumReleaseAge` setting that refuses to install packages published within the last N minutes, to blunt supply-chain attacks that abuse a fresh publish. Excluding `@yume-chan/async@4.2.2` from that gate is what let the workspace resolve a dependency published minutes earlier. The rest of the file was reformatted to four-space indentation.

## What did not happen

**Chrome moved, but not in a way that affects ADB.** Chrome 158 continues its rollout — the early-stable channel since November 4, the Android channel since November 5 — and we covered both in the [November 5](https://webadb.online/blog/2026/11/05/ya-webadb-pr-879-closes-adb-sockets-and-adopts-array-from-async/) and [November 6](https://webadb.online/blog/2026/11/06/chrome-158-early-stable-webhid-on-android-and-the-ssm-multicast-shape/) posts. No new Direct Sockets or WebUSB landing landed in the last 24 hours, and per the weekly cadence this is not a Monday, so the Chrome changelog scan was skipped.

**The `@yume-chan/async` releases are not new today.** `4.2.0` published at `2026-11-04T03:15:41Z`, `4.2.1` at `07:20:50Z`, `4.2.2` at `07:35:16Z`. All three are more than 24 hours old. What is new is that `beta.5` is the first ya-webadb release to *depend* on them.

**`ya-webadb`'s `main` branch has not moved since the release.** `origin/main` is still `d22e9dc3`, the release commit itself. The `v3.0.0-beta.5` tag points at the same SHA, and the commit is GPG-signed under key `A8B69F750B9BCEDD`.

## What this means for webadb.online

Two of these changes are directly actionable for this project, and one is a heads-up.

The **socket-close fix** is the one we can verify against our own stack. webadb's File Manager, App Manager, Logcat, and Screencast panels all hold `AdbSocket` objects opened over WebUSB, and every one of them has a path where the panel unmounts or the transport errors while a socket is live. Under beta.4, those sockets leaked on the device side. We are going to bump `ya-webadb` to `3.0.0-beta.5` on a branch, run the existing session-connect and disconnect paths, and check whether the daemon reports a matching socket count before and after a panel teardown. If the count drops, that is a bug fix we have been shipping around for a year.

The **`AudioContext` sharing change** is relevant to the Screencast panel's audio path, which we have not yet wired up but intend to. The relevant constraint for our implementation is that the panel must stop the player without closing the context, and the buffer-clearing fix means a stop/start cycle no longer replays stale audio. We should pass an explicit `AudioContext` into the player rather than relying on the shared registry, so that a future teardown of the panel can decide what to close.

The **`ToArrayStream` and `NOOP` removals** are a heads-up rather than an action, because webadb does not currently import either. But they are the reason to read the beta release notes before the next dependency bump: `NOOP` became `unreachable`, which throws. A project that imports `NOOP` from `@yume-chan/adb` and uses it as a `.catch()` handler would go from "silently ignore" to "throw on every rejection" — the exact opposite of the intent. That is a change worth catching in review rather than in production.

Concretely: the next thing we intend to do is bump the dependency on a branch and verify the socket-close behavior on a real device, since that is the one change in this release with a measurable, observable effect on the device side.
