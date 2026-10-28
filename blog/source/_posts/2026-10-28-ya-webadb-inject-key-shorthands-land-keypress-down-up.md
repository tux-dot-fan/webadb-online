---
title: "ya-webadb lands inject-key shorthands — a one-line keypress becomes Down, hold, Up"
date: 2026-10-28 01:00:00
tags:
  - ya-webadb
  - scrcpy
  - adb-scrcpy
  - key-events
  - input-injection
---

A single upstream commit landed in `yume-chan/ya-webadb` yesterday —
[`3a7d781cf3673e307ad514422c776505e14ffcac`](https://github.com/yume-chan/ya-webadb/commit/3a7d781cf3673e307ad514422c776505e14ffcac),
`feat(scrcpy): add inject key shorthands` — that adds three methods to the
scrcpy control writer: `injectKeyDown`, `injectKeyUp`, and `injectKeyPress`.
Twenty-nine lines added, one line changed, one file touched. The whole
feature is the difference between a caller having to know the scrcpy wire
protocol's action byte and not having to.

The interesting part is not the size of the diff. It is that this is the
*first* time the scrcpy control surface in ya-webadb has offered a
semantically complete key press — and that it arrived as a three-method
shorthand rather than as a new message type, which means it works against
every scrcpy server version the library supports, including the 1.15 servers
that predate the modern control-message framing.

## The commit

The whole change is in
[`libraries/scrcpy/src/control/writer.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/scrcpy/src/control/writer.ts),
which is the class that owns the outgoing control socket. Before the commit,
the class exposed exactly one key-related method:

```ts
injectKeyCode(message: Omit<ScrcpyInjectKeyCodeControlMessage, "type">) {
    return this.write(this.#serializer.injectKeyCode(message));
}
```

`ScrcpyInjectKeyCodeControlMessage` is a struct, defined in
[`libraries/scrcpy/src/control/inject-key-code.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/scrcpy/src/control/inject-key-code.ts):

```ts
export const ScrcpyInjectKeyCodeControlMessage = struct(
    {
        // value of `type` can change between versions
        type: u8,
        action: u8<AndroidKeyEventAction>(),
        keyCode: u32<AndroidKeyCode>(),
        repeat: u32,
        metaState: u32<AndroidKeyEventMeta>(),
    },
    { littleEndian: false },
);
```

Five fields, big-endian, 14 bytes on the wire. The `action` field is typed
as `u8<AndroidKeyEventAction>()`, and the enum it draws from is in
[`libraries/scrcpy/src/android/key-event.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/scrcpy/src/android/key-event.ts):

```ts
export const AndroidKeyEventAction = {
    Down: 0,
    Up: 1,
} as const;
```

Two values. `Down` is 0, `Up` is 1. This mirrors Android's own
`KeyEvent.ACTION_DOWN` / `KeyEvent.ACTION_UP`, which are 0 and 1 in the
platform's `KeyEvent.java` — the same file the enum's sibling
`AndroidKeyEventMeta` cites in its comment header.

So before yesterday, the caller had to write all of this:

```ts
await controller.write.injectKeyCode({
    action: AndroidKeyEventAction.Down,
    keyCode: AndroidKeyCode.Enter,
    repeat: 0,
    metaState: AndroidKeyEventMeta.None,
});
```

…to produce a single `Down` event, and then a second nearly-identical call
with `action: AndroidKeyEventAction.Up` to complete the press. Two calls,
two chances to forget the `repeat` or `metaState` fields, and — the real
hazard — a `Down` with no matching `Up` if the second call fails or the
socket dies between them.

## What landed

The commit adds three methods, and the diff is instructive in how small it
is:

```ts
injectKeyDown(
    message: Omit<ScrcpyInjectKeyCodeControlMessage, "type" | "action">,
) {
    return this.injectKeyCode({
        ...message,
        action: AndroidKeyEventAction.Down,
    });
}

injectKeyUp(
    message: Omit<ScrcpyInjectKeyCodeControlMessage, "type" | "action">,
) {
    return this.injectKeyCode({
        ...message,
        action: AndroidKeyEventAction.Up,
    });
}

async injectKeyPress(
    message: Omit<ScrcpyInjectKeyCodeControlMessage, "type" | "action">,
    hold: number = 100,
) {
    await this.injectKeyDown(message);
    await delay(hold);
    await this.injectKeyUp(message);
}
```

Three design decisions are worth pulling out.

**The `Omit<..., "type" | "action">` signature.** The caller supplies
`keyCode`, `repeat`, and `metaState`; the library supplies `type` (because
the numeric type byte is version-dependent — see the `// value of `type`
can change between versions` comment in the struct) and `action` (because
that's exactly what the shorthand exists to pick). The `Omit` is doing real
type-safety work: it is structurally impossible to pass the wrong `action`
to `injectKeyDown`, and impossible to forget `type` entirely. Compare with
the pre-commit signature, which required the caller to spell out `action`
correctly by hand and offered no way to express "down" as intent.

**The `type` → `action` import flip.** The diff changes
`import type { AndroidKeyEventAction }` to a value import, because the
shorthands need the enum's *runtime* values, not just its type. This is a
one-line change with a real consequence for bundlers: `AndroidKeyEventAction`
is a `const` object literal with two numeric members, so it is tree-shakeable
and cheap. But it does mean the `control/writer.ts` module now has a
runtime dependency on `../android/index.js`, where before the enum was
type-only and got erased at compile time. The `AndroidKeyEventAction` import
in `control/serializer.ts` is still `import type`, because the serializer
only ever *compares* against the enum, never reads a member off it.

**The `hold` default of 100ms.** `injectKeyPress` awaits `delay(hold)`
between the two events, defaulting to 100 milliseconds. The `delay` helper
comes from `@yume-chan/async` (a runtime dependency of `@yume-chan/scrcpy`
at `^4.1.3`), and it is the smallest possible implementation:

```js
export function delay(time) {
    return new Promise(resolve => {
        globalThis.setTimeout(() => resolve(), time);
    });
}
```

A plain `setTimeout` wrapped in a promise. No timer pooling, no cancellation
token, no abort signal. The `hold` parameter is a wall-clock delay between
the `Down` and the `Up` — it does not depend on the device acknowledging
anything, because the scrcpy control protocol has no acknowledgement for key
events. The control socket is a fire-and-forget stream of control messages.

100ms is a defensible default: it is long enough that a human-perceptible
key press registers as a press rather than a flicker, and short enough that
it doesn't feel laggy. But it is a *guess* — scrcpy's own Java client uses
`KeyEvent` repeat semantics rather than a fixed hold, and the real duration
that matters depends on the input method editor on the device side. For a
text field with an IME, a `Down`/`Up` pair 100ms apart is a normal key
press; for a game with a virtual joystick, the hold duration is the input.

## Why this is not a new message type

The most important property of the change is what it *isn't*. It isn't a new
control message, a new struct, or a new wire format. It's three methods on
top of `injectKeyCode`, which has existed since the library supported scrcpy
server 1.15.

That matters because of how the scrcpy control protocol is versioned. Each
supported server version gets its own implementation tree —
`libraries/scrcpy/src/1_15/`, `1_18/`, `2_4/`, `2_7/`, `3_0/`, `4_0/`,
`4_1/` — and each defines its own `control-message-types.ts` mapping from
the symbolic `ScrcpyControlMessageType` to a numeric byte. `InjectKeyCode`
is type `0` in *every single one of them*:

```
libraries/scrcpy/src/1_15/impl/control-message-types.ts:5:    [ScrcpyControlMessageType.InjectKeyCode]: 0,
libraries/scrcpy/src/1_18/impl/control-message-types.ts:5:    [ScrcpyControlMessageType.InjectKeyCode]: 0,
libraries/scrcpy/src/2_4/impl/control-message-types.ts:5:     [ScrcpyControlMessageType.InjectKeyCode]: 0,
libraries/scrcpy/src/2_7/impl/control-message-types.ts:5:     [ScrcpyControlMessageType.InjectKeyCode]: 0,
libraries/scrcpy/src/3_0/impl/control-message-types.ts:5:     [ScrcpyControlMessageType.InjectKeyCode]: 0,
libraries/scrcpy/src/4_0/impl/control-message-types.ts:5:     [ScrcpyControlMessageType.InjectKeyCode]: 0,
libraries/scrcpy/src/4_1/impl/control-message-types.ts:5:     [ScrcpyControlMessageType.InjectKeyCode]: 0,
```

The `keyCode` field itself is a `u32` in every version, and the Android key
code numbering it carries has been stable since API 1. So an
`injectKeyPress` written against the modern writer works against a scrcpy
1.15 server with no version-specific branch at all. The shorthand inherits
the full version range of the primitive it wraps.

This is a genuinely different design decision from PR #875, which landed the
day before (covered in yesterday's post) — that one added device-side
behaviour keyed off the server version. This one adds zero protocol
surface.

## The version quirk that makes `action` load-bearing

There is one place in the codebase where the `action` byte means something
subtly different, and it explains why the shorthand matters more than it
first appears.

In `libraries/scrcpy/src/1_15/impl/back-or-screen-on.ts`, the
`BackOrScreenOn` control message for scrcpy server 1.15 is serialized
conditionally on the action:

```ts
export function serializeBackOrScreenOnControlMessage(
    message: ScrcpyBackOrScreenOnControlMessage,
) {
    if (message.action === AndroidKeyEventAction.Down) {
        return BackOrScreenOnControlMessage.serialize(message);
    }

    return undefined;
}
```

For the 1.15 protocol, `BackOrScreenOn` is an `EmptyControlMessage` — it
carries no payload — and the server interprets the *arrival* of the message
as the action. Sending an `Up` would be meaningless, so the serializer
drops it. Compare with the 1.18 implementation, where
`BackOrScreenOnControlMessage` is a real struct with an `action: u8`
field:

```ts
export const BackOrScreenOnControlMessage = struct(
    { action: u8<AndroidKeyEventAction>() },
    ...
);
```

The key-event action byte is thus not a uniform, always-present field
across the protocol's history. In `InjectKeyCode` it always is — but that
consistency is a property of *that particular message*, established over
seven server versions, not a property of the protocol.

The new shorthands sit above the one message where the action byte is
reliably present. They do not extend to `backOrScreenOn`, which still
requires the caller to pass an explicit `AndroidKeyEventAction` — a
deliberate asymmetry, since the 1.15 special case means a `Down`/`Up` pair
is not universally meaningful.

## A caveat about `injectKeyPress` and the control socket

`injectKeyPress` is the first method on `ScrcpyControlMessageWriter` to be
`async` in a way that spans more than one write. Every other write method
(`injectTouch`, `injectText`, `injectKeyCode`, `setClipboard`,
`expandNotificationPanel`, `rotateDevice`, `startApp`, `resizeDisplay`) is
either synchronous or awaits exactly one `write()`.

`injectKeyPress` awaits two writes separated by a timer. That creates a
real hazard for callers that don't think about it: **the `Down` can be
written, the timer can elapse, and the `Up` write can fail** — because the
socket closed, because the server went away, because the session was
torn down during the 100ms window. In that case the device has received a
key-down with no key-up.

On Android that leaves the key in a pressed state. Depending on the app,
that means a modifier key stuck on, a held-down back button, or a text field
that keeps repeating the character. There is no rollback, because the
scrcpy control protocol has no "release everything" message; the closest
thing is `setDisplayPower`, which is unrelated.

The fix at the call site is straightforward — check the result of the
`Up`:

```ts
try {
    await controller.write.injectKeyPress({
        keyCode: AndroidKeyCode.Enter,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
    });
} catch {
    // The Down may or may not have landed. Best-effort cleanup:
    await controller.write.injectKeyUp({
        keyCode: AndroidKeyCode.Enter,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
    }).catch(() => {});
}
```

But it's worth knowing that the API's failure mode is "possibly stuck key"
rather than "nothing happened", and that the library does not paper over it.

## Where this is not yet available

The commit is on `main` only. It is not in any published tag:

```
$ git tag --contains 3a7d781c
(no output)
```

The most recent release is still `v3.0.0-beta.4` (`7bcec613`, 2026-10-09),
and the diff between that tag and `main` is exactly this one commit:

```
$ git diff --stat v3.0.0-beta.4 origin/main
 libraries/scrcpy/src/control/writer.ts | 30 +++++++++++++++++++++++++++++-
 1 file changed, 29 insertions(+), 1 deletion(-)
```

That is the entire delta between the last release and upstream `HEAD` as of
2026-10-28T01:00Z. Whatever comes next — beta.5, or a straight 3.0.0 — will
carry these three methods.

Also worth noting: this was a **direct push to `main`**, not a pull
request. The commit is authored by Simon Chan (`1330321+yume-chan@users.noreply.github.com`),
the same maintainer who authored PR #875 the day before, but unlike #875 it
has no review thread, no issue link, and no CI-linked test in the PR sense.
The commit message is a single conventional-commit line.

That is not a criticism — a 29-line, purely additive API convenience with
no protocol change is exactly the kind of change that does not need a
review cycle. But it does mean there is no discussion trail documenting
*why* `hold` defaults to 100ms, or whether `injectKeyPress` was meant to
handle the `Up` failure case. Those are open questions a PR would have
answered.

## What this means for webadb.online

**No impact on webadb this week.** The webadb screencast panel does not use
`@yume-chan/scrcpy` or `@yume-chan/adb-scrcpy` — it talks to
`adb shell screenrecord` and polls the output file, because `screenrecord`
has a different set of OEM problems than the scrcpy server does. The
dependency set in `package.json` is `@yume-chan/adb`,
`@yume-chan/adb-credential-web`, `@yume-chan/adb-daemon-webusb`, and
`@yume-chan/stream-extra`; the scrcpy packages are not among them, and
`grep -rn "AdbScrcpy" lib/ components/` returns nothing.

There is, however, one idea worth carrying forward. webadb's own shell
panel injects input through a completely different path — `adb shell input
keyevent <code>` — which is a *process spawn per key event*, with all the
cost that implies: a new shell process, a round trip, and a ~100ms+ latency
floor. The scrcpy path is a 14-byte binary write on a socket that is already
open. If webadb ever wants responsive hardware-key handling (volume keys,
power, media keys), the scrcpy control channel is the architecture that
scales, and `injectKeyPress` is the API shape it would use.

The `hold` default of 100ms is also a reasonable reference point for
whatever we do build. The `adb shell input keyevent` equivalent has no
notion of hold duration at all — it synthesizes a down+up pair server-side
with a fixed, undocumented interval. Having a client-controllable hold
parameter is the kind of detail that turns out to matter when you are
driving an IME.
