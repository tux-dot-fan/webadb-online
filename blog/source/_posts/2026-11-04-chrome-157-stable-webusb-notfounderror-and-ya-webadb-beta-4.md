---
title: "Chrome 157 goes stable, and WebUSB's disconnect semantics finally changed"
date: 2026-11-04 01:00:00 UTC
tags:
  - webusb
  - chrome
  - ya-webadb
  - adb
  - webadb
---

Chrome 157 reached the stable channel on Tuesday, November 3, 2026 — version
`157.0.8103.38` on Linux and `157.0.8103.38`/`.39` on Windows and macOS, with
213 security fixes (7 rated critical, 6 of them memory-safety bugs in
graphics and rendering code). The same build shipped to Chrome for Android
(`157.0.8103.38`) and Chrome for iOS (`157.0.8103.37`) the same day. Microsoft
Edge 157 follows on November 5 with the same platform features.

That release is the headline, but the part that actually touches webadb is
smaller and quieter: Chromium's WebUSB implementation now rejects a pending
`transferIn()` with `NotFoundError` when the device is unplugged, instead of
the generic `NetworkError` the WebUSB specification still describes. Two
upstream projects noticed — the WebUSB spec's own issue tracker and
ya-webadb — and ya-webadb's fix is on npm right now, in
`@yume-chan/adb-daemon-webusb@3.0.0-beta.4`. webadb.online is still running
`3.0.0-beta.1`. That gap is three weeks wide and it covers a rewrite of the
exact WebUSB writable path our device transport uses.

## Chrome 157: the platform webadb actually runs on

The stable channel notes for 157 are modest by recent standards, and most of
it is unrelated to what we do:

- `text-overflow` accepts a custom `<string>` value, so you can render
  `" (more)"` instead of the ellipsis. Firefox has shipped this since 2011;
  Chrome is catching up roughly fifteen years later. The `corner` shorthand
  lands too, folding `border-radius` and `corner-shape` into one declaration
  (`corner: 20px squircle`), with per-corner and logical variants.
- A family of HTML insertion and streaming methods —
  `beforeHTML()`, `afterHTML()`, `appendHTML()`, `prependHTML()`,
  `replaceWithHTML()`, plus `streamHTML()` / `streamAppendHTML()` returning
  `WritableStream`s — aimed at replacing `insertAdjacentHTML()` with one
  coherent, Trusted-Types-aware story. The ChromeStatus entry is still
  marked "pending review", so we would not ship against it yet.
- The `Sanitizer` API grows an explicit `javascriptURLs` option instead of
  the behaviour being a side effect of which method you called.
- The Background Fetch API now enforces CORS, closing a bypass where a site
  could skip CORS and Local Network Access checks by using Background Fetch
  instead of `fetch()`.
- `Long Animation Frames` gains `styleDuration` and `forcedStyleDuration`,
  so you can finally tell whether a janky frame came from style recalc or
  from a script forcing layout.
- The Language Detector API ships on Android (Clank), and
  `BluetoothRemoteGATTServer` becomes an `EventTarget`.

None of that is what we build on. What we build on is `navigator.usb`, and
the one item in the 157 cycle that touches USB is a WebUSB hardening change
in `services/device/usb/mojo/device_impl.cc` — commit `89b42d2d`, *"WebUSB:
Strengthen control transfer protection for protected classes"*, bug
`489711638`:

```
Strengthens control transfer permissions to block requests targeting
protected interface classes like HID or Mass Storage. Requests are now
scrutinized for protected interfaces via the wIndex field regardless of
recipient. Standard requests for device-level management remain allowed.
This behavior is gated by the kWebUsbProtectedClassControlTransferBlock
feature flag.
```

The protected-class list is HID (`0x03`), mass storage (`0x08`), and the
other class-code owners the OS already has kernel drivers for. ADB's interface
is vendor-specific (`0xFF`), so this does not touch our traffic — but the
mechanism is worth understanding, because it is the *same* `wIndex`-based
scrutiny that made the disconnect behaviour change described below legible in
the first place. (Electron cherry-picked this same Chromium commit into
`39-x-y` on April 1, 2026, so it predates the 157 cycle — it is in the stable
channel already, and is not what I am writing about today. The disconnect
change *is*.)

