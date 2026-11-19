---
title: "ya-webadb's scrcpy client gets a generated type-test harness, and Chrome 159 goes early stable"
date: 2026-11-19 01:15:00 UTC
tags:
  - webadb
  - ya-webadb
  - scrcpy
  - uhid
  - typescript
---

[`yume-chan/ya-webadb` PR #880](https://github.com/yume-chan/ya-webadb/pull/880) — "feat(scrcpy): add UHID manager" — moved its head from `0049fc91` to `6bb9151c` overnight, and the diff grew from 63 files / +2274 to **65 files, +3466/−1411** across 11 commits. The one new commit is `6bb9151c3d5bc6cf1e94d7684e99e7cfa3c827b1` ("chore: fix review comments", 2026-11-18 13:14 +0800), and it is not review-response churn about the UHID feature itself. It is a **generated type-test harness**: a 913-line `libraries/adb-scrcpy/src/client.spec.ts` in which 889 of those lines were machine-written (the file was 128 lines before), a 290-line code generator at `libraries/adb-scrcpy/src/generate-client-type-tests.js`, and a small but load-bearing rewrite of the client's conditional getters in `libraries/adb-scrcpy/src/client.ts`.

In the same window Chrome **159** entered Early Stable for desktop, and Chrome 159 for Android started rolling out to a small percentage of users — ahead of the December 8, 2026 scheduled Stable date.

Yesterday's post covered the version-agnostic `ScrcpyUHidManager` interface that `4ff97bc7a193` introduced. The interesting change today is upstream of that: the library has started **proving** that the conditional surface of the scrcpy client is exactly what it claims to be, across every server version and every combination of feature flags, at the type level.

## The conditional-surface problem

`AdbScrcpyClient` has six public members whose *type* depends on runtime options:

```typescript
export class AdbScrcpyClient<TOptions extends ScrcpyOptions<ScrcpyOptionsValue>> {
    get audioStream(): ...;
    get clipboard(): ...;
    get controller(): ...;
    get deviceMessageParser(): ...;
    get uHidManager(): ...;
    get videoStream(): ...;
}
```

Whether `clipboard` is a `ReadableStream<string>` or `undefined` depends on `control` and `clipboardAutosync`. Whether `videoStream` exists depends on `video`. Whether `uHidManager` exists depends on both the scrcpy *server version* (UHID landed in scrcpy 2.4) and on `control` (the UHID control message rides the control socket). And there is a third axis that is easy to forget: `cameraDisablesControl`, introduced in scrcpy 2.2, where requesting `videoSource: "camera"` forces `control` off even if the caller asked for it.

That is 6 versions × up to 4 boolean combinations each. The combinatorial surface is exactly the kind of thing that rots silently: a getter's declared type drifts from what the runtime actually returns, and nothing fails until someone writes `client.deviceMessageParser.close()` against a client whose parser is `undefined`.

## The generated harness

`libraries/adb-scrcpy/src/generate-client-type-tests.js` enumerates the versions and their option profiles:

```javascript
const versions = [
    {
        version: "1.21",
        options: "AdbScrcpyOptions1_21",
        clipboardAutosync: true,
        testOptions: ["control", "clipboardAutosync"],
    },
    {
        version: "2.0",
        options: "AdbScrcpyOptions2_0",
        clipboardAutosync: true,
        audio: true,
        testOptions: ["control", "audio"],
    },
    {
        version: "2.1",
        options: "AdbScrcpyOptions2_1",
        clipboardAutosync: true,
        audio: true,
        video: true,
        testOptions: ["video"],
    },
    {
        version: "2.2",
        options: "AdbScrcpyOptions2_2",
        clipboardAutosync: true,
        audio: true,
        video: true,
        cameraDisablesControl: true,
        testOptions: ["control", "video"],
        videoSourceValues: ["display", "camera"],
    },
    {
        version: "2.4",
        options: "AdbScrcpyOptions2_4",
        clipboardAutosync: true,
        audio: true,
        video: true,
        cameraDisablesControl: true,
        uHidManager: true,
        testOptions: ["control"],
    },
    {
        version: "2.7",
        options: "AdbScrcpyOptions2_7",
        clipboardAutosync: true,
        audio: true,
        video: true,
        cameraDisablesControl: true,
        uHidManager: true,
        testOptions: ["control"],
    },
];
```

The generator then does `2 ** testOptions.length` to get every boolean combination, cross-multiplies by `videoSourceValues` where applicable, and computes the *expected* presence of each field from a single predicate function:

```javascript
function expectedFields(version, profile) {
    const controlEnabled =
        profile.values.control !== "false" &&
        !(version.cameraDisablesControl && profile.videoSource === "camera");
    const control = controlEnabled ? "defined" : "undefined";
    const clipboardAutosyncEnabled = profile.values.clipboardAutosync !== "false";

    return {
        audioStream:
            version.audio && profile.values.audio !== "false"
                ? "defined"
                : "undefined",
        clipboard: controlEnabled && clipboardAutosyncEnabled
            ? "defined"
            : "undefined",
        control,
        deviceMessageParser: control,
        uHidManager: version.uHidManager ? control : "undefined",
        video:
            version.video && profile.values.video === "false"
                ? "undefined"
                : "defined",
    };
}
```

That `uHidManager: version.uHidManager ? control : "undefined"` line is the load-bearing one for yesterday's feature. It encodes the two independent reasons UHID can be absent: the server version doesn't support it (1.15, 2.0, 2.1, 2.2 → `version.uHidManager` is falsy), or control is off.

The output is 22 `it()` blocks. The generated spec uses the classic `Equal<X, Y>` type-identity trick rather than `expect(...).toBe(...)`, because the assertion is about types, not values:

```typescript
type Equal<X, Y> =
    (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
        ? true
        : false;

type HasValue<T> = [Exclude<T, undefined>] extends [never] ? false : true;

type HasUndefined<T> = undefined extends T ? true : false;

function expectTrue<T extends true>(value?: T) {
    void value;
}
```

The `HasValue` / `HasUndefined` pair is the interesting part. A field whose type is `undefined` has `HasValue === false` and `HasUndefined === true`. A field whose type is `ScrcpyUHidManager` has `HasValue === true` and `HasUndefined === false`. A field whose type is `ScrcpyUHidManager | undefined` would have *both* true — and the harness distinguishes that "optional" state from a hard `undefined`:

```javascript
function generatePresenceExpectation(field, state, type) {
    const hasValue = state === "undefined" ? "false" : "true";
    const hasUndefined = state === "defined" ? "false" : "true";
    ...
}
```

So the harness doesn't just assert "the field is present when it should be" — it pins the *exact* type, including whether `undefined` is part of it. A generated block for scrcpy 2.4 with `control: true`:

```typescript
    it("2.4 control-true", async () => {
        if (TypeOnlyTest) {
            const options = new Options.AdbScrcpyOptions2_4({
                control: true,
            });
            const client = await AdbScrcpyClient.start(
                adb,
                DefaultServerPath,
                options,
            );

            expectTrue<
                Equal<
                    typeof client.audioStream,
                    Promise<AdbScrcpyAudioStreamMetadata>
                >
            >();

            expectTrue<
                Equal<typeof client.clipboard, ReadableStream<string>>
            >();

            expectTrue<
                Equal<typeof client.controller, ScrcpyControlMessageWriter>
            >();

            expectTrue<
                Equal<typeof client.videoStream, Promise<AdbScrcpyVideoStream>>
            >();

            expectTrue<
                Equal<HasValue<typeof client.deviceMessageParser>, true>
            >();
            expectTrue<
                Equal<HasUndefined<typeof client.deviceMessageParser>, false>
            >();

            expectTrue<Equal<HasValue<typeof client.uHidManager>, true>>();
            expectTrue<Equal<HasUndefined<typeof client.uHidManager>, false>>();

            void client;
        }
    });
```

The `if (TypeOnlyTest)` guard with `const TypeOnlyTest = false` is a nice trick: the body never executes at runtime, so `AdbScrcpyClient.start(adb, ...)` — which would need a real device — is never called. But the body still *type-checks*, and `expectTrue<T extends true>` fails to compile if `T` is not `true`. The assertions are enforced by `tsc`, not by a test runner. This is the "type tests as compile-time assertions" pattern, and it means the whole 22-case matrix costs nothing at runtime and is checked by the same `tsc --noEmit` that already runs in CI.

## The getter rewrite that made the assertions possible

The commit also rewrote three of the client's getters in `libraries/adb-scrcpy/src/client.ts`. Before:

```typescript
    get deviceMessageParser(): TOptions["createDeviceMessageParser"] extends
        (() => infer R) | undefined
        ? R
        : undefined {
        return this.#deviceMessageParser as never;
    }

    get clipboard(): TOptions["createDeviceMessageParser"] extends
        (() => infer R extends { clipboard: unknown }) | undefined
        ? R["clipboard"]
        : undefined {
        return this.#deviceMessageParser?.clipboard as never;
    }

    get uHidManager(): TOptions["createUHidManager"] extends Function
        ? ReturnType<TOptions["createUHidManager"]>
        : undefined {
        return this.#uHidManager as never;
    }
```

After:

```typescript
type MaybeReturnType<T> = T extends (...args: never[]) => infer R
    ? R
    : undefined;

type MaybeProperty<T, K extends PropertyKey> =
    T extends Record<K, infer R> ? R : undefined;
```

```typescript
    get deviceMessageParser(): MaybeReturnType<
        TOptions["createDeviceMessageParser"]
    > {
        return this.#deviceMessageParser as never;
    }

    get clipboard(): MaybeProperty<
        MaybeReturnType<TOptions["createDeviceMessageParser"]>,
        "clipboard"
    > {
        return this.#deviceMessageParser?.clipboard as never;
    }

    get uHidManager(): MaybeReturnType<TOptions["createUHidManager"]> {
        return this.#uHidManager as never;
    }
```

Three things happened here. First, `MaybeReturnType` and `MaybeProperty` are *named* conditional types instead of inline ones — which is what makes them referable from the generated test's expectations. Second, the `uHidManager` getter's `extends Function` check became `extends (...args: never[]) => infer R`. That is a real bug fix, not a cosmetic one: `extends Function` is true for *any* function including `Function` itself and including constructors, whereas the `(...args: never[]) => infer R` form matches only callables and infers the return type properly. The `eslint-disable-next-line @typescript-eslint/no-unsafe-function-type` comment that used to sit above the `uHidManager` getter is gone — the type is no longer "unsafe."

Third, and most importantly, the `undefined` is now *inside* the conditional type rather than implied by it. The old `deviceMessageParser` getter declared `R` — the parser type — with no `| undefined`. That was flagged in review by CodeRabbit on November 16 ([`discussion_r4583583085`](https://github.com/yume-chan/ya-webadb/pull/880#discussion_r4583583085)):

> When no control stream exists, the constructor leaves `#deviceMessageParser` undefined. This cast removes that possibility from the public type. A caller can compile `client.deviceMessageParser.close()` and then get a runtime error.

The fix routes through `MaybeReturnType`, which yields `undefined` when `TOptions["createDeviceMessageParser"]` is not a callable at all — i.e. when the options object has no such factory. For the versions that *do* have one (1.15 has `createDeviceMessageParser`, but no `createUHidManager` — UHID arrived with scrcpy 2.4), the type is the factory's return type, and the `undefined` comes from the *value* of `control` threaded through `MapBoolean`. The generated harness now *locks both halves in*: `Equal<HasUndefined<typeof client.deviceMessageParser>, true>` for the control-off cases, and `false` for the control-on cases.

## What the harness caught

The generator isn't decorative. It encodes several bugs that were found by exactly this kind of exhaustive enumeration, and one of them is still an open review thread on the PR.

The **1.15 control-off crash** was the first big one. `libraries/scrcpy/src/1_15/options.ts` originally had the parser construction inline in the constructor:

```typescript
    #clipboard: ClipboardStream | undefined;
    get clipboard(): MapBoolean<...> { ... }

    #deviceMessageParsers = new ScrcpyDeviceMessageParsers();
    get deviceMessageParsers() { return this.#deviceMessageParsers; }

    constructor(init: TInit) {
        this.value = computeOptionValues(init, Defaults);

        if (this.value.control) {
            this.#clipboard = this.#deviceMessageParsers.add(
                new ClipboardStream(),
            );
        }
    }
```

The refactor moved this into a `createDeviceMessageParser()` factory that unconditionally constructs `ScrcpyDeviceMessageParser1_15`, whose constructor throws `"control is disabled"` when control is off. But `create-connection.ts` hard-codes `control: true` for 1.15, so the client always opened a control stream, always called the factory, and therefore always threw. CodeRabbit flagged it as "Major · Functional Correctness" ([`discussion_r4583583095`](https://github.com/yume-chan/ya-webadb/pull/880#discussion_r4583583095)):

> `AdbScrcpyClient.start()` therefore rejects for any 1.15 configuration with `control: false`, and the spawned server process is killed.

The generated harness is the permanent guard against a regression of exactly this shape: the `1.21 control-false clipboardAutosync-false` case now asserts `HasValue<typeof client.deviceMessageParser>, false` and `HasUndefined<typeof client.deviceMessageParser>, true`, and every other control-off case is the same shape. (Note that the matrix starts at scrcpy 1.21, not 1.15 — the generator's `versions` array covers 1.21, 2.0, 2.1, 2.2, 2.4 and 2.7. The 1.15 path is the one where the factory *exists* unconditionally and therefore still needs the constructor guard rather than a type-level check.)

The **UHID device-ID collision** was the second. `libraries/scrcpy/src/2_4/impl/uhid-manager.ts` originally allocated IDs from `#devices.size` but never inserted into `#devices` until after the create message was written:

```typescript
    async createDevice(descriptor: Uint8Array) {
        let id: number;
        if (this.#sparseIds.size > 0) {
            id = Math.min(...this.#sparseIds);
            this.#sparseIds.delete(id);
        } else {
            id = this.#devices.size;
        }
        ...
        await Consumable.WritableStream.write(this.#writer, message);
        const output = this.#deviceMessageParser.uHidOutput.addDevice(id);
```

CodeRabbit's note ([`discussion_r4583583103`](https://github.com/yume-chan/ya-webadb/pull/880#discussion_r4583583103)) spelled out the failure: "`#devices` never receives an entry, so every call selects ID `0`. After the first device succeeds, a second call sends another create message with ID `0`, then `addDevice(0)` throws `Device ID already exists: 0`." The fix has to reserve the ID *synchronously* before the first `await`, and roll back if creation fails — the classic allocate-then-commit discipline. This was addressed in commit `79bb6a1`.

The shape that landed is worth reading closely, because it demonstrates the discipline:

```typescript
export class UHidManager<
    T extends Pick<ScrcpyOptions2_4.Init, "control">,
> implements ScrcpyUHidManager {
    #id = 0;

    constructor(
        writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>,
        options: ScrcpyOptions<T>,
        deviceMessageParser: DeviceMessageParser<T>,
    ) {
        if (!options.value.control) {
            throw new Error("control is disabled");
        }
        ...
    }

    async createDevice({ descriptor }: { descriptor: Uint8Array }) {
        const id = this.#id;
        this.#id += 1;

        const output = this.#deviceMessageParser.uHidOutput.addDevice(id);

        try {
            const message = serializeUHidCreateControlMessage({
                type: this.#options.controlMessageTypes[
                    ScrcpyControlMessageType.UHidCreate
                ]!,
                id,
                data: descriptor,
            });
            await Consumable.WritableStream.write(this.#writer, message);

            return new UHidDevice(this.#writer, this.#options, id, output);
        } catch (e) {
            this.#deviceMessageParser.uHidOutput.deleteDevice(id);
            throw e;
        }
    }
}
```

Three separate corrections are visible in that one method. The ID comes from a monotonic `#id` counter that is incremented *before* the first `await`, so two concurrent `createDevice` calls cannot collide — the old `#devices.size` scheme would hand out the same number to two in-flight calls, not just to two sequential ones. The parser registration (`addDevice`) is moved *before* the write so that the device exists in the output stream by the time the server can respond, and it is undone (`deleteDevice`) in the `catch` arm so a failed create doesn't leak a phantom device. And the constructor's `if (!options.value.control) throw new Error("control is disabled")` is the version of the guard that yesterday's post described as living in the getter — it moved into the constructor, where it is enforced at construction time rather than at call time.

The third is still open. CodeRabbit flagged on November 17 ([`discussion_r4596105488`](https://github.com/yume-chan/ya-webadb/pull/880#discussion_r4596105488)) that the public `createUHidManager` factory in `libraries/scrcpy/src/4_0/index.ts` accepts a `ScrcpyDeviceMessageParser` *without* `uHidOutput`, while `UHidManager.createDevice` calls `uHidOutput.addDevice` unconditionally:

> This public factory accepts a `ScrcpyDeviceMessageParser` without `uHidOutput`. The implementation passes that parser to `UHidManager`, whose `createDevice` calls `uHidOutput.addDevice` unconditionally. An argument accepted by this signature therefore causes a `TypeError`.

The same thread asks for the correction to be applied to `4_1` as well, and explicitly notes that "the narrower implementation parameter and `as never` do not enforce the public contract." As of `6bb9151c`, that thread is unresolved — the PR shows 22 review comments and 1 issue comment, and `mergeable_state` is `clean` but `merged` is still `false`.

That last one is the kind of bug that a runtime test suite would catch immediately and a type-level harness *cannot*: the type says "this parser is acceptable" and the implementation then calls a method on it that may not exist. The harness proves the client's *surface* is right; it can't prove the *implementation* honors its own contract. Both halves are needed.

## Chrome 159 goes Early Stable

On November 18, 2026, the Chrome Releases blog posted an [Early Stable Update for Desktop](https://chromereleases.googleblog.com/2026/11/early-stable-update-for-desktop_01707050408.html): the Stable channel moved to **159.0.8154.13/.14** for Windows and Mac, for a small percentage of users. A parallel post rolled out **Chrome 159 (159.0.8154.18)** for Android to a small percentage of users on Google Play. Chrome Beta for Desktop went to 159.0.8154.13, Beta for iOS to 159.0.8154.17, and Beta for Android to 159.0.8154.18.

The scheduled Stable date for the milestone is still **December 8, 2026**, per [Chrome Platform Status](https://chromestatus.com/release-notes/159). Chrome 159 entered Beta on November 12.

Chrome 159's [release notes](https://chromestatus.com/release-notes/159) are, as usual, dominated by WebTransport — eight separate WebTransport features land in this milestone: `congestionControl` (`"default" | "throughput" | "low-latency"`), `WebTransport.getStats()` with RTT and datagram-loss counters, `sendGroup`/`sendOrder` stream and datagram prioritization, `datagramsReadableType: "bytes"` for BYOB reading, `WebTransportReceiveStream.getStats()` with `bytesReceived` vs `bytesRead`, `exportKeyingMaterial()`, and structured-clonable `WebTransportError`. Plus `AccentColor`/`AccentColorText`, `CSSImportRule.styleSheet`, `SpeechRecognitionResult` timestamps, and `navigator.mediaSession.setMicrophoneActive()` / `setCameraActive()` returning promises.

None of that touches WebUSB, WebHID, or the ADB surface directly. But the *release cadence* does: webadb depends on WebUSB for device transport, WebHID for UHID-style input, and `SharedArrayBuffer` (which needs the COOP/COEP headers in `public/_headers`) for the WASM-side work. Chrome 159 landing in Early Stable a month ahead of the December 8 date means the deploy target for those headers and the `chrome://flags`-free behavior of `navigator.usb` can be tested against Stable-adjacent builds this month rather than in December.

The weekly Direct Sockets check was skipped today — that scan runs on Mondays, and today is Thursday.

## What this means for webadb.online

The immediate impact on webadb.online is nil: `ya-webadb`'s `main` branch has not moved since `d22e9dc3` ("chore: release v3.0.0-beta.5", 2026-11-06), and the UHID manager is still an unmerged pull request. The `ScrcpyUHidManager` interface we would need to expose virtual HID devices from the browser is not in a published release.

What *is* relevant is the shape of the change. The library has moved from "the API works" to "the API's type surface is machine-verified across every version and option combination," and it is doing that with generated compile-time assertions rather than runtime tests — which means the check costs nothing on the wire and nothing on the device. When PR #880 lands and a published beta ships with it, the `uHidManager` getter will be either a well-typed `ScrcpyUHidManager` or a well-typed `undefined`, and application code can branch on that without defensive casts.

For our own scrcpy-adjacent work — the screencast panel's H.264 pipeline in particular — the same discipline applies. We hand-roll a lot of version-conditional behavior (device API level gates, `screenrecord` capability probes, the `pm install -S` fallback chain). Each of those is a version-conditional surface that could use the same treatment: a generated matrix of (device capability × feature flag) → expected behavior, checked at compile time where possible and at runtime where not.

Chrome 159's Early Stable rollout means the browser our users actually run is one milestone ahead of the one we test against in CI. Worth re-running the WebUSB connect flow against 159.0.8154 when it reaches broad Stable in December.
