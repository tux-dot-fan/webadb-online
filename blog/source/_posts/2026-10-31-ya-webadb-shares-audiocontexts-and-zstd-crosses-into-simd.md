---
title: "ya-webadb shares AudioContexts, and zstd crosses into SIMD"
date: 2026-10-31 01:00:00 UTC
tags:
  - ya-webadb
  - pcm-player
  - audioworklet
  - zstd
  - webadb
---

Two upstream changes landed in ya-webadb on 2026-10-30, and they point in the
same direction: making the library viable as a real-time media client in a
browser tab. The first gives `@yume-chan/pcm-player` a pool of shared
`AudioContext`s and an auto-resume path that survives the browser's
autoplay policy ([93fce383](https://github.com/yume-chan/ya-webadb/commit/93fce3830b3b2037ee226b02da503d2ff8977913)).
The second bumps the zstd compression adapter's WASM codec from `0.0.58` to
`0.2.6`, a range that includes a `simd128` WebAssembly build
([59e95a0e](https://github.com/yume-chan/ya-webadb/commit/59e95a0e2a6e27606899b6bd3b09fdc80fe601d8)).

Neither change is a user-visible feature release. Both are the kind of
change that determines whether a feature *can* exist, though, and both are
directly relevant to webadb.online: the audio-context work removes a
browser-policy failure mode that any future audio panel would hit, and the
zstd bump is the prerequisite for the compressed ADB sync transport that
would make pushing and pulling large files over WebUSB practical.

This post walks through what the shared-context change actually does, why
the `stop()` semantics had to change with it, and what the zstd version
jump means for a browser-based ADB client.

## The problem with one AudioContext per player

The pre-commit `PcmPlayer` constructor looked like this:

```typescript
constructor(sampleRate: number, channelCount: number) {
    this.#context = new AudioContext({
        latencyHint: "interactive",
        sampleRate,
    });
    this.#channelCount = channelCount;
}
```

Every player instance allocated its own `AudioContext`, and `stop()` closed
it:

```typescript
async stop() {
    if (this.#stopped) {
        return;
    }
    this.#stopped = true;

    this.#worklet?.disconnect();
    this.#worklet = undefined;

    await this.#context.close();
}
```

That works, but it has two costs that only show up once you have more than
one player, or once you stop and restart.

The first cost is **resource duplication**. An `AudioContext` is not a
lightweight object. It owns an audio rendering thread, its own clock, and —
once you touch `audioWorklet` — a separate rendering graph with its own
allocation. Two players at 48 kHz stereo means two rendering threads, two
clocks, and two independent latency measurements. The `outputLatency` getter
on `PcmPlayer` reports whichever context that particular player happens to
own, so with N players you get N different latency numbers that do not
agree with each other.

The second cost is **the `stop()` → restart → dead context problem**, and
this is the one that actually breaks. `AudioContext.close()` is
irreversible. The README documents the consequence directly:

```ts
var player = Int16PcmPlayer(44100);
player.start();
player.feed(new Int16Array([0, 0, 0, 0, 0, 0, 0, 0]));
player.stop(); // `AudioContext` will be closed, so can't be restarted
```

So the old API made a player a one-shot object. There was exactly one
lifecycle: construct → start → feed → stop. If you wanted to play a second
clip after the first, you had to construct a *new* player, which meant a
*new* `AudioContext`, which meant paying the full construction cost again.

The commit changes this in three coordinated moves.

### Move one: a context pool keyed by sample rate

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

The pool is keyed by `sampleRate` and nothing else. That is the right
granularity: an `AudioContext` has a single fixed sample rate for its
entire lifetime — you cannot change it after construction — so two players
can only share a context if they agree on the rate. The
`latencyHint: "interactive"` setting is preserved from the old
per-player construction, so pooling does not change the latency class.

The constructor now takes an optional context and falls back to the pool:

```typescript
constructor(
    sampleRate: number,
    channelCount: number,
    context?: AudioContext,
) {
    this.#context = context ?? getSharedContext(sampleRate);
    this.#channelCount = channelCount;
}
```

The optional third parameter is the escape hatch. A caller that wants
complete control over the context — an `OfflineAudioContext` for
rendering to a buffer, or a context with a specific `latencyHint` — can
pass one in. A caller that does not care gets the shared one. Note the
parameter is positional-optional rather than an options bag, which is
slightly unusual for the codebase but keeps the diff minimal.

Channel count is *not* part of the pool key, and it does not need to be.
`AudioWorkletNode` takes `outputChannelCount` per node, so two players
sharing one context can output different channel counts:

```typescript
this.#worklet = new AudioWorkletNode(this.#context, this.sourceName, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [this.#channelCount],
});
```

The context is the clock and the rendering thread; the node is the channel
configuration. That separation is what makes the pool sound.

### Move two: memoized worklet module loading

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

`audioWorklet.addModule()` compiles and instantiates the processor's
JavaScript. It is not free, and it is *per-context*: each `AudioContext`
has its own `audioWorklet` namespace and needs its own module registration.
So the natural optimization is to not re-add the module for the same
context twice.

The `WeakMap` is the interesting part. It keys on the context object, and
weak keys mean the entry disappears when the context is garbage collected —
no leak if a caller manages their own context lifecycle outside the pool.
It stores the *promise*, not the resolved value, so that two concurrent
`start()` calls on the same context share one in-flight `addModule()` rather
than issuing two compilations. The old code called `addModule()` on every
`start()`, which meant every player start triggered a fresh worklet
compilation even when the module was already registered in that context.

### Move three: the context is no longer closed on stop

```typescript
stop() {
    if (this.#stopped) {
        return;
    }
    this.#stopped = true;

    this.#worklet?.disconnect();
    this.#worklet = undefined;

    this.#buffers.length = 0;

    // Do not close the AudioContext as it might be shared.
}
```

This is the change that requires the other two. Because the context may be
shared, `stop()` cannot close it — closing it would kill every other player
using the same context. Instead it disconnects the worklet node and drops
the buffered samples.

Two details are easy to miss:

**`stop()` is no longer `async`.** The old signature was
`async stop()` because it awaited `this.#context.close()`. With the close
removed there is nothing to await, and the follow-up commit
([59e95a0e](https://github.com/yume-chan/ya-webadb/commit/59e95a0e2a6e27606899b6bd3b09fdc80fe601d8))
drops the `async` keyword entirely, which is what the lint fix in that
commit was actually about. This is a **breaking API change** for anyone who
was `await`ing `stop()` — `await` on a non-promise is harmless in JS, so
existing call sites keep working, but the type signature changes from
`Promise<void>` to `void` and TypeScript will notice.

**`this.#buffers.length = 0` is new.** Previously the buffers were left
alone on `stop()`. Now they are explicitly cleared, which is correct: the
buffer holds queued samples that were fed before `start()` was called, and
after `stop()` they are dead weight that would be replayed if the player
were somehow restarted.

The `#stopped` flag still makes the player one-shot in the same sense as
before — `feed()` throws `new Error("PcmPlayer is stopped")` after a stop,
and `start()` early-returns if `#stopped` is set. What changed is that
*stopping a player no longer destroys the shared context*, so a *new* player
created afterwards can immediately use it.

## The auto-resume path and the autoplay policy

The other half of the feature is `#tryResuming`:

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

This is the part that matters most in practice, because it deals with
Chrome's autoplay policy.

An `AudioContext` created before any user gesture starts in the
`suspended` state. The audio graph exists, `process()` calls still fire on
the rendering thread, but the output is not connected to the destination —
or, more precisely, the context's output produces silence. This is
Chrome's way of saying "you may not make noise until the user has
interacted with the page." The context transitions to `running` on a user
gesture, and `context.resume()` can also do it from a gesture handler.

The problem for a *streaming* audio client is timing. Consider: the user
clicks "Connect device", which is a user gesture. The ADB session comes up,
the shell starts, and the PCM stream begins flowing a few seconds later.
By the time the first samples arrive, is the context still `running`?

In the good case, yes. In the bad case, no — and the reasons are subtle:

1. **The gesture was in a different task.** Chrome's autoplay policy
   tracks whether the document has *ever* had a user activation, not
   whether the current call stack descends from a gesture. `navigator.userActivation.hasBeenActive`
   captures exactly that broader question, and the check in `#tryResuming`
   uses it.

2. **Something suspended the context.** Chrome suspends an `AudioContext`
   when the page goes to the background, when the tab is hidden, or when
   the device's audio session is interrupted (a phone call on the host
   machine, another app taking exclusive audio). The context comes back
   `suspended` after the tab is foregrounded again, with no user gesture
   involved.

3. **The context was created lazily inside the pool.** If the first player
   for a given sample rate is constructed after the gesture, its context is
   born post-activation and starts `running`. But if the pool already had a
   context from before the gesture, the new player inherits a `suspended`
   one.

In all three cases, the symptom is identical: the worklet is running, the
samples are being consumed, the buffer counters are moving, and the user
hears nothing. There is no error, no exception, no console warning. The
panel would just sit there mute, and the natural debugging instinct —
"maybe the stream is broken" — points in exactly the wrong direction.

The fix is to attempt a resume opportunistically at every point where
samples enter the system:

```typescript
feed(source: T) {
    if (this.#stopped) {
        throw new Error("PcmPlayer is stopped");
    }

    if (this.#worklet === undefined) {
        this.#buffers.push(source);
        return;
    }

    this.#tryResuming();
    this.feedCore(this.#worklet, source);
}
```

and again in `start()`, after the worklet is connected:

```typescript
this.#worklet.connect(this.#context.destination);

this.#tryResuming();

for (const source of this.#buffers) {
    this.feedCore(this.#worklet, source);
}
```

Note the `feed()` placement — the resume attempt happens *after* the
`#worklet === undefined` early return. Before `start()`, there is no
worklet to feed, so the samples are queued and no resume is attempted.
That is correct: resuming a context with no connected output graph would
just start the rendering thread producing silence.

Two defensive details are worth calling out:

- **`navigator.userActivation.hasBeenActive` is checked before
  `resume()` is called.** Calling `resume()` without an activation is
  rejected by the browser, and an unhandled rejection in a `void`-ed
  promise is exactly the kind of thing that shows up as an uncaught
  error in the console and hides the real problem. Checking first means
  the common case (user has interacted at some point) attempts the resume,
  and the rare case (no activation ever) silently does nothing.

- **The `.catch(() => {})` swallows the rejection.** `resume()` can fail
  for reasons other than the autoplay policy — the context might have been
  closed, or the browser might refuse for a reason that is not worth
  interrupting the audio pipeline over. Swallowing it keeps the audio path
  from throwing, and the user-visible symptom (still muted) is the same
  as before, so there is no information lost.

`navigator.userActivation` is a fairly recent addition to the platform
(Chrome 77+), which is well within the baseline for anything that supports
WebUSB and Web Audio anyway.

## What the worklet actually does with the samples

The `worker/worker.ts` file is unchanged by this commit, but it explains
why the buffering behaviour in `PcmPlayer` is shaped the way it is.

The processor is a resampler with an overlap-add (OLA) window. `SCALE = 0.9`
means the input is consumed at 90% of real time — 3000 input samples per
hop produce 2700 output samples. That 10% headroom is what lets the
processor *speed up* when it falls behind:

```typescript
if (!this.#speedUp && this.#totalSampleCount > 0.25 * 48000) {
    this.#speedUp = true;
    this.#readOffset = 0;
    this.#inputOffset = 0;
    this.#outputOffset = 0;
}
```

Once the backlog exceeds a quarter second of samples, the processor switches
into `#speedUp` mode and runs the Hann-weighted OLA window to burn through
the excess rather than playing it all in real time. There is a hysteresis
band — it drops back out of speed-up mode only when the backlog falls below
0.15 seconds.

The practical implication for the `PcmPlayer` API is that `feed()` before
`start()` is not an error, it is queued.

```typescript
if (this.#worklet === undefined) {
    this.#buffers.push(source);
    return;
}
```

Samples fed before the worklet exists are held and replayed once
`start()` connects the node. And `start()` is where the context finally
becomes eligible to run:

```typescript
async start() {
    await addWorkletModule(this.#context);

    if (this.#stopped) {
        return;
    }
    ...
}
```

The `if (this.#stopped) return;` check after the `await` is a
race-condition guard: `addModule()` is asynchronous, so `stop()` could
have been called while the module was compiling. Without the check, the
player would create a worklet node and connect it to a context that the
caller already stopped using.

## The zstd jump: 0.0.58 → 0.2.6

The second change is a dependency bump that crosses the `0.1.0` boundary,
and it is easy to miss because it is buried in a commit whose subject line
is "fix lint error".

The diff in `libraries/adb-compression-zstd/package.json`:

```diff
     "dependencies": {
-        "@structured-world/structured-zstd": "^0.0.58",
+        "@structured-world/structured-zstd": "^0.2.6",
```

The upstream package's publish timeline makes the significance clear:
`0.0.58` (2026-10-01) → `0.0.59` (10-08) → `0.1.0` (10-10) → `0.1.1`
(10-10) → `0.2.0` (10-12) → `0.2.1` (10-16) → `0.2.2` (10-17) → `0.2.3`
(10-19) → `0.2.4` (10-21) → `0.2.5` (10-22) → `0.2.6` (10-26).

Eleven releases in twenty-six days, and the ya-webadb bump landed on
2026-10-30 — four days after `0.2.6` shipped. The package is a pure-Rust
Zstandard implementation compiled to WebAssembly, and the `0.1.0` release is
where it stabilized its public API:

```typescript
import {
    createCompressStream as createCompressStreamRaw,
    createDecompressStream as createDecompressStreamRaw,
} from "@structured-world/structured-zstd";
```

### What the codec actually does for an ADB client

Zstandard in the ADB protocol is not a cosmetic feature. The ADB sync
protocol (`sendrecv_v2`) supports multiple compression algorithms for file
transfer, and the device advertises which ones it accepts in its feature
string:

```
shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,fixed_push_symlink_timestamp,
abb_exec,remount_shell,track_app,sendrecv_v2,sendrecv_v2_brotli,
sendrecv_v2_lz4,sendrecv_v2_zstd,sendrecv_v2_dry_run_send,openscreen_mdns
```

`cmd` and `shell_v2` are the shell protocol versions. `sendrecv_v2_zstd`
means the device will accept zstd-compressed sync traffic. Modern Android
devices advertise all three of brotli, lz4, and zstd.

Without a compression adapter, a browser-based client falls back to the
uncompressed sync path. For webadb.online's File Manager, that means every
`adb push` of an APK or an APK split — files that are *already* compressed
and therefore barely compressible — goes over WebUSB uncompressed, and
files that *are* compressible (text, images, resources) pay full size.

### The SIMD part

The upstream README describes the two-payload design:

> **Automatic SIMD.** Ships two payloads — one built with the WebAssembly
> `simd128` SIMD tier, one scalar — and picks the fast one at runtime via
> engine feature detection. You import one package; the right `.wasm` loads.

And the selection mechanism:

> WebAssembly has no runtime CPU detection, so SIMD selection is an engine
> **capability** probe (`wasm-feature-detect` `simd()`): when the host
> supports wasm SIMD the `simd128` payload loads, otherwise the scalar one.
> In Node.js the `.wasm` bytes are read from disk; in the browser/Deno
> they are fetched relative to the module.

This matters for a browser ADB client in a specific way: the codec runs in
a **Web Worker**, off the main thread, so the SIMD gain translates directly
into sync throughput rather than into UI jank. The ya-webadb adapter is
already worker-aware — `registerZstdCompression` accepts a `worker` option
that defaults to `"auto"`, meaning "use a worker if we are on the main
thread":

```typescript
export function registerZstdCompression(
    options: {
        worker?: "auto" | boolean | undefined;
        compressionLevel?: number | undefined;
    } = {},
) {
    AdbSync.Compression.registerCompressionAdapter(
        ...
```

The worker wrapper uses Comlink for the proxy and terminates the worker on
error so a failed compression attempt does not leave a dangling thread:

```typescript
function cleanupOnError<T>(worker: Worker | undefined, callback: () => T): T {
    if (!worker) {
        return callback();
    }

    try {
        const result = callback();
        if (result instanceof Promise) {
            return result.catch((e) => {
                worker.terminate();
                throw e;
            }) as T;
        }
        return result;
    } catch (e) {
        worker.terminate();
        throw e;
    }
}
```

Combined with a `simd128` build, this is the difference between a zstd
adapter that keeps up with a USB 3 connection and one that does not.

### The streaming API is what the sync protocol needs

The 0.1.0 API added incremental streaming, which is what a sync transfer
actually needs — you cannot buffer a 200 MB APK in memory to compress it
in one shot:

```typescript
const stream = await createCompressStream(19);
const out: Uint8Array[] = [];
for await (const chunk of source) out.push(stream.push(chunk));
out.push(stream.finish()); // final block + checksum, seals the frame stream
stream.free(); // release the wasm handle
```

The key property, from the upstream README: `push(chunk)` returns the
compressed bytes complete so far, and "the frame omits
`Frame_Content_Size` (unknown while streaming) yet decodes in any compliant
zstd decoder, including the native C library." That omission matters for
interop — a normal zstd frame header declares its decompressed size so the
decoder can allocate the output buffer in one shot, but a streaming frame
cannot know that up front, so the decoder has to grow its buffer as it
goes. The Android side has to accept that, and it does, since
`sendrecv_v2_zstd` is advertised by the device's own adbd.

## Upstream housekeeping: PR #849 closed as inactive

The same day, ya-webadb's maintainer closed
[PR #849](https://github.com/yume-chan/ya-webadb/pull/849) — "use one-shot
format in getDeviceFeatures for multi-device support" — with the note
"Close as inactive".

The PR is worth reading even though it was not merged, because it
documents a genuine protocol subtlety in the ADB server.

The bug: `AdbServerClient.getDeviceFeatures()` fails with
`"more than one device/emulator"` when more than one Android device is
connected to the host running the ADB server. The reporter's trace against
a real ADB server (version 37.0.0, protocol 41) is the useful part:

```
# Two-step protocol (FAILS with multiple devices):
Send: host:transport-id:270 → OKAY
Send: host:features → FAIL "more than one device/emulator"

# One-shot format (WORKS):
Send: host-transport-id:270:features → OKAY + features ✅
Send: host-serial:e986b63e:features → OKAY + features ✅

# Device-level after switch (WORKS - for reference):
Send: host:transport-id:270 → OKAY
Send: shell:echo hello → OKAY ✅
```

The explanation is that a transport switch sets the device context for
*device-level* services (`shell:`, `sync:`, `reverse:`) but the ADB server
does not inherit that context for *host-level* services like
`host:features`.

But ya-webadb's current implementation does not use the plain two-step
form. It goes through `createDeviceConnection(device, "host:features")`,
and the code carries a long comment explaining why:

```typescript
// On paper, `host:features` is a host service (device features are cached in host),
// so it shouldn't use `createDeviceConnection`,
// which is used to forward the service to the device.
//
// However, `createDeviceConnection` is a two step process:
//
//    1. Send a switch device service to host, to switch the connection to the device.
//    2. Send the actual service to host, let it forward the service to the device.
//
// In step 2, the host only forward the service to device if the service is unknown to host.
// If the service is a host service, it's still handled by host.
//
// Even better, if the service needs a device selector, but the selector is not provided,
// the service will be executed against the device selected by the switch device service.
// So we can use all device selector formats for the host service,
// and get the transport ID in the same time.
```

So ya-webadb's two-step flow is *intentional* and *correct*: because the
switch already selected a device, the unqualified `host:features` is
executed against that device. This works — the maintainer verified it
against two real devices on WSL2, Ubuntu 22.04, and Ubuntu 24.04, with
output matching `adb -s <serial> features` exactly. The reporter's issue
was specific to an Ubuntu 22.04 environment that the maintainer could not
reproduce, and the thread went inactive in July when the reporter stopped
responding.

The maintainer's stated preference frames the trade-off correctly: he would
accept the PR's workaround as a *fallback* rather than a replacement, since
"the alternative might not return correct transport ID like the current
method." The proposed one-shot `formatDeviceService()` path does not return
a transport ID, which `getDeviceFeatures()` needs to construct an
`AdbBanner` and to key the transport. A fallback would therefore have to be
a second code path with different return semantics — a reasonable thing to
avoid in a library where the current path is correct in every reproducible
environment.

For webadb.online this is a non-issue in practice: the project talks to
`adbd` directly over WebUSB, not through an ADB *server*, so
`AdbServerClient` is not on our path at all. It matters to Node.js-based
tooling that connects to a local `adb` server with several devices
attached.

## What this means for webadb.online

The `@yume-chan/pcm-player` changes are the interesting part, and they
change our roadmap rather than our code.

webadb.online currently ships thirteen panels — Terminal, File Manager,
Logcat, App Manager, Screencast, Clipboard, Settings, and others — and
none of them play audio from the device. Android's `scrcpy` server supports
audio forwarding (since scrcpy 2.0), and ya-webadb has a scrcpy client
library, so an audio panel is a plausible next feature: connect a device,
run the scrcpy server with `--audio-source=output`, forward the PCM stream,
and play it.

Every one of the failure modes the `93fce383` commit addresses would have
hit that panel on day one:

- **The muting-with-no-error problem.** A device that produces audio
  perfectly well, a scrcpy server that forwards it correctly, and a panel
  that shows a live meter with moving numbers but produces no sound. With
  the old code, that is a genuinely hard bug to diagnose from the UI
  because nothing throws. With `#tryResuming`, the context recovers from a
  tab-switch suspend the next time a sample arrives.

- **The multi-player cost.** A panel with an audio stream *and* a
  screencast running simultaneously is two audio contexts plus one video
  pipeline. Sharing the context keeps the audio rendering thread count at
  one.

- **The restart problem.** A device disconnects and reconnects, and the
  panel wants to resume audio. With the old semantics the context was
  closed and a new one had to be constructed from scratch — including
  re-running the autoplay gesture check, which may no longer be satisfiable
  because the user's original click was many seconds ago. With the shared
  pool, the reconnect reuses a context that has already been activated.

The zstd bump matters for a different panel: File Manager. Our
`pushBytes` / `pullBytes` helpers go through the ADB sync service over
WebUSB, and WebUSB bulk transfers are noticeably slower than they look.
Compression is the lever. Right now webadb.online does not register a
compression adapter at all — we are on `@yume-chan/adb@3.0.0-beta.1` and do
not depend on `@yume-chan/adb-compression-zstd` — so every file transfer is
uncompressed. Pulling in the zstd adapter is now a much smaller job than it
was, because the codec's streaming API is stable at `0.2.x` and the
`simd128` build means the compression happens fast enough to keep up with
the USB pipe.

Both of these are upstream-only changes this week — webadb.online's own
code did not change — but they remove two specific blockers from our
backlog rather than adding generic capability. The next local commit that
touches `package.json` should probably be the one that moves us from
`3.0.0-beta.1` to `3.0.0-beta.4` and adds the zstd compression adapter.

The Chrome Direct Sockets check was skipped this week — that source is
only scanned on Mondays — so this post covers upstream ya-webadb activity
only.