## The disconnect semantics change, and the spec that did not follow

The interesting change is not in the release notes at all. It is in
[`whatwg/usb` issue #219](https://github.com/whatwg/usb/issues/219),
*"Can't detect device disconnection when `transferIn` is waiting incoming
data"*, filed back in 2022 and still open.

The problem, as originally reported: in a polling design, `transferIn()` is
called continuously to receive incoming data. If the device disconnects,
`transferIn` step 14 throws a generic `NetworkError`. The `disconnect` event
is fired *after* the error was thrown (at least on Windows and Chrome), which
makes it impossible to distinguish "the cable fell out" from "the device
misbehaved". The issue proposes two things: throw `NotFoundError` from
`transferIn` when the failure reason is device disconnection, and precisely
define the ordering of the `disconnect` event, the `device.open` property
change, and the `transferIn` rejection.

On 2026-10-01, `kvnloo` posted the answer as a comment:

> Current Chromium looks like it may have moved since this was filed.
> `USBDevice::OnConnectionError()` now rejects every pending
> `device_requests_` resolver with `NotFoundError` and `"The device was
> disconnected."`, including an outstanding `transferIn()`.
>
> That seems to implement the first suggestion here already. A focused WPT
> that starts a pending `transferIn()`, disconnects the fake device, and
> asserts `NotFoundError` would tell us whether this can now be closed or
> whether there is still a platform-specific ordering problem.

Note what this means in practice. The old code path had to *guess*. The
original Chromium behaviour — and the behaviour the spec still describes —
is that a disconnect surfaces as `NetworkError`, which is indistinguishable
from a transfer-level failure. The ya-webadb fix for that, in
`libraries/adb-daemon-webusb/src/device.ts`, is a heuristic: on `NetworkError`,
sleep 100 ms, then check whether the connection was closed in the meantime,
and only then treat it as a clean disconnect.

```ts
} catch (e) {
    // On Windows, disconnecting the device will cause `NetworkError` to be thrown,
    // even before the `disconnect` event is fired.
    // Wait a little while and check if the device is still connected.
    // https://github.com/WICG/webusb/issues/219
    if (isErrorName(e, "NetworkError")) {
        await new Promise<void>((resolve) => {
            setTimeout(() => {
                resolve();
            }, 100);
        });

        if (closed) {
            return undefined;
        }
    }

    throw e;
}
```

That is a timer, a race, and a 100 ms window during which a real error is
indistinguishable from a cable pull. With the new Chromium behaviour there
is no ambiguity at all: `NotFoundError` *means* "the device was
disconnected". The fix that landed on top of it is three lines:

```diff
     }
 
+    // https://github.com/whatwg/usb/issues/219#issuecomment-5937803105
+    if (isErrorName(e, "NotFoundError")) {
+        return undefined;
+    }
+
     throw e;
 }
```

`return undefined` is the sentinel this function already uses for "the
connection ended cleanly, stop the read loop". So the new path is exact: no
timer, no race, no 100 ms of latency before the UI learns the phone is gone.

The WebUSB specification has not caught up. The draft community group report
is dated 5 June 2026 and still describes the old generic `NetworkError`
behaviour, and issue #219 remains open pending a focused WPT. That gap is
worth naming, because code written today against the *spec* rather than
against Chromium will still have the heuristic in it — and the heuristic is
still correct as a fallback for browsers that have not shipped the change.
The two paths coexist in the same `catch` block, which is the right shape:
`NetworkError` is ambiguous and needs disambiguation, `NotFoundError` is not.

## What else changed in ya-webadb since beta.1

`3.0.0-beta.4` was published to npm on 2026-10-09, the same day as the
release commit `7bcec613`. Between `v3.0.0-beta.1` and `v3.0.0-beta.4` there
are fifteen commits, and two of them touch code that webadb.online runs
directly.

### The WebUSB writable path was rewritten

PR [#869](https://github.com/yume-chan/ya-webadb/pull/869), *"fix(adb): wait
for sync send v1 completion"*, merged 2026-09-17 as `69fffaf0` (co-authored
by Qingyu Wang), rewrote the writable half of
`AdbDaemonWebUsbConnection`. In `beta.1` it was:

```ts
this.#writable = pipeFrom(
    duplex.createWritable(
        new MaybeConsumable.WritableStream({
            write: async (chunk) => {
                await device.raw.transferOut(
                    outEndpoint.endpointNumber,
                    // WebUSB doesn't support SharedArrayBuffer
                    // https://github.com/WICG/webusb/issues/243
                    toLocalUint8Array(chunk),
                );
                // ... zero-length packet handling ...
            },
        }),
    ),
    new AdbPacketSerializeStream(),
);
```

In `beta.4` it is:

```ts
const serializeStream = new AdbPacketSerializeStream();
this.#writable = new DelayedCloseWritableStream(
    serializeStream.writable,
    serializeStream.readable.pipeTo(
        duplex.createWritable(
            new MaybeConsumable.WritableStream({
                write: async (chunk) => { /* same transferOut body */ },
            }),
        ),
    ),
);
```

The `pipeFrom` helper was deleted outright (`libraries/stream-extra/src/pipe-from.ts`,
28 lines removed) and replaced by `DelayedCloseWritableStream`, a new
78-line class in `libraries/stream-extra/src/delayed-close-writable.ts`.

The name tells you the bug. `pipeFrom` starts the source pump eagerly and
returns a writable that writes into it. Nothing in that shape guarantees the
pump has *drained* before the writable is closed. The ADB sync service's
`sendV1` — the v1 push protocol that `adb push` uses — writes a `DONE`
request and then closes the stream, and the server's `OKAY` response arrives
*after* that. With `pipeFrom`, `writer.close()` could resolve before the
final `OKAY` was ever read, so `push` would report success for a transfer
that the device had not actually acknowledged.

`DelayedCloseWritableStream` closes that hole by taking the pump promise
explicitly and making `close()` wait for both:

```ts
async close() {
    const [closeResult, promiseResult] = await Promise.allSettled([
        writer.close(),
        promise,
    ]);
    if (closeResult.status === "rejected") {
        if (
            promiseResult.status === "rejected" &&
            // Ignore promise rejection if the reason is known
            promiseResult.reason !== closeResult.reason &&
            typeof AggregateError !== "undefined"
        ) {
            throw new AggregateError([
                closeResult.reason,
                promiseResult.reason,
            ]);
        }
        throw closeResult.reason;
    }
    if (promiseResult.status === "rejected") {
        throw promiseResult.reason;
    }
}
```

The `reason !== closeResult.reason` check is the subtle part: when the pump
fails for the *same* reason the close failed, that is one error, not two, and
throwing an `AggregateError` over it would obscure the actual cause. When
they differ, you genuinely have two failures and `AggregateError` is right.
The same discrimination appears in `abort()`.

There is also a second, quieter fix in the same class — the same
`void promise.catch(() => {})` idiom that
[yesterday's post](https://webadb.online/blog/2026/11/03/ya-webadb-consumable-writable-unhandled-rejection-pr-878/)
covered for `Consumable.WritableStream.write`:

```ts
// Suppress unhandled promise warning when
// the promise is never awaited
void promise.catch(() => {});
```

It is not a coincidence that the same pattern shows up in two places in the
same library within three weeks. `DelayedCloseWritableStream` was written in
September; `Consumable.WritableStream.write` got the same treatment in the
open PR [#878](https://github.com/yume-chan/ya-webadb/pull/878) on
November 2. The library author is converging on "attach the handler eagerly"
as the house style for promise pairs where one failing implies the other.

### The credential store was rewritten around real IndexedDB semantics

PR [#871](https://github.com/yume-chan/ya-webadb/pull/871), *"fix(credential-web):
fix IndexedDB usage"*, landed 2026-10-02 as `7eaade3c` — the fix for
[issue #870](https://github.com/yume-chan/ya-webadb/issues/870), where
`TangoIndexedDbStorage.load()` always threw *"callback must not be an async
function"*.

The root cause is a genuinely nasty IndexedDB rule: an `IDBTransaction`
auto-commits the moment the microtask queue drains. If you `await` anything
non-IndexedDB inside a transaction callback — even a resolved promise — the
transaction is already inactive by the time your next `store.get()` runs, and
you get `TransactionInactiveError`. The fix is to do all the database work
synchronously inside the transaction callback and await the *request*, never
the transaction.

The new `libraries/adb-credential-web/src/storage/indexed-db/shared.ts`
is built around three helpers — `openDatabase`, `createTransaction`, and
`waitRequest` — and the diff is 181 lines. `waitRequest` explicitly refuses
to work inside a transaction:

```ts
it("should throw if used inside a transaction", async () => {
    const db = await openDatabase(nextDatabaseName(), 1, (db) => {
        db.createObjectStore("store", { autoIncrement: true });
    });
    const tx = db.transaction("store", "readwrite");
    const store = tx.objectStore("store");
    const request = store.put({ value: 1 });
    await assert.rejects(
        () => waitRequest(request),
        /Cannot wait for a request inside a transaction/,
    );
    db.close();
});
```

and `createTransaction` refuses async generators outright:

```ts
it("should reject async generators", async () => {
    await assert.rejects(
        // @ts-expect-error unit test
        createTransaction(db, "store", async function* () {
            yield new Promise((resolve) => setTimeout(resolve, 0));
        }),
        /Async generators are not supported/,
    );
});
```

Both rules are the same rule viewed from two directions: the transaction's
lifetime is bounded by the synchronous execution of its callback, and any
`await` that yields to the event loop ends it.

Two supporting changes ship alongside it. First, `AdbWebCryptoCredentialManager`
gains a `close()` method that forwards to the storage's optional `close()`,
so the underlying IndexedDB connection can be released — previously there was
no way to close it at all. Second, the fix comes with a real test suite:
`libraries/adb-credential-web/src/storage/indexed-db/shared.spec.ts`,
272 lines, running against `fake-indexeddb`. The `fake-indexeddb` package
plus `node:test` is how the library tests IndexedDB behaviour at all, and it
is why these bugs are now caught before shipping rather than in a user's
browser.

## Where webadb.online actually stands

Here is the part that matters for us.

```
$ grep -o '"version": *"[^"]*"' node_modules/@yume-chan/*/package.json
@yume-chan/adb                installed: "3.0.0-beta.1"
@yume-chan/adb-credential-web installed: "3.0.0-beta.1"
@yume-chan/adb-daemon-webusb  installed: "3.0.0-beta.1"
@yume-chan/stream-extra       installed: "3.0.0-beta.1"
```

All four of our `@yume-chan/*` dependencies are pinned three beta releases
behind what is on npm. `npm view @yume-chan/adb dist-tags` reports
`latest: 2.6.4`, `beta: 3.0.0-beta.4`, with `3.0.0-beta.4` published
2026-10-09.

The gap is not cosmetic. Concretely:

- **Our device transport still uses the `pipeFrom`-based writable path**, so
  an `adb push` through the File Manager panel can in principle resolve
  before the device acknowledges the transfer. The `push.spec.ts` tests
  added in `beta.3` assert exactly this ordering:
  ```ts
  const closedBeforeResponse = closed;

  response.enqueue(
      Socket.NumberRequest.serialize({
          id: ResponseId.Ok,
          arg: 0,
      }),
  );
  await closePromise;

  assert.strictEqual(closedBeforeResponse, false);
  ```
  That assertion — `closedBeforeResponse === false` — is the test that would
  fail on `beta.1`.
- **Our disconnect handling still pays the 100 ms heuristic penalty.** Our
  `lib/adb-client.ts` `watchDisconnect` listens for the `navigator.usb`
  `"disconnect"` event and races it against `transport.disconnected`. The
  upstream read loop, on `beta.1`, sleeps 100 ms on every ambiguous
  `NetworkError` before it can tell you the phone is gone. On `beta.4` with
  a current Chrome, it would know immediately.
- **We do not use `TangoIndexedDbStorage`**, so the IndexedDB rewrite is not
  directly a problem for us. We use `TangoLocalStorage` — `new
  AdbWebCryptoCredentialManager(new TangoLocalStorage(ADB_KEY_STORAGE_KEY))`
  at `lib/adb-client.ts:88` — which stores the RSA key as base64 PKCS#8 in
  `localStorage` and sidesteps IndexedDB's transaction-lifetime rules
  entirely. That was a deliberate choice when we moved to the 3.0 beta line
  and it remains the right one for us. The `close()` addition to
  `AdbWebCryptoCredentialManager` is still worth having: it gives us a
  deterministic teardown path for the credential manager when a session
  ends, rather than leaving it to garbage collection.

There is one more consequence of the upgrade that is not a bug fix at all.
`beta.4` includes `d8d1ddc8` — *"feat(scrcpy): add version 5.0 and 5.0.1 as
aliases"* — which adds scrcpy 5.0 and 5.0.1 to the server-version alias
table. scrcpy 5.0 shipped on 2026-10-05 and 5.0.1 on 2026-10-08. Our
Screencast panel does not use the scrcpy server at all — it uses the
file-based `adb shell screenrecord` polling pipeline — but the alias table
is the library's canonical list of known scrcpy server versions, and it is
worth knowing the library now speaks for a scrcpy generation that postdates
our own implementation choices.

## Why the Chrome 157 timing makes this worth doing now

Chrome 157 rolled out to stable on November 3 and will reach users "over the
coming days/weeks" — the same rollout pattern as every Chrome release, but
it means the `NotFoundError` disconnect behaviour is now in the hands of the
general public rather than sitting behind a flag on a developer build.

That matters for a specific reason. The `NotFoundError` path in
`AdbDaemonWebUsbConnection` is a *fast* path: it returns immediately. The
`NetworkError` path is a *slow* path: it waits 100 ms, and if the connection
was closed in the meantime, it reports a clean disconnect. On a browser that
has not shipped the change, our code takes the slow path and the extra 100 ms
shows up as a small but real lag between "I yanked the cable" and "the UI
says the device is gone".

Once Chrome 157 is the dominant stable build, the fast path is the default
and the heuristic becomes a fallback for older browsers rather than the
primary mechanism. Upgrading to `beta.4` is what lets us take that path.

There is a broader point about the shape of these dependencies. ya-webadb is
pre-1.0 and its betas move fast: three releases in ten weeks, each carrying
behavioural changes to the transport layer that we consume. Our `package.json`
says `^3.0.0-beta.1`, and npm's caret semantics on a prerelease tag do *not*
mean "upgrade to any later beta" — they resolve to exactly what is installed
here, `3.0.0-beta.1`, and stay there. Upgrading is a deliberate act, not an
automatic one, and it should be.

## What this means for webadb.online

Directly relevant, and there is a concrete action item.

We are running `3.0.0-beta.1` of the ADB library stack while `3.0.0-beta.4`
has been on npm since October 9. The two changes in that window that affect
us are the `DelayedCloseWritableStream` rewrite of the WebUSB writable path
(the `adb push` acknowledgement ordering) and the `NotFoundError` handling in
the read loop (the disconnect fast path). Both are the kind of change that is
invisible when it works and produces a confusing bug report when it does
not — a file upload that silently reports success, or a device that lingers
in "connected" state for a beat after you unplug it.

Our plan is to bump all four `@yume-chan/*` dependencies to `3.0.0-beta.4`,
verify the File Manager upload path and the connect/disconnect cycle in the
browser against a real device, and confirm the `push.spec.ts` ordering
assertion holds on our transport. The `TangoLocalStorage` credential path is
unaffected, since `beta.4`'s IndexedDB rewrite only touches
`TangoIndexedDbStorage`, which we do not use.

Beyond that, Chrome 157 is a good excuse to re-check our platform
assumptions in one place. Our `_headers` file already sets COOP/COEP/CORP
because ya-webadb's `SharedArrayBuffer` usage requires cross-origin
isolation, and the `toLocalUint8Array` copy in the transfer path exists
because *"WebUSB doesn't support SharedArrayBuffer"*
([whatwg/usb#243](https://github.com/whatwg/webusb/issues/243)). Chrome 157
did not change any of that. But the release is a reasonable checkpoint for
re-reading the WebUSB spec draft (5 June 2026) against what Chromium
actually does — because as of `kvnloo`'s comment on
[whatwg/usb#219](https://github.com/whatwg/usb/issues/219#issuecomment-5937803105),
the two have already diverged on disconnect semantics, and the spec is the
one that is behind.

One note on process: the Chromium Direct Sockets check that runs on Mondays
is skipped this week — today is Wednesday, and that source is weekly by
design.
