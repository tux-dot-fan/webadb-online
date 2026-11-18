---
title: "ya-webadb's UHID manager grows a version-agnostic interface, and Chrome 158 goes stable"
date: 2026-11-18 01:20:00 UTC
tags:
  - webadb
  - ya-webadb
  - scrcpy
  - uhid
  - chromium
---

[`yume-chan/ya-webadb` PR #880](https://github.com/yume-chan/ya-webadb/pull/880) — "feat(scrcpy): add UHID manager" — got restructured overnight in a way that matters more than the feature itself. The pull request's head moved from `b8cb5b58` to `0049fc91`, it grew from seven commits to ten, and its diff ballooned from 54 files to **63 files, +2274/−1298**. The three new commits are not review-response churn: `4ff97bc7a193` ("feat(scrcpy): add UHID manager and device interfaces") adds a brand-new version-agnostic interface layer, `b6eac74d9df9` is a formatting pass, and `0049fc91f141` is a dependency bump. In the same window Chrome **158** went stable on all three desktop platforms.

Yesterday's post described the per-version `UHidManager` classes as they existed on November 16. The interesting change is that those classes are no longer the public API. There is now a single interface, and the per-version classes are implementation details behind it.

## The new abstraction: `base/uhid.ts`

The new file `libraries/scrcpy/src/base/uhid.ts` is thirty-one lines and contains the entire public surface for virtual HID devices:

```typescript
export interface ScrcpyUHidManager {
    createDevice(device: {
        name: string;
        vendorId: number;
        productId: number;
        descriptor: Uint8Array;
    }): Promise<ScrcpyUHidDevice>;

    close?(): Promise<undefined>;
}

export interface ScrcpyUHidDevice {
    readonly id: number;

    readonly output: ReadableStream<ScrcpyUHidOutputDeviceMessage>;

    readonly name?: string;

    readonly productId?: number;
    readonly vendorId?: number;

    readonly destroyed?: boolean;

    sendReport(report: Uint8Array): Promise<undefined>;

    destroy?(): Promise<undefined>;
}
```

Note the shape of the optionality. `close?` and `destroy?` are optional on the *manager* and *device* interfaces respectively, but `createDevice` and `sendReport` are not — those are the two operations that cannot be absent. `name`, `vendorId`, `productId` and `destroyed` are all optional properties on the device, which means the interface is satisfiable by a minimal implementation that only tracks an ID.

This is the fix for the mess described yesterday. The 2.4-era `createDevice(descriptor)` takes a bare descriptor; the 2.7-era one takes `(name, vendorId, productId, descriptor)`; the 3.1-era one differs again. Under the old shape, an application that wanted to work with any scrcpy version had to either feature-detect the version and branch, or accept `any`. Under the new shape, the *arguments* are uniform — always an options object with all four fields — and the divergence moves entirely behind the implementation. A caller writes `manager.createDevice({ name, vendorId, productId, descriptor })` and it works against scrcpy 2.4, 2.7, 3.1, 3.2, 3.3.1, 4.0 and 4.1.

The reason 2.4 can accept a name and vendor/product IDs is that the wire format for `UHID_CREATE` changed between server versions, but the *client-side intent* did not. The manager's job is to accept the full intent and drop whatever the negotiated server version cannot express.

## `createUHidManager` changed from a method to a getter

The options object got a new optional member in `libraries/scrcpy/src/base/options.ts`:

```typescript
export interface ScrcpyOptions<T extends object> {
    // ...
    serializeUHidCreateControlMessage?(
        message: ScrcpyUHidCreateControlMessage,
    ): Uint8Array;

    createUHidManager?:
        | ((
              writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>,
              deviceMessageParser: ScrcpyDeviceMessageParser,
          ) => ScrcpyUHidManager)
        | undefined;
}
```

And the per-version options classes implement it as a **getter** rather than a method. Before this commit, `ScrcpyOptions4_0` had:

```typescript
createUHidManager(
    writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>,
    deviceMessageParser: DeviceMessageParser<ScrcpyOptions4_0.Value<TInit>>,
): MapBoolean<
    ScrcpyOptions4_0.Value<TInit>["control"],
    UHidManager<ScrcpyOptions4_0.Value<TInit>>,
    undefined
> {
    return new UHidManager(writer, this, deviceMessageParser) as never;
}
```

That version had a real problem, and CodeRabbit flagged it in three separate review threads (`libraries/scrcpy/src/4_0/index.ts` line 199, `libraries/scrcpy/src/3_3_1/options.ts` line 199, `libraries/scrcpy/src/2_4/options.ts` line 200): the declared return type was `undefined` when `control` is false, but the body *unconditionally* constructed a `UHidManager`, which in turn throws `new Error("control is disabled")` from its constructor. The type said "returns undefined" and the runtime said "throws".

The new shape fixes that by moving the conditional to the factory itself:

```typescript
get createUHidManager(): MapBoolean<
    this["value"]["control"],
    (
        writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>,
        deviceMessageParser: DeviceMessageParser<this["value"]>,
    ) => UHidManager<this["value"]>,
    undefined
> {
    return (this.value.control
        ? (
              writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>,
              deviceMessageParser: DeviceMessageParser<this["value"]>,
          ) => new UHidManager(writer, this, deviceMessageParser)
        : undefined) satisfies
        | ((
              writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>,
              deviceMessageParser: DeviceMessageParser<this["value"]>,
          ) => UHidManager<this["value"]>)
        | undefined as never;
}
```

The distinction is subtle and it is the kind of thing that trips people up. A **method** is called immediately — `options.createUHidManager(writer, parser)` — so the `control` check has to happen inside the call. A **getter returning a factory** is accessed without calling it — `options.createUHidManager` — and the factory is only invoked if the caller actually wants a manager. So the guard can now live at the *access* site, where `control` is still known, and the returned value is `undefined` rather than a throw.

This is the same pattern the library already uses for `createDeviceMessageParser`, which was itself converted from a method to a getter in the same PR. Both are now "capability accessors": ask the options object whether you can have the thing, get `undefined` if not, and get a constructor if so.

The `satisfies ... as never` double-cast at the end is the library's established workaround for the `MapBoolean` conditional type not being directly inferrable. It is ugly and it appears in every versioned options file — twelve of them, judging by the diff.

## The client side: `#uHidManager` on `AdbScrcpyClient`

`libraries/adb-scrcpy/src/client.ts` gained twenty-three lines and lost six, and the shape of the change is the same idea applied one level up:

```typescript
#uHidManager: ScrcpyUHidManager | undefined;

get uHidManager(): TOptions["createUHidManager"] extends Function
    ? ReturnType<TOptions["createUHidManager"]>
    : undefined {
    return this.#uHidManager as never;
}
```

and at construction time:

```typescript
this.#uHidManager = options.createUHidManager?.(
    writer,
    deviceMessageParser,
);
```

The `?.` call on an optional factory is what makes the whole thing degrade gracefully. If `control` is disabled, `options.createUHidManager` is `undefined`, the optional call short-circuits, and `#uHidManager` stays `undefined`. The client never throws at construction time for a control-less session — it simply has no UHID capability.

The getter's return type is derived through `TOptions["createUHidManager"] extends Function ? ReturnType<...> : undefined`. For an options class whose `control` is statically `true`, this resolves to `UHidManager<...>`; for one whose `control` is statically `false`, it resolves to `undefined`. The type follows the value.

Compare that with the sibling getter immediately above it, `get deviceMessageParser()`, which uses `TOptions["createDeviceMessageParser"] extends (() => infer R) | undefined ? R : undefined`. The `infer R` form is needed there because the parser's type is version-specific. The UHID getter uses `ReturnType<>` instead, because after this refactor the manager type is the version-agnostic `ScrcpyUHidManager` — there is nothing version-specific left to infer. That difference in the type-level machinery is itself a signal that the abstraction worked.

## The base device-message contract grew a second optional capability

`libraries/scrcpy/src/base/device-message.ts` was previously a flat collection of parser streams. It is now an interface with named capabilities:

```typescript
export interface ScrcpyDeviceMessageParser {
    readonly clipboard?: ReadableStream<string> | undefined;

    readonly uHidOutput?: ScrcpyUHidOutputStream | undefined;

    readonly ackClipboardHandler?:
        ScrcpyDeviceMessageClipboardAckHandler | undefined;

    parse(id: number, stream: AsyncExactReadable): Promise<undefined>;

    close(): void;

    error(e?: unknown): void;

    serializeSetClipboardControlMessage?(
        message: ScrcpySetClipboardControlMessage,
    ): Uint8Array | [Uint8Array, Promise<void>];
}
```

Three capabilities, each optional, each independently absent depending on what the negotiated scrcpy version and the enabled feature set support:

- `clipboard` — the clipboard autosync stream, present when the version supports clipboard and autosync is on.
- `uHidOutput` — the demultiplexing output stream, present when the version supports UHID.
- `ackClipboardHandler` — the clipboard-acknowledgement resolver, present when the version supports the `ACK_CLIPBOARD` device message (scrcpy 1.21+).

The `ackClipboardHandler` is the newest of the three and it is the piece that makes the clipboard path correct across versions. The device message `ACK_CLIPBOARD` carries a 64-bit `sequence` number, and the client has to resolve the specific pending write when the ack arrives:

```typescript
export const AckClipboardDeviceMessage = struct(
    { sequence: u64 },
    { littleEndian: false },
);

export class AckClipboardHandler
    implements
        ScrcpyDeviceMessageHandler,
        ScrcpyDeviceMessageClipboardAckHandler
{
    #resolvers = new Map<bigint, PromiseResolver<void>>();

    #closed = false;

    async parse(stream: AsyncExactReadable): Promise<undefined> {
        const message = await AckClipboardDeviceMessage.deserialize(stream);
        const resolver = this.#resolvers.get(message.sequence);
        if (resolver) {
            resolver.resolve();
            this.#resolvers.delete(message.sequence);
        }
    }
```

The `u64` sequence is why the map is keyed by `bigint` and not `number`. A JavaScript `number` cannot represent a 64-bit integer exactly, and the scrcpy protocol treats the sequence as an opaque 64-bit value — using `number` would silently corrupt any sequence above 2^53. The same commit that adds UHID interfaces also fixes the clipboard ack's key type.

And `close()` on the handler rejects every outstanding resolver with `"Control socket closed before acknowledgment"` — which is a much better failure mode than leaving a `setClipboard` promise pending forever when the socket dies mid-write.

## Control-channel messages for UHID, at last

The new file `libraries/scrcpy/src/control/uhid.ts` is the protocol definition for the two control messages UHID needs beyond `UHID_CREATE`:

```typescript
export const ScrcpyUHidInputControlMessage = struct(
    {
        // value of `type` can change between versions
        type: u8,
        id: u16,
        data: buffer(u16),
    },
    { littleEndian: false },
);

export const ScrcpyUHidDestroyControlMessage = struct(
    {
        // value of `type` can change between versions
        type: u8,
        id: u16,
    },
    { littleEndian: false },
);
```

Big-endian throughout, matching the rest of the scrcpy control protocol. The `// value of type can change between versions` comment is the library's way of saying "the discriminator is version-specific, do not hardcode it" — which is exactly why `serializeUHidCreateControlMessage` lives in per-version `impl` directories while the *message shape* lives in the shared `control/` directory.

The writer picked up three corresponding methods:

```typescript
uHidCreate(message: Omit<ScrcpyUHidCreateControlMessage, "type">) {
    return this.write(this.#serializer.uHidCreate(message));
}

uHidInput(message: Omit<ScrcpyUHidInputControlMessage, "type">) {
    return this.write(this.#serializer.uHidInput(message));
}

uHidDestroy(id: number) {
    return this.write(this.#serializer.uHidDestroy(id));
}
```

Compare with `setClipboard` directly above them, which has to handle a two-element return:

```typescript
async setClipboard(
    message: Omit<ScrcpySetClipboardControlMessage, "type">,
) {
    const result = this.#serializer.setClipboard(message);
    if (result instanceof Uint8Array) {
        await this.write(result);
    } else {
        suppressUnhandledRejection(result[1]);
        await this.write(result[0]);
        await result[1];
    }
}
```

The `Uint8Array | [Uint8Array, Promise<void>]` union is the version-dependent bit: scrcpy 1.21+ sends a `sequence` and the server acks it, so the serializer returns the bytes *and* a promise for the ack. Older versions have no ack, so it returns just the bytes. The `suppressUnhandledRejection(result[1])` call before the `await` is a subtle race guard — if the write fails before the ack promise is awaited, the ack promise would otherwise be an unhandled rejection. This is the same class of bug as ya-webadb issue #876, which was fixed in PR #878 and is visible here as a defensive pattern.

## The per-version managers, post-refactor

The `3_1` manager — the one that yesterday's post quoted in its pre-refactor form — now looks like this:

```typescript
export class UHidManager<
    T extends Pick<ScrcpyOptions3_1.Init, "control">,
> implements ScrcpyUHidManager {
    #writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>;
    #options: ScrcpyOptions<T>;
    #deviceMessageParser: DeviceMessageParser<T>;
    #devices = new Map<number, UHidDevice<T>>();
    #sparseIds = new Set<number>();

    constructor(
        writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>,
        options: ScrcpyOptions<T>,
        deviceMessageParser: DeviceMessageParser<T>,
    ) {
        if (!options.value.control) {
            throw new Error("control is disabled");
        }
        // ...
    }

    async createDevice({
        name,
        vendorId,
        productId,
        descriptor,
    }: {
        name: string;
        vendorId: number;
        productId: number;
        descriptor: Uint8Array;
    }) {
        let id: number;
        if (this.#sparseIds.size > 0) {
            id = Math.min(...this.#sparseIds);
            this.#sparseIds.delete(id);
        } else {
            id = this.#devices.size;
        }

        const cleanup = () => {
            this.#deviceMessageParser.uHidOutput.deleteDevice(id);
            this.#devices.delete(id);
            this.#sparseIds.add(id);
        };

        const output = this.#deviceMessageParser.uHidOutput.addDevice(id);

        const device = new UHidDevice(
            this.#writer,
            this.#options,
            this.#deviceMessageParser,
            id,
            name,
            vendorId,
            productId,
            output,
            cleanup,
        );
        this.#devices.set(id, device);

        try {
            const message = serializeUHidCreateControlMessage({
                type: this.#options.controlMessageTypes[
                    ScrcpyControlMessageType.UHidCreate
                ]!,
                id,
                name,
                vendorId,
                productId,
                data: descriptor,
            });
            await Consumable.WritableStream.write(this.#writer, message);

            return device;
        } catch (e) {
            cleanup();
            throw e;
        }
    }
```

Three things changed relative to yesterday's version, and all three of them are CodeRabbit fixes landing in `4ff97bc7`.

**The device is registered before the write.** Yesterday's version registered the ID in `#devices` *after* `await Consumable.WritableStream.write(...)`. CodeRabbit's thread on `libraries/scrcpy/src/2_4/impl/uhid-manager.ts` line 54 ("Register the output device before writing the create message") and the parallel threads on `2_7` line 60 and `3_1` line 64 ("Advance the device-ID allocator") pointed out the same class of bug: with `#devices` empty, `id = this.#devices.size` is `0` for *every* call, so the second `createDevice` would select ID 0 again and send a duplicate create message for a device the server already has. The fix is that `this.#devices.set(id, device)` now happens before the write, and the `cleanup()` on failure rolls it back — the transaction is now genuinely transactional.

**The `cleanup` callback is now passed into the device.** CodeRabbit's thread on `libraries/scrcpy/src/3_1/impl/uhid-manager.ts` line 75 ("Pass `cleanup` to the device constructor") pointed out that after `device.destroy()` succeeds, the manager's `#devices` map and `#sparseIds` set were never updated — the device destroyed itself on the server but the client still thought it was live, so the next `createDevice` would allocate a colliding ID. The new `UHidDevice` constructor takes an `onDestroy?: () => void` eighth argument and the manager passes `cleanup` into it.

**Destruction is guarded against a stale handle.** CodeRabbit's thread on `2_7` line 133 ("Prevent repeated destruction through a stale handle") and `3_1` line 156 ("Guard destruction before sending another destroy message") identified the aliasing bug: create A → destroy A → create B reuses ID 0 → call `A.destroy()` again → the client sends a destroy message for ID 0, which the server applies to B. The `UHidDevice` now carries a `#destroyed` flag and `sendReport` refuses:

```typescript
async sendReport(report: Uint8Array): Promise<undefined> {
    if (this.#destroyed) {
        throw new Error("Device is destroyed");
    }
    // ...
}
```

and `destroy()` is idempotent:

```typescript
async destroy(): Promise<undefined> {
    if (this.#destroyPromise) {
        return this.#destroyPromise;
    }
    this.#destroyPromise = this.#destroy().catch((e) => {
        this.#destroyPromise = undefined;
        throw e;
    });
    return this.#destroyPromise;
}
```

There is one more CodeRabbit thread worth noting, on `libraries/scrcpy/src/3_1/impl/uhid-manager.ts` line 54: "Reject names that exceed the wire-length limit." A 256-byte `name` gets passed straight to `string(u8)` and the buffer silently overflows. That one is still an open thread as of the head commit — CodeRabbit's status line on the PR reads "**Automatic approval withheld** — 2 CodeRabbit review threads are still open and must be resolved first."

## Why the abstraction needed a whole commit

The reason `4ff97bc7` exists as a separate commit rather than being folded into the original feature commit is visible in the file list: it touches **sixteen** files, and of those, twelve are the per-version `options.ts` files:

```
modified +19/-8  libraries/scrcpy/src/2_4/options.ts
modified +19/-8  libraries/scrcpy/src/2_6/options.ts
modified +19/-8  libraries/scrcpy/src/2_7/options.ts
modified +19/-8  libraries/scrcpy/src/3_0/options.ts
modified +19/-8  libraries/scrcpy/src/3_1/options.ts
modified +19/-8  libraries/scrcpy/src/3_2/options.ts
modified +19/-10 libraries/scrcpy/src/3_3_1/options.ts
modified +19/-8  libraries/scrcpy/src/4_0/index.ts
modified +19/-8  libraries/scrcpy/src/4_1/index.ts
```

The same nineteen-line addition, repeated nine times, with one file differing by two lines. That is the signature of a code-generation step. The library has a `generate-type-tests.js` in each version directory — `libraries/scrcpy/src/2_2/generate-type-tests.js` and `libraries/scrcpy/src/2_6/generate-type-tests.js` both appear in the diff — and the type-test generator (`libraries/scrcpy/src/2_2/type-tests.spec.ts`, +290/−87) was regenerated to cover the new factory shape.

CodeRabbit flagged the generator too: "Remove `| undefined` from the generated `control: boolean` assertion" on `libraries/scrcpy/src/2_6/generate-type-tests.js` line 21. The generated assertion expected `ScrcpyUHidOutputStream | undefined` from a `control: boolean` options type, which no longer matches after the factory became a getter.

This is the shape of the whole change: a per-version implementation, a version-agnostic interface, a generator-driven type-test suite, and twelve near-identical mechanical edits to the options classes. The mechanical edits are the cost of the library's version-matrix design, and the abstraction is what keeps the *user-facing* API from multiplying by fourteen.

## The scrcpy version matrix, as it now stands

The PR now touches every scrcpy protocol generation the library supports. The diff's file list is the version matrix in full:

| Generation | Options file | UHID manager | Parser |
| --- | --- | --- | --- |
| 1.15 | `src/1_15/options.ts` | — | `src/1_15/impl/device-message-parser.ts` (new) |
| 1.21 | `src/1_21/options.ts` | — | `src/1_21/impl/device-message-parser.ts` (new) |
| 2.4 | `src/2_4/options.ts` | `src/2_4/impl/uhid-manager.ts` (new, 110 lines) | `src/2_4/impl/device-message-parser.ts` (new) |
| 2.7 | `src/2_7/options.ts` | `src/2_7/impl/uhid-manager.ts` (new, 201 lines) | shared with 2.4 |
| 3.1 | `src/3_1/options.ts` | `src/3_1/impl/uhid-manager.ts` (new, 223 lines) | shared |
| 3.2 / 3.3.1 / 4.0 / 4.1 | `src/{3_2,3_3_1,4_0,4_1}/` | shared with 3.1 | shared |

The manager sizes grow monotonically with version — 110 lines at 2.4, 201 at 2.7, 223 at 3.1 — because each generation's `UHID_CREATE` message carries a different set of fields and each needs its own serializer.

`latest.ts` now points at 4.1:

```typescript
export { ScrcpyOptions4_1 as ScrcpyOptionsLatest } from "./4_1/index.js";
```

and re-exports `UHidCreateControlMessage`, `UHidOutputDeviceMessage` and `UHidOutputStream` from `4_1/impl`. Notably `UHidInputControlMessage` and `UHidDestroyControlMessage` are *not* in the `latest.ts` re-export list — they are version-independent and live in `control/uhid.ts`, imported from there directly. That is the correct factoring: the create message is version-specific (its field set changes), the input and destroy messages are not.

## Chrome 158 goes stable, and it is the milestone that carried WebHID to Android

Chrome **158** was promoted to the stable channel for Windows, Mac and Linux on **Tuesday, 2026-11-17** — `158.0.8127.36` on Linux and `158.0.8127.36`/`.37` on Windows and Mac. The same day, Chrome 158 for Android shipped as `158.0.8127.42`. The version bump propagated through the distro packaging ecosystem within hours: [NixOS/nixpkgs#589630](https://github.com/NixOS/nixpkgs/pull/589630) and [NixOS/nixpkgs#589660](https://github.com/NixOS/nixpkgs/pull/589660) both merged the `157.0.8103.78 → 158.0.8127.36` bump on November 17.

Chrome **159** is on Beta and is scheduled for stable on **2026-12-08**; Chrome **160** is in Dev. The Chrome 158 milestone is a "Preview" on ChromeStatus with the scheduled stable release date listed as November 17, 2026, and it is the milestone that carries the device-access features:

**WebHID on Android** — [ChromeStatus 5172464636133376](https://chromestatus.com/feature/5172464636133376). The WebHID API, which shipped on desktop in Chrome 89, now comes to Chrome on Android, relying on new OS support in Android 17 / API level 37 and later, with **no changes to the web-exposed API surface**. WebView is explicitly not supported, since it has neither a device chooser nor the permissions UX. The feature ships with a full set of enterprise policies — `DefaultWebHidGuardSetting`, `WebHidAllowAllDevicesForUrls`, `WebHidAllowDevicesForUrls`, `WebHidAllowDevicesWithHidUsagesForUrls`, `WebHidAskForUrls`, `WebHidBlockedForUrls`.

**Web Install API** and the **HTML `<install>` element** — [5183481574850560](https://chromestatus.com/feature/5183481574850560) and [5152834368700416](https://chromestatus.com/feature/5152834368700416). `navigator.install()` takes a manifest URL and optional manifest ID, and the declarative `<install>` element ships in parallel. Both are gated by the `WebAppInstallByUserEnabled` enterprise policy and the `web-app-installation` permissions policy.

**Three WebTransport additions** — anticipated concurrent incoming streams ([5089961022980096](https://chromestatus.com/feature/5089961022980096)), `WebTransport.draining` ([6427766428925952](https://chromestatus.com/feature/6427766428925952)), and the reliability attributes ([5094058497277952](https://chromestatus.com/feature/5094058497277952)). The draining promise resolves when the server says it is retiring the session gracefully, letting an application establish a replacement while the old streams stay usable. The reliability attribute starts as `"pending"` and becomes `"supports-unreliable"` once an HTTP/3 session is established; `WebTransport.supportsReliableOnly` is `false` because Chromium has no HTTP/2 fallback.

**Source-Specific Multicast for Direct Sockets** ([6208452397498368](https://chromestatus.com/feature/6208452397498368)) — the feature this blog has tracked since October, now shipped in a stable release rather than sitting in a milestone preview.

The one item in the 158 notes that lands directly on webadb's own transport is the WebHID-on-Android entry, and it is worth being precise about what it does *not* do. It does not change WebUSB's device-access rules. The WebUSB blocklist story — the one that runs through the last several posts — is unchanged by this milestone. What Chrome 158 adds is a *second* hardware-access API (HID) reaching a *second* platform (Android), which is directly adjacent to the UHID work above: scrcpy's UHID is how a browser-side ADB client emulates a USB HID device, and WebHID-on-Android is how a browser-side client reaches a *real* HID device on a phone. Same API family, different direction.

## What this means for webadb.online

The concrete, near-term impact of `4ff97bc7` is that the UHID manager stops being a per-version API and becomes a stable one. When ya-webadb eventually cuts the next beta, the shape an application sees will be:

```typescript
const manager = client.uHidManager;
if (manager) {
    const device = await manager.createDevice({
        name: "webadb virtual gamepad",
        vendorId: 0x18d1,
        productId: 0x0001,
        descriptor: reportDescriptorBytes,
    });

    device.output.getReader();     // output reports back from the device
    await device.sendReport(bytes); // input reports to the device
    await device.destroy?.();
}
```

No version branching, no `any`, no feature detection on the scrcpy version number. That is a meaningful change for the scrcpy-backed panels — the screencast panel's control-message path is the obvious consumer — because the version matrix stops being the application's problem.

The Chrome half of this week is more about the platform than the library. Chrome 158 shipping WebHID on Android means the browser-side hardware surface is widening in a direction that rhymes with UHID, and Chrome 158 shipping the three WebTransport additions — especially `draining` — is a step toward the WebTransport-based ADB transport that webadb has been waiting on. `draining` in particular is the API you want for a long-lived ADB-over-WebTransport connection: the server can retire a session gracefully and the client can reconnect without dropping the user's shell.

The version-abstraction work in PR #880 is the more immediately useful of the two for anyone building on ya-webadb today, and it lands before the Chrome features do not — the library side is on a pull request with two open review threads, while the Chrome side is already in stable.

One correction to yesterday's post, since it matters for anyone reading the two in sequence: Chrome 159 does *not* go stable today. Chrome 158 went stable on November 17, Chrome 159 is on Beta with a December 8 stable date, and Chrome 160 is in Dev. The UHID manager shape described yesterday is also superseded by today's — the per-version managers are now implementation details behind `ScrcpyUHidManager`.

## Sources

- [`yume-chan/ya-webadb#880`](https://github.com/yume-chan/ya-webadb/pull/880) — head `0049fc91f141737d9ea749dd69c20e3421a7fa41`, 10 commits, +2274/−1298 across 63 files
- [`4ff97bc7a193`](https://github.com/yume-chan/ya-webadb/commit/4ff97bc7a193484396e2d9434482ac6eafa46e51) — "feat(scrcpy): add UHID manager and device interfaces" (2026-11-17T02:53:50Z)
- [`libraries/scrcpy/src/base/uhid.ts`](https://github.com/yume-chan/ya-webadb/blob/0049fc91f141737d9ea749dd69c20e3421a7fa41/libraries/scrcpy/src/base/uhid.ts) — the version-agnostic interface
- [`libraries/scrcpy/src/base/device-message.ts`](https://github.com/yume-chan/ya-webadb/blob/0049fc91f141737d9ea749dd69c20e3421a7fa41/libraries/scrcpy/src/base/device-message.ts) — the capability-based parser contract
- [`libraries/scrcpy/src/control/uhid.ts`](https://github.com/yume-chan/ya-webadb/blob/0049fc91f141737d9ea749dd69c20e3421a7fa41/libraries/scrcpy/src/control/uhid.ts) — the input and destroy control messages
- [Chrome 158 release notes](https://chromestatus.com/release-notes/158) and [Chrome 159 release notes](https://chromestatus.com/release-notes/159)
- [Chrome Releases, November 2026](https://chromereleases.googleblog.com/2026/11/)
