---
title: "ya-webadb learns to be a USB device, and Chrome 159 goes stable"
date: 2026-11-17 01:20:00 UTC
tags:
  - webadb
  - ya-webadb
  - scrcpy
  - uhid
  - chromium
---

`yume-chan/ya-webadb` has a branch with real work on it for the first time in five weeks: pull request #880, "feat(scrcpy): add UHID manager", landed on 2026-11-16 at 08:35 UTC and by 14:39 UTC had cleared its last CodeRabbit review round. It is a 54-file, +1794/−985 diff that adds a first-class virtual-HID device manager to the scrcpy client library, across four scrcpy protocol versions simultaneously. In the same window Chrome 159 crossed into its stable cutover — it goes stable tomorrow, 2026-11-18, with Chrome 160 moving to dev — and a checkable asymmetry showed up between two sibling WHATWG specs that both govern browser access to USB hardware.

## The UHID manager: ya-webadb can now create virtual HID devices

The pull request is [`yume-chan/ya-webadb#880`](https://github.com/yume-chan/ya-webadb/pull/880), branched off `feat/scrcpy-control` by `b8cb5b58`, with the head commit `b8cb5b58493b2964d521ec38242c31578c66f511` (2026-11-16T14:36:12Z). It is worth noting that it is the *only* open pull request in the repository — not merely the only one in the last week, but the only one in the entire tracker right now, on a branch that has never had a pull request against it before. Seven commits, of which the first carries the feature and the remaining six are review-response churn:

```
107551405 2026-11-16T07:03:27Z | feat(scrcpy): add UHID manager
38ca0cac6 2026-11-16T08:11:08Z | refactor: simplify
79bb6a1c4 2026-11-16T09:41:49Z | chore: fix review comments
5b2fae53b 2026-11-16T09:48:10Z | chore: fix review comments
3da701e92 2026-11-16T10:04:05Z | chore: fix review comments
c3dec6525 2026-11-16T14:20:26Z | refactor: rewrite createDeviceMessageParser type
b8cb5b584 2026-11-16T14:36:12Z | chore: fix review comments
```

What it adds is a `UHidManager` class and a `UHidDevice` class, exported from the version-specific `impl` directories for scrcpy **2.4**, **2.7**, **3.1** and **3.2** — four protocol generations that each wire UHID slightly differently. The manager owns a device table and a sparse-ID recycler:

```typescript
export class UHidManager<T extends Pick<ScrcpyOptions3_1.Init, "control">> {
    #writer: WritableStreamDefaultWriter<Consumable<Uint8Array>>;
    #options: ScrcpyOptions<T>;
    #deviceMessageParser: DeviceMessageParser<T>;

    #devices = new Map<number, UHidDevice<T>>();
    #sparseIds = new Set<number>();

    constructor(writer, options, deviceMessageParser) {
        if (!options.value.control) {
            throw new Error("control is disabled");
        }
        // ...
    }

    async createDevice(
        name: string,
        vendorId: number,
        productId: number,
        descriptor: Uint8Array,
    ) {
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
        // ...
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
}
```

Three details in that snippet are worth pulling out, because they are the whole design.

**The ID allocator is sparse-aware.** `#devices.size` alone would be wrong — destroying device 1 of 3 and then creating a new one would collide, because `size` is 2 while ID 2 is taken. The `#sparseIds` set holds released IDs and `Math.min(...this.#sparseIds)` reuses the *lowest* freed slot rather than allocating a monotonically increasing one. The scrcpy server tracks UHID device IDs as a 16-bit field, so the space is large, but the server's own view of "which ID is live" is what must agree with the client's. Reusing the lowest free ID keeps the two views convergent, which matters because the ID is on the wire in every subsequent input report.

**`createDevice` is transactional.** The `UHID_CREATE` control message is written *after* the device is registered locally, and a write failure triggers `cleanup()` before rethrowing — which unregisters the ID from the output stream, removes it from the device map, and returns it to the sparse pool. Without that, a failed write would leave a device that the client believes exists and the server does not, and every subsequent report for that ID would be silently dropped by the server.

**The `control is disabled` guard is at construction time.** UHID is a control-channel feature; there is no way to create a virtual HID device without a control socket, so the manager refuses to exist rather than failing later at first use.

## The `UHidDevice` side: reports in, output back

The device handle is the mirror image. `sendReport()` serializes an `ScrcpyUHidInputControlMessage` — `type`, `id`, and a length-prefixed `data` buffer, all big-endian — and writes it to the control channel. `destroy()` writes a `ScrcpyUHidDestroyControlMessage` (`type` + `id` only) and then flips `#destroyed`.

The `destroy()` implementation is the sort of thing that looks like over-engineering until you notice what it is guarding:

```typescript
async destroy() {
    if (this.#destroyPromise) {
        return this.#destroyPromise;
    }
    this.#destroyPromise = this.#destroy().catch((e) => {
        this.#destroyPromise = undefined;   // allow a retry after failure
        throw e;
    });
    return this.#destroyPromise;
}
```

A destroy that fails mid-write leaves the server believing the device still exists. Clearing the cached promise on rejection makes `destroy()` idempotent-but-retryable: a second call after a failure gets a fresh attempt, while concurrent calls share one in-flight promise rather than sending two `UHID_DESTROY` messages for the same ID.

Crucially, the device also carries an `output` stream — the *return* path. A virtual HID device is bidirectional: the browser sends input reports to the device, and the device sends output reports back to the host. That is the whole point of the feature for game controllers and similar devices, where the console reads the stick position and the browser needs to render it. Yesterday's post covered Tango 3.2.0 shipping UHID in the browser; this is the open-source library side of the same capability.

## Per-device routing: the `UHidOutputStream`

The routing layer is `libraries/scrcpy/src/2_4/impl/uhid-output-stream.ts`, and it is the piece that makes multiple simultaneous virtual devices possible. It keeps a map of device ID to `PushReadableStreamController`, and demultiplexes incoming device messages by ID:

```typescript
export const UHidOutputDeviceMessage = struct(
    {
        id: u16,
        data: buffer(u16),
    },
    { littleEndian: false },
);

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

    addDevice(id: number) { /* ... */ }
    deleteDevice(id: number) { /* tryClose(controller) */ }
    close() { /* close every controller */ }
    error(e?: unknown) { /* error every controller */ }
}
```

Two failure modes are handled explicitly, and both have dedicated test cases in the new `uhid-output-stream.spec.ts`:

```typescript
it("should reject duplicate devices and messages for unknown devices", async () => {
    const stream = new UHidOutputStream();
    stream.addDevice(1);

    assert.throws(() => stream.addDevice(1), /Device ID already exists: 1/);
    await assert.rejects(
        stream.parse(createMessage(2, new Uint8Array())),
        /Unregistered device ID: 2/,
    );
    assert.throws(
        () => stream.deleteDevice(2),
        /Unregistered device ID: 2/,
    );
});
```

An output message for an unregistered ID is a hard error, not a warning. That is the right call for a protocol where the server is the authority on which devices exist — if the server sends output for a device the client does not have, the client and server have diverged, and continuing would mean silently dropping input the user made. The stream also closes cleanly when a device is deleted, so a consumer blocked on `device.output.read()` gets `{ done: true }` rather than hanging forever.

The tests are byte-exact and use the `@yume-chan/struct` reader directly, building frames by hand:

```typescript
function createMessage(id: number, data: Uint8Array) {
    const message = new Uint8Array(4 + data.byteLength);
    const view = new DataView(message.buffer);
    view.setUint16(0, id, false);
    view.setUint16(2, data.byteLength, false);
    message.set(data, 4);
    return new Uint8ArrayExactReadable(message);
}
```

Big-endian `u16` ID, big-endian `u16` length, then the payload. The fact that a hand-built fixture can be fed into a `Uint8ArrayExactReadable` and parsed is the whole point of the `struct` library's design — the parser is a protocol description, not a pile of `DataView` reads.

## The version divergence, and why there are four managers

scrcpy's UHID support was introduced in server version 2.4 and the create message has since changed shape. The 2.4-era manager takes only a descriptor:

```typescript
async createDevice(descriptor: Uint8Array) {
    const id = this.#id;
    this.#id += 1;
    // ...
}
```

while the 3.1-era manager takes a name, vendor ID, product ID and descriptor:

```typescript
async createDevice(
    name: string,
    vendorId: number,
    productId: number,
    descriptor: Uint8Array,
) { /* ... */ }
```

The 3.1 `UHidDevice` correspondingly exposes `name`, `vendorId` and `productId` getters; the 2.4 one does not, because the server protocol at that version did not carry them. Note also that 2.4 uses a simple monotonic counter (`#id += 1`) rather than the sparse-ID recycling of 3.1 — the later implementation is the better one, and the older one was left alone to preserve wire compatibility with what that server version actually understands.

The diff touches `options.ts` in **nineteen** version directories — 1_15, 1_17, 1_18, 1_21, 1_22, 1_23, 1_24, 1_25, 2_0, 2_1, 2_2, 2_3, 2_4, 2_6, 2_7, 3_0, 3_1, 3_2, 3_3_1 — plus `base/options.ts`, and `index.ts` in 4_0 and 4_1, each with the same small shape of change. That uniformity is the signature of a *structural* refactor rather than a feature patch, and it is the most consequential part of the PR.

## The real headline: `ScrcpyDeviceMessageParsers` becomes `ScrcpyDeviceMessageParser`

Before this PR, `ScrcpyOptions` carried three separate fields:

```typescript
export interface ScrcpyOptions<T extends object> {
    value: T;

    readonly clipboard?: ReadableStream<string> | undefined;
    readonly uHidOutput?: ReadableStream<ScrcpyUHidOutputDeviceMessage> | undefined;
    readonly deviceMessageParsers: ScrcpyDeviceMessageParsers;
    // ...
}
```

After it, those collapse into one factory:

```typescript
export interface ScrcpyOptions<T extends object> {
    value: T;

    createDeviceMessageParser: (() => ScrcpyDeviceMessageParser) | undefined;

    serialize(): string[];
    // ...
}
```

The old shape was structurally incapable of expressing per-device output routing. `uHidOutput` was a *single* `ReadableStream` hanging off the options — one stream for the whole connection. If you created two virtual HID devices, their output reports would arrive interleaved on one stream with no way to tell which report belongs to which device except by parsing the ID out of the frame yourself. `deviceMessageParsers` was a *collection* of parsers, each of which produced one stream, and the multiplexer fanned incoming messages out to whichever parser claimed the message ID.

The new shape inverts it: one `ScrcpyDeviceMessageParser` per connection, created lazily via `createDeviceMessageParser()`, and the per-device demultiplexing moves *inside* the parser. The new `DeviceMessageParser` classes form a version chain, each extending the previous and overriding `parse()` to claim its own message IDs:

```typescript
// 1_15/impl/device-message-parser.ts — the base
export class DeviceMessageParser<TOptions extends object>
    implements ScrcpyDeviceMessageParser
{
    #clipboard: ClipboardStream | undefined;

    constructor(clipboardEnabled: boolean, controlEnabled: boolean) {
        if (!controlEnabled) {
            throw new Error("control is disabled");
        }
        if (clipboardEnabled) {
            this.#clipboard = new ClipboardStream();
        }
    }

    async parse(id: number, stream: AsyncExactReadable) {
        if (id === 0 && this.#clipboard) {
            return this.#clipboard.parse(stream);
        }
        throw new Error(`Unknown device message id: ${id}`);
    }
}
```

```typescript
// 2_4/impl/device-message-parser.ts — adds UHID output, message id 2
export class DeviceMessageParser<TOptions extends object>
    extends PrevImpl.DeviceMessageParser<TOptions>
    implements ScrcpyDeviceMessageParser
{
    #uHidOutput: UHidOutputStream;

    get uHidOutput(): UHidOutputStream {
        return this.#uHidOutput;
    }

    override async parse(id: number, stream: AsyncExactReadable) {
        if (id === 2) {
            return this.#uHidOutput.parse(stream);
        }
        return super.parse(id, stream);
    }
}
```

and 1_21 slots an `AckClipboardHandler` at message ID 1 between the two. The message-ID map is therefore: **0** = clipboard, **1** = clipboard acknowledgement (1.21+), **2** = UHID output (2.4+). Each version's parser claims exactly the IDs its server version can emit and delegates the rest upward.

The `AdbScrcpyClient` changes follow from that. The client used to read `options.deviceMessageParsers` and `options.clipboard` directly; now it holds its own parser instance and exposes it:

```typescript
export class AdbScrcpyClient<
    TOptions extends AdbScrcpyOptions<Pick<ScrcpyOptions1_15.Init, "control">>,
> {
    #options: TOptions;
    #deviceMessageParser: ScrcpyDeviceMessageParser | undefined;
    get options() { return this.#options; }

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
}
```

Note the generic constraint change from `AdbScrcpyOptions<object>` to `AdbScrcpyOptions<Pick<ScrcpyOptions1_15.Init, "control">>` — the client type is now parameterised by whether the control channel is enabled at all, because `control` is now the thing that determines whether a device-message parser can exist. The type-level gymnastics (`extends (() => infer R) | undefined ? R : undefined`) are how the library recovers the *specific* parser type from the options type, so that a 3.1 client hands you a 3.1 parser with `uHidOutput` on it, and a 1.15 client hands you one without.

The `ScrcpyControlMessageSerializer` takes the parser as a second constructor argument, and `setClipboard` now passes it through:

```typescript
setClipboard(message: Omit<ScrcpySetClipboardControlMessage, "type">) {
    return this.#options.serializeSetClipboardControlMessage(
        {
            ...message,
            type: this.getType(ScrcpyControlMessageType.SetClipboard),
        },
        this.#deviceMessageParser,
    );
}
```

That second parameter is why `ScrcpyOptions.serializeSetClipboardControlMessage` grew a `deviceMessageParser` argument. The clipboard set operation needs to know whether an acknowledgement is expected, and in scrcpy 1.21+ that depends on the connection's capabilities — which now live on the per-connection parser rather than on the shared options object. The options object is now stateless and shareable; the parser is per-connection and stateful. That separation is the actual architectural achievement of this PR.

## Chrome 159 crosses into stable tomorrow

The Chrome release channel picture shifted this week. Chrome **158** has been stable since 2026-11-04; Chrome **159** went to Beta on 2026-11-12 (build `159.0.8154.6` on Windows, Mac and Linux) and goes **stable on 2026-11-18** — tomorrow, as of this writing. Chrome **160** is in Dev, scheduled for stable on 2026-12-09.

The Chrome 159 beta announcement itself is thin — [developer.chrome.com/blog/chrome-159-beta](https://developer.chrome.com/blog/chrome-159-beta?hl=en) is essentially a pointer to the ChromeStatus release notes, with the single headline being "Modern Web Guidance is now stable." Nothing in that milestone touches WebUSB, WebHID or WebTransport. The device-access story of the last two weeks has been entirely outside Chromium: it has been the WHATWG spec repos and the ya-webadb repository.

On the Chromium side, the last 24 hours were genuinely quiet for anything device-related. The only commit touching the peripheral API directories is [`chromium/chromium@900fc5f72`](https://github.com/chromium/chromium/commit/900fc5f72), "Replace DEFINE_STATIC_LOCAL in blink build, bindings, controller, and modules" (2026-11-16T21:36:24Z), which touches `third_party/blink/renderer/modules/bluetooth` — and it is a mechanical macro substitution, not a behaviour change. The WebUSB and WebHID module directories had no commits at all in the window.

## The asymmetry between two sibling specs

Here is a checkable fact that neither spec's own repository advertises, and it matters more for webadb than any Chrome milestone does.

The WebHID standard, as of `whatwg/hid@3c85c594f` (covered in [yesterday's post](https://webadb.online/blog/2026/11/16/the-webhid-blocklist-goes-live-and-ya-webadb-grows-a-dotnet/)), publishes a live device filter list at a URL on the spec's own domain:

```
$ curl -sL https://hid.spec.whatwg.org/blocklist.txt | wc -c
2205
```

The WebUSB standard, which now lives in the same repository family at `whatwg/usb` and publishes at `https://usb.spec.whatwg.org/`, has no equivalent:

```
$ curl -sLI https://usb.spec.whatwg.org/blocklist.txt
HTTP/1.1 404 Not Found
```

Both specs express their device restrictions as a filter list with a machine-readable grammar — the WebUSB spec's `Protected Usage Pages` mechanism matches on vendor ID, product ID and interface number, exactly like the HID list's vendor/product filters, and both files are written in the same JSON-with-comments style. The WebHID spec simply also has a *deployment* mechanism, and the WebUSB spec does not.

What that means in practice is asymmetric but not as alarming as it first looks. WebUSB's protected-usage-page list is compiled into the browser, so it ages with the browser release rather than being fetchable at runtime. The HID list can change without a browser release. Both are enforceable; they are enforceable on different cadences.

For webadb specifically, the difference is that a WebUSB deployment is currently *less* constrained by the spec than a WebHID one — the vendor/product filter that would determine which Android devices a page may open is baked into the browser binary, and the set of Android vendor IDs that matter for ADB is small and stable in practice. The WebHID blocklist, by contrast, bans Generic Desktop / Keyboard and / Mouse outright, and it can be extended without a browser release. So the direction of the risk is clear: for a project that only ever talks to Android devices over WebUSB, the spec-level surface is stable; the HID surface is the one that can close without warning.

## What this means for webadb.online

**The UHID manager is the scrcpy path webadb has deliberately not taken — and it should stay that way.** webadb's Screencast panel runs `adb shell screenrecord` and polls the file over `adb shell`. That is a deliberate choice, made for a concrete reason recorded in the project: `screenrecord --output-format=h264 -` is a Pixel-only extension, vanilla AOSP `screenrecord` v1.4 does not support it, `screenrecord -` as a filename fails on OEM ROMs where `/system` is read-only, and `mkfifo` is SELinux-blocked for the shell UID. Pushing a `scrcpy-server.jar` and running it on the device — which is what UHID requires, since UHID is a control-channel feature of the scrcpy server — reintroduces exactly the failure mode webadb's approach exists to avoid: a server binary that may not run on an OEM ROM.

So: PR #880 is not a feature webadb should adopt. It is a feature webadb should *know about*, because it is the reference implementation of the thing that is supposed to replace `adb shell input tap`. webadb's input injection today goes through `adb shell input tap` and `adb shell input keyevent`, the software path, which is ASCII-limited and slower than a real input report. The day webadb wants real HID injection — full Unicode, game controllers, actual key-down/key-up semantics — this PR is the blueprint for what the client half of that looks like, and the reason it has not happened yet is entirely on the device half.

**The `DeviceMessageParsers` → `DeviceMessageParser` refactor is worth studying even though webadb does not use scrcpy.** webadb's ADB layer does its own device-side work over `adb shell`, not over a scrcpy control socket, so this refactor does not apply directly. But the *shape* of it is a lesson in a problem webadb does have: separating stateless configuration from per-connection state. The `ScrcpyOptions` object became immutable and shareable; the parser became per-connection and stateful; the serializer gained the parser as an explicit collaborator rather than reaching through options. That is the correct factoring for anything that has to serve more than one connection at a time — and webadb's own `lib/adb-client.ts` currently keeps a single `AdbClient` singleton with a single `AdbSession`, which is exactly the limitation that this refactor removes upstream.

**The real blocker for webadb remains the version gap.** webadb is on `@yume-chan/adb` `3.0.0-beta.1`; upstream released `3.0.0-beta.5` on 2026-11-06 and has published nothing since. The npm dist-tags are still `{ latest: "2.6.4", beta: "3.0.0-beta.5" }`. PR #880 sits on top of `3.0.0-beta.5` and is not merged, so it is not in any published artifact. When it lands, it will land with a breaking change to `ScrcpyOptions` — the `clipboard` and `uHidOutput` fields disappear, and `deviceMessageParsers` becomes `createDeviceMessageParser`. Any project pinned to the old shape will need the corresponding edit, which is why the diff touches sixteen version directories' `options.ts` files rather than just the newest.

**And the WebUSB blocklist gap is the thing to watch on the spec side.** The WebUSB spec has a protected-usage-page mechanism and no deployment channel for it. If the WHATWG were to give WebUSB the same runtime-fetchable blocklist that WebHID got last week, the first question would be whether any Android vendor ID lands on it. Today none do — which is precisely why webadb works today. It is worth re-running the check periodically; the answer is one URL away:

```
curl -sLI https://usb.spec.whatwg.org/blocklist.txt
```

The chrome-direct-sockets check was skipped today (Tuesday — it runs weekly, on Mondays).
