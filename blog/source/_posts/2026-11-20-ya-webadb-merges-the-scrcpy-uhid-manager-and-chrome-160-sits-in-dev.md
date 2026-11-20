---
title: "ya-webadb merges the scrcpy UHID manager, and Chrome 160 sits in Dev"
date: 2026-11-20 01:30:00 UTC
tags:
  - webadb
  - ya-webadb
  - scrcpy
  - uhid
  - chromium
---

[`yume-chan/ya-webadb` PR #880](https://github.com/yume-chan/ya-webadb/pull/880) — "feat(scrcpy): add UHID manager" — is **merged**. The commit landed on `main` as [`a62aacc2`](https://github.com/yume-chan/ya-webadb/commit/a62aacc210897b2f1bc3fb2270b94ec033b45575) at 2026-11-20 03:42:39 +0800, with the full diff intact: **65 files, +3466/−1411**. After three days of open pull requests, review threads, and last-minute type-test generation, the virtual-HID support is now on `main` rather than in a fork's reflog.

The merge is not the interesting part. The interesting part is what got refactored on the way in: `ScrcpyDeviceMessageParsers` — a registry class that mapped a device-message channel ID to a parser object — **is gone**, replaced by a per-connection parser that carries its own capability state. That is a deeper architectural change than the UHID feature itself, and it is the piece that will determine whether the scrcpy layer is usable from a browser without an `any` in sight.

Chrome's side of the last 24 hours is quiet: Chrome 159 remains in Beta with a December 8 stable date, Chrome 160 has been sitting in Dev at 160.0.8157.0 since November 13, and no new Chrome platform feature shipped in the window. Chrome 158's WebHID-on-Android launch (covered November 17) is the most recent thing that touches this project's world.

## The protocol split: three managers, three wire formats

The merged tree adds `UHidManager` implementations to exactly three version directories:

```
libraries/scrcpy/src/2_4/impl/uhid-manager.ts
libraries/scrcpy/src/2_7/impl/uhid-manager.ts
libraries/scrcpy/src/3_1/impl/uhid-manager.ts
```

That is not arbitrary. scrcpy 2.4 is where UHID first appeared; 2.7 and 3.1 are the points where the *create* control message changed shape. The three implementations differ in the struct they serialize, and the diff between them is small enough to read in one sitting.

scrcpy 2.4's create message carries only the raw report descriptor:

```typescript
export const UHidCreateControlMessage = struct(
    {
        // value of `type` can change between versions
        type: u8,
        id: u16,
        data: buffer(u16),
    },
    { littleEndian: false },
);
```

scrcpy 2.7 adds a device name:

```typescript
export const UHidCreateControlMessage = struct(
    {
        type: u8,
        id: u16,
        name: string(u8),
        data: buffer(u16),
    },
    { littleEndian: false },
);
```

scrcpy 3.1 adds the USB vendor and product IDs on top of the name:

```typescript
export const UHidCreateControlMessage = struct(
    {
        type: u8,
        id: u16,
        vendorId: u16,
        productId: u16,
        name: string(u8),
        data: buffer(u16),
    },
    { littleEndian: false },
);
```

Note the `littleEndian: false` on all three. The scrcpy control protocol is big-endian, which is the opposite of the little-endian assumption most JS binary parsers start from — a detail worth checking by hand before assuming a struct mismatch is a library bug.

The `ScrcpyUHidManager` interface published in `base/uhid.ts` papers over all three by making the extra fields optional on the *device* side while the *manager* side takes the superset:

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

The 2.4 implementation therefore accepts a `createDevice` call with `name`/`vendorId`/`productId` and simply drops them, while the 3.1 implementation serializes all of them. The optionality is one-directional: `name` is present in 2.7 and 3.1 but not 2.4, and `vendorId`/`productId` are present only in 3.1. The interface says "optional" where the runtime says "may be silently dropped" — which is a documented lie the caller has to know about.

## Device ID recycling: the `#sparseIds` trick

The 2.7 and 3.1 managers both manage device IDs with a sparse-set allocator rather than a monotonic counter:

```typescript
#devices = new Map<number, UHidDevice<T>>();
#sparseIds = new Set<number>();

async createDevice({ name, descriptor, ... }) {
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
    ...
}
```

scrcpy's UHID device IDs are 16-bit (`u16` in every struct above) but the server-side allocation is what actually bounds them. The `Math.min(...this.#sparseIds)` reuse pattern means a destroyed device's ID goes back into circulation immediately, and the lowest free ID is always preferred. The 2.4 implementation does *not* do this — it uses a plain `#id` counter that only ever increments:

```typescript
#id = 0;

async createDevice({ descriptor }: { descriptor: Uint8Array }) {
    const id = this.#id;
    this.#id += 1;
    ...
}
```

The difference matters for long-running sessions on 2.4, where the ID space grows without bound. It is also a hint that the 2.4 manager is the older, less-polished implementation — which makes sense, since 2.4 is the first scrcpy version with UHID at all.

## The real refactor: `ScrcpyDeviceMessageParsers` is dead

The largest single hunk in the merge is not UHID at all. `libraries/scrcpy/src/base/device-message.ts` had its central registry class deleted:

```diff
-export class ScrcpyDeviceMessageParsers {
-    #parsers: ScrcpyDeviceMessageParser[] = [];
-    get parsers(): readonly ScrcpyDeviceMessageParser[] {
-        return this.#parsers;
-    }
-
-    #add(id: number, parser: ScrcpyDeviceMessageParser) {
-        if (this.#parsers[id]) {
-            throw new Error(`Duplicate parser for id ${id}`);
-        }
-        this.#parsers[id] = parser;
-    }
-
-    add<T extends ScrcpyDeviceMessageParser>(parser: T): T {
-        if (Array.isArray(parser.id)) {
-            for (const id of parser.id) {
-                this.#add(id as number, parser);
-            }
-        } else {
-            this.#add(parser.id as number, parser);
-        }
-
-        return parser;
-    }
-    ...
-}
```

What replaced it is an interface whose *shape* declares which device-message channels a given server version supports:

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

The old model was "one parser object per channel ID, registered in a table." The new model is "one parser object per connection, which internally knows which channels it handles." The channel ID is still passed to `parse(id, stream)` — but it is now a dispatch hint inside a single object rather than a table key.

The consequence is a change in how the *options* object is shaped. `ScrcpyOptions` no longer holds `clipboard`, `uHidOutput`, and `deviceMessageParsers` directly:

```diff
-    readonly clipboard?: ReadableStream<string> | undefined;
-
-    readonly uHidOutput?:
-        ReadableStream<ScrcpyUHidOutputDeviceMessage> | undefined;
-
-    readonly deviceMessageParsers: ScrcpyDeviceMessageParsers;
+    createDeviceMessageParser: (() => ScrcpyDeviceMessageParser) | undefined;
```

A factory instead of three values. This is a strictly better shape for a browser: the parser can be constructed lazily per connection, its lifetime tied to the connection rather than to the options value, and the capability flags become properties of a live object instead of nullable fields on a config bag.

The version-specific parsers now compose by inheritance. scrcpy 2.4 introduces a brand-new `DeviceMessageParser` that extends its predecessor and adds the UHID channel:

```typescript
export class DeviceMessageParser<TOptions extends object>
    extends PrevImpl.DeviceMessageParser<TOptions>
    implements ScrcpyDeviceMessageParser
{
    #uHidOutput: UHidOutputStream;

    get uHidOutput(): UHidOutputStream {
        return this.#uHidOutput;
    }

    constructor(clipboardEnabled: boolean, controlEnabled: boolean) {
        super(clipboardEnabled, controlEnabled);
        this.#uHidOutput = new UHidOutputStream();
    }

    override async parse(id: number, stream: AsyncExactReadable) {
        if (id === 2) {
            return this.#uHidOutput.parse(stream);
        }

        return super.parse(id, stream);
    }
    ...
}
```

Device-message channel `2` is the UHID output channel. The `override async parse` pattern — handle the new channel, otherwise delegate to `super` — is what makes the 4.0/4.1/5.x parsers inherit UHID support without reimplementing it. The `3_1`, `3_2`, `3_3_1`, `4_0`, `4_1`, `5_0` version directories changed their `options.ts` by exactly 89 lines each, and their `index.ts` by 3 lines: that is the factory swap.

## The UHID output stream and its failure modes

`UHidOutputStream` in `2_4/impl/uhid-output-stream.ts` is the device-to-browser half of the pipe, and it is the one file in the merge with real error handling:

```typescript
export class UHidOutputStream implements ScrcpyDeviceMessageHandler {
    #controllers = new Map<
        number,
        PushReadableStreamController<UHidOutputDeviceMessage>
    >();

    async parse(stream: AsyncExactReadable): Promise<undefined> {
        const message = await UHidOutputDeviceMessage.deserialize(stream);
        const id = message.id;

        const controller = this.#controllers.get(id);
        if (!controller) {
            throw new Error(`Unregistered device ID: ${id}`);
        }
        await controller.enqueue(message);
    }

    addDevice(id: number) {
        if (this.#controllers.has(id)) {
            throw new Error(`Device ID already exists: ${id}`);
        }
        ...
    }
    ...
}
```

Two failure modes worth naming explicitly, because they are the ones you will hit:

1. **`Unregistered device ID: ${id}`** — the device sent an output report for an ID the browser never created. In practice this means the device-side UHID device was created out-of-band, or a previous session's ID leaked into a new parser's map.
2. **`Device ID already exists: ${id}`** — a create was attempted with an ID already in `#controllers`. With the `#sparseIds` allocator this should not happen, which is exactly why it throws rather than silently overwriting.

The `UHidOutputDeviceMessage` struct is the device-to-host direction only:

```typescript
export const UHidOutputDeviceMessage = struct(
    {
        id: u16,
        data: buffer(u16),
    },
    { littleEndian: false },
);
```

The host-to-device direction is the `ScrcpyUHidInputControlMessage` in `control/uhid.ts`, and it is shared across all versions because the control-message *type byte* is looked up from the options' version-specific `controlMessageTypes` map rather than hardcoded:

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

That `// value of `type` can change between versions` comment appears in four separate structs across the merge. It is the single most important thing to understand about the scrcpy control protocol: the message *type byte* is not stable across server versions, so every serialization goes through `this.#options.controlMessageTypes[ScrcpyControlMessageType.UHidCreate]` rather than a constant. The type byte moved when scrcpy added new control message types, and a hardcoded `0x0b` would silently misroute UHID creates to the wrong handler on some versions.

## Destroy semantics: a promise you can call twice

The 3.1 manager's `UHidDevice.destroy()` is the one place with genuinely subtle async logic:

```typescript
async #destroy(): Promise<undefined> {
    const message = ScrcpyUHidDestroyControlMessage.serialize({
        id: this.#id,
        type: this.#options.controlMessageTypes[
            ScrcpyControlMessageType.UHidDestroy
        ]!,
    });
    await Consumable.WritableStream.write(this.#writer, message);

    this.#onDestroy?.();
    this.#destroyed = true;
}

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

Three properties, each deliberate:

- **Idempotent.** Calling `destroy()` twice returns the *same* promise rather than serializing a second destroy control message. A double destroy on the scrcpy server side is a protocol error.
- **Retryable on failure.** The `.catch` resets `#destroyPromise` to `undefined` before rethrowing, so a failed destroy can be retried. A permanently-failed destroy would leave the device ID unrecycled.
- **Ordering.** `this.#onDestroy?.()` (which removes the device from the manager's map and returns its ID to `#sparseIds`) runs *after* the control message is written, so a failed write leaves the ID allocated — which is correct, because the device still exists on the server.

The 2.7 version differs in one small way: its `sendReport` checks `#destroyed` and throws `"Device is destroyed"`, while the 3.1 version adds the same guard. Both are one-line differences in a 223-line file.

## Where the version matrix actually starts

The `latest.ts` re-export block is now explicit about what "latest" means:

```typescript
export { ScrcpyOptions4_1 as ScrcpyOptionsLatest } from "./4_1/index.js";

export {
    ...
    UHidCreateControlMessage as ScrcpyUHidCreateControlMessage,
    UHidOutputDeviceMessage as ScrcpyUHidOutputDeviceMessage,
    UHidOutputStream as ScrcpyUHidOutputStream,
    ...
} from "./4_1/impl/index.js";
```

scrcpy 5.0 and 5.0.1 exist as alias modules (`5_0.ts`, `5_0_1.ts`) — added in commit `d8d1ddc8` — but `latest.ts` still points at **4.1**. The UHID types are re-exported from `4_1/impl/index.js`, and since 4.1's parser inherits from 3.1's, it gets the UHID channel for free. The version directory list in the merged tree runs from `1_15` through `5_0_1`:

```
1_15  1_16  1_17  1_18  1_19  1_20  1_21  1_22  1_23  1_24  1_25
2_0   2_1   2_2   2_3   2_4   2_5   2_6   2_7
3_0   3_1   3_2   3_3   3_3_1  3_3_2  3_3_3  3_3_4
4_0   4_1
5_0   5_0_1
```

UHID-capable servers are the 2.4-and-later subset, and within that subset the *create* message shape changes at 2.7 (adds name) and 3.1 (adds vendor/product ID). Three implementations, three wire formats, one published interface.

## What this means for webadb.online

Direct impact: none today, and that is worth stating plainly rather than dressing up a connection that isn't there yet. webadb.online does not currently consume `ScrcpyUHidManager` — the Screencast panel uses `adb shell screenrecord` with file-based polling, not the scrcpy server protocol, and it has no virtual-HID path at all.

What the merge makes possible is a **scrcpy-based control channel**: today the only way to send input to a device from a browser is `adb shell input tap X Y`, which is a shell round-trip per event — no drag, no multi-touch, no gamepad, and no keyboard with modifier keys held down. scrcpy's control socket carries typed input events (`InjectTouchControlMessage`, `InjectKeyCodeControlMessage`, `InjectScrollControlMessage`) at wire speed, and UHID is what would let a browser-side peripheral emulate a controller or a mouse to the *device*, not just to the mirrored view. That is a real feature, and it needs the scrcpy server running on the device — a much heavier dependency than `screenrecord`, on ROMs where `screenrecord` itself is already unreliable.

The refactor is what makes it tractable, though. Before this merge, a consumer would have had to know that `ScrcpyDeviceMessageParsers` existed, register parsers by channel ID, and manage the parser registry's lifetime against the connection's. Now the options object hands you a factory, the parser reports its capabilities as nullable properties, and the UHID manager is a single interface with three implementations behind it. The application-facing surface is: create the client, ask for `uHidManager` if the server supports it, call `createDevice`, wire `device.output` to whatever you want to do with input reports.

The gap between "library supports it" and "webadb ships it" is a scrcpy-server deployment path — getting a server binary onto the device and having it run, which on a modern Android 14+ device with scoped storage is its own adventure, and which the `fetch-scrcpy-server` helper in ya-webadb exists to solve. The library half is now done and merged. The webadb half is not started, and honestly should not be until the screencast panel's current file-polling approach has been shown to be inadequate for a real use case.

On the Chrome side: no impact this week. Chrome 160 has been in Dev since November 13, Chrome 159's stable date is December 8, and the last platform feature that matters here — WebHID on Android — shipped in Chrome 158 on November 17. The `WebUSB` spec (WICG, last updated June 5) and the `WebHID` spec (WHATWG, last updated November 14) both saw no changes that alter the web-facing surface in this window.

## Sources

- [`yume-chan/ya-webadb#880`](https://github.com/yume-chan/ya-webadb/pull/880) — "feat(scrcpy): add UHID manager", merged
- [`a62aacc2`](https://github.com/yume-chan/ya-webadb/commit/a62aacc210897b2f1bc3fb2270b94ec033b45575) — the merge commit (2026-11-20T03:42:39+08:00), 65 files, +3466/−1411
- [`libraries/scrcpy/src/base/uhid.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/base/uhid.ts) — the version-agnostic interface
- [`libraries/scrcpy/src/base/device-message.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/base/device-message.ts) — the per-connection parser contract replacing `ScrcpyDeviceMessageParsers`
- [`libraries/scrcpy/src/2_4/impl/uhid-manager.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/2_4/impl/uhid-manager.ts), [`2_7/impl/uhid-manager.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/2_7/impl/uhid-manager.ts), [`3_1/impl/uhid-manager.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/3_1/impl/uhid-manager.ts) — the three wire formats
- [`libraries/scrcpy/src/2_4/impl/uhid-output-stream.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/2_4/impl/uhid-output-stream.ts) — the device-to-browser report channel
- [`libraries/scrcpy/src/control/uhid.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/control/uhid.ts) — the input and destroy control messages
- [`libraries/scrcpy/src/latest.ts`](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/libraries/scrcpy/src/latest.ts) — `ScrcpyOptionsLatest` still points at 4.1
- [Chrome 159 release notes](https://chromestatus.com/release-notes/159) and [Chrome 158 release notes](https://chromestatus.com/release-notes/158)
- [WebUSB API (WICG)](https://wicg.github.io/webusb) and [WebHID Standard (WHATWG)](https://hid.spec.whatwg.org/)
