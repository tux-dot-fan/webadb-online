---
title: ya-webadb ships PR #871 (IndexedDB credential-storage fix) and a WebUSB NotFoundError handler
date: 2026-10-04 11:25:00
tags:
  - ya-webadb
  - credential-storage
  - indexeddb
  - webusb
  - regression-fix
  - deep-dive
---

Two commits landed on the ya-webadb upstream on 2026-10-02:

- [`7eaade3`](https://github.com/yume-chan/ya-webadb/commit/7eaade3) —
  `fix(credential-web): fix IndexedDB usage (#871)`
- [`a5134b5`](https://github.com/yume-chan/ya-webadb/commit/a5134b5) —
  `feat(webusb): handle NotFoundError in transferIn`

The first one closes the regression we wrote up on
[`2026-09-22`](https://webadb.online/blog/2026/09/22/ya-webadb-3-0-0-beta-3-indexeddb-storage-regression/)
and flagged as still-open in our
[`2026-09-28`](https://webadb.online/blog/2026/09/28/monday-recheck-direct-sockets-chromestatus-still-stale-across-the-board/)
Monday re-check. The second one is a five-line resilience patch for
the WebUSB transport's `transferIn` loop, and the maintainer's choice
of error name is worth a paragraph on its own. Both commits are on
`main`, neither has shipped as a tagged release yet.

This post is the read-through: how the IndexedDB fix differs from the
two patches we sketched in the Sep 22 writeup (the issue reporter's
"resolve with `request.result` in `oncomplete`" pattern, plus our
"drop the cache" alternative), why the generator-based fix that
actually shipped is a better answer than either, what the new
`close()` method on `TangoKeyStorage` is for, and how the WebUSB
`NotFoundError` handler slots into the existing transfer-retry
state machine.

## What the IndexedDB fix actually changed

`7eaade3` is 17 files, +688/-111 lines, dominated by a rewrite of
`libraries/adb-credential-web/src/storage/indexed-db/shared.ts`. The
old `createTransaction` callback signature `(tx) => T` is replaced
with a generator-based one:

```ts
// BEFORE (beta.3, broken)
export function createTransaction<T>(
    database: IDBDatabase,
    storeName: string,
    callback: (transaction: IDBTransaction) => T,
): Promise<T> {
    // ...
    try {
        result = callback(transaction);
        if (result instanceof Promise) {
            throw new Error("callback must not be an async function");
        }
    } catch (e) {
        try { transaction.abort(); } catch {}
    }
}

// AFTER (PR #871)
type WaitRequestHelper = <T>(
    request: IDBRequest<T>,
) => Iterable<IDBRequest<any>, T, unknown>;

function* waitRequestHelper<T>(
    request: IDBRequest<T>,
): Iterable<IDBRequest<any>, T, T> {
    return yield request;
}

type TransactionCallback<T> = (
    transaction: IDBTransaction,
    store: IDBObjectStore,
    waitRequest: WaitRequestHelper,
) => Generator<IDBRequest<any>, T, unknown>;

export async function createTransaction<T>(
    database: IDBDatabase,
    storeName: string,
    callback: TransactionCallback<T>,
    options: IDBTransactionOptions & { mode: IDBTransactionMode } = {
        mode: "readonly",
    },
): Promise<T>;
```

Call sites move from "return a Promise from a synchronous callback,
get yelled at" to "yield `IDBRequest` values from a generator, the
helper awaits them inside the transaction's micro-task window."
`v1.ts` and `v2.ts` both flip to the generator pattern:

```ts
// v1.ts (getAllKeysV1)
return await openDatabase(
    DefaultDatabaseName,
    Version1,
    () => {},
    (db) =>
        createTransaction(
            db,
            DefaultStoreName,
            function* (_, store, waitRequest) {
                return yield* waitRequest(
                    store.getAll() as IDBRequest<Uint8Array[]>,
                );
            },
        ),
);

// v2.ts (save)
await createTransaction(
    db,
    this.#storeName,
    function* (_, store) {
        yield store.add({ privateKey, name } satisfies TangoKey);
    },
    { mode: "readwrite" },
);
```

The behavioral changes underneath the API churn are three:

1. **`createTransaction` no longer rejects Promise returns.** The
   old guard `if (result instanceof Promise) throw ...` is gone;
   the new generator-based interface doesn't even have a synchronous
   callback to reject. Bug #1 from the Sep 22 post is fixed by
   removing the trapdoor instead of by patching the trapdoor.
2. **`waitRequest` now refuses to operate inside a transaction.**
   The function rejects with
   `Error: Cannot wait for a request inside a transaction` if it
   detects `request.transaction !== null`. The right primitive for
   in-transaction waiting is the generator's `waitRequestHelper`,
   which yields an `IDBRequest` and re-enters the transaction's
   micro-task window on `onsuccess`. Using `waitRequest` inside a
   transaction was an `AbortError` factory — every queued micro-task
   landed after the transaction had auto-committed, so the request
   event handler fired against a stale handle. The new guard makes
   that footgun impossible to load.
3. **The cached `IDBDatabase` is no longer closed after each
   operation.** `v2.ts` drops the `try { ... } finally { db.close() }`
   pattern from `save()` / `load()` / `clear()` and adds a new
   `close()` method on `TangoIndexedDbStorage`. The cache survives
   across operations; closing it is the consumer's responsibility.

The third one is the interesting call. The Sep 22 post sketched two
options:

```ts
// Option A: keep the per-operation close, drop the cache
async #openDatabase() {
    return this.#openDatabaseCore();   // no ??=, no memoization
}

// Option B: keep the cache, drop the closes
async save(privateKey, name) {
    const db = await this.#openDatabase();
    await createTransaction(db, this.#storeName, (tx) => { ... });
    // no finally { db.close() }
}
```

The shipped fix is Option B, plus a `close()` method so the
consumer can still free the underlying IndexedDB worker thread
when they're done. The `TangoKeyStorage` interface in
`storage/type.ts` now has an optional `close()`:

```ts
export interface TangoKeyStorage {
    load():
        | Iterable<MaybeError<TangoKey>>
        | AsyncIterable<MaybeError<TangoKey>>;

    close?(): MaybePromiseLike<undefined>;
}
```

…and all three concrete implementations (`TangoIndexedDbStorage`,
`TangoPasswordProtectedStorage`, `TangoPrfStorage`) implement it,
plus `AdbWebCryptoCredentialManager` exposes it on the manager
level:

```ts
// manager.ts (the wrapper)
close() {
    return this.#storage.close?.();
}
```

The `AdbCredentialManager` interface in
`libraries/adb/src/daemon/auth/packet-processor.ts` picks up the
same optional `close()` so `adbDaemonAuthenticate()` callers can
release the handle when they tear down.

The reasoning behind Option B over Option A is that
`adbDaemonAuthenticate()` is on the hot path — it runs every time
a connection opens — and Option A would re-open the database (and
pay the `onupgradeneeded` gating) on every reconnect. Option B
amortizes that cost, and the `close()` hook gives downstream code
an escape hatch. The implementation also adds a small race
fix: `#openDatabasePromise` is now reset to `undefined` inside
`close()` before the awaited `db.close()` resolves, so a
`save()` racing with `close()` doesn't accidentally hand back the
just-closed handle.

## Why the generator pattern is the right answer

The Sep 22 post endorsed the issue reporter's fix sketch: "return
`IDBRequest` from the callback, resolve with `request.result` in
`oncomplete`." That's a 10-line change and it does fix the
synchronous-Promise bug. What it doesn't fix is the second class
of footgun: a callback that *does* multiple operations on the
transaction. IndexedDB transactions auto-commit when control
returns to the event loop without a queued request. A callback
that wants to `get()` a value, branch on it, then `put()` a
different value can't be expressed as "synchronously return an
`IDBRequest`" — it has to wait for the first request to settle,
and by then the transaction is gone.

The generator pattern solves that by collapsing "wait for this
request" into a single language primitive (`yield request`) and
having `createTransaction` drive the generator forward only when
the yielded request's `onsuccess` fires — *inside* the
transaction's micro-task window, which is the only window where
you can queue another request against the same transaction.
TypeScript's `Generator<IDBRequest<any>, T, unknown>` type makes
this statically checkable: the `yield` expression has to be an
`IDBRequest`, and the function's eventual return type is `T`.

```ts
// Inside waitRequestInTransaction
request.onsuccess = () => {
    try {
        // The transaction is "active" only when handling a
        // request's success or error events. Run next section
        // of the generator function.
        resolve(advance(generator, generator.next(request.result)));
    } catch (e) {
        // Prevent automatic transaction abortion
        // https://w3c.github.io/IndexedDB/#ref-for-abort-a-transaction%E2%91%A0%E2%91%A1
        reject(e);
    }
};

request.onerror = (e) => {
    try {
        // Prevent automatic transaction abortion
        // https://w3c.github.io/IndexedDB/#ref-for-canceled-flag%E2%91%A0
        e.preventDefault();
        // Prevent the event from bubbling to the transaction's `onerror`
        // https://w3c.github.io/IndexedDB/#ref-for-get-the-parent%E2%91%A1
        e.stopPropagation();
        // Let the generator function handle the error.
        resolve(advance(generator, generator.throw(request.error)));
    } catch (e) {
        reject(e);
    }
};
```

The two `e.preventDefault()` / `e.stopPropagation()` calls on the
error path are the IndexedDB-spec-mandated incantation to keep
the transaction alive when a request errors. Without them, the
first error auto-aborts the transaction and every subsequent
queued request errors out with the same `AbortError`. With them,
the generator's `try { yield ... } catch (e) { ... }` can decide
whether the error is fatal or recoverable.

The shipped pattern is more verbose than the issue reporter's
sketch but it's a strictly larger superset of what you can
express: the single-request "yield one request, return its
result" case is still one line, and you also get the
multi-request case for free. The cost is 181 lines of shared.ts
vs the 30-line original. That's a fair trade — the bug class
the original opened (a synchronous callback rejecting Promises,
plus the auto-commit window leaking across multi-step operations)
goes away entirely.

## What we still don't know about PR #871

Three things the diff doesn't tell us:

- **No new test fixture exercises the multi-request transaction
  path.** The new `shared.spec.ts` adds 272 lines of test coverage,
  but the public call sites in `v1.ts` and `v2.ts` are all
  single-request generators. The "yield `get()`, branch, yield
  `put()`" use case — the one that motivated the pattern — has
  no fixture. It would be one for the test suite to add.
- **The `onerror` path's `stopPropagation` only fires when the
  request's own `onerror` is wired up by `waitRequestInTransaction`.
  If a downstream `IDBObjectStore.put(...)` rejects inside a
  generator body without being yielded, the error bubbles to the
  transaction's `onerror`, and the transaction aborts. The
  spec-correct behavior for `IDBObjectStore` operations that
  throw synchronously is to abort, so this is fine — but it's a
  subtle distinction. The generator's `catch` only fires for
  errors that happen *during* a yielded request's `onsuccess`
  handler.
- **The PR doesn't bump the package version.** `package.json` in
  `libraries/adb-credential-web` only changes by the lockfile
  bumps (`+6/-6` is the index lock churn, no `version` field
  change in this diff). The next tagged release of `adb-credential-web`
  will ship the new code, but until that tag is cut, anyone pinning
  to `3.0.0-beta.3` is on the broken tree. The Sep 22 post's
  workaround — pin `3.0.0-beta.2` or switch backends — is still
  the right call until the next beta tag.

## The WebUSB `NotFoundError` handler

The other commit, [`a5134b5`](https://github.com/yume-chan/ya-webadb/commit/a5134b5),
is a five-line patch in
`libraries/adb-daemon-webusb/src/device.ts` around line 235 of
the `AdbDaemonWebUsbConnection` class. Inserted inside the
existing `transferIn` retry loop, which already handles
`NetworkError` (re-issues the transfer) and re-throws everything
else. The full diff is:

```diff
             if (isErrorName(e, "NetworkError")) {
                 ...
             }
+
+            // https://github.com/whatwg/usb/issues/219#issuecomment-5937803105
+            if (isErrorName(e, "NotFoundError")) {
+                return undefined;
+            }
+
             throw e;
```

It's inserted inside the existing `transferIn` retry loop, which
already handles `NetworkError` (re-issues the transfer) and
re-throws everything else. The new branch absorbs
`NotFoundError` — which means "the device handle no longer exists
in the browser's USB device set" — and resolves the in-flight
read with `undefined` instead of throwing.

The whatwg/usb issue link in the comment
([`whatwg/usb#219`](https://github.com/whatwg/usb/issues/219#issuecomment-5937803105))
is the spec thread where this was hashed: when a user revokes USB
permission mid-transfer (Chrome's permission UI, the OS removing
the device, the user unplugging it from a hub), the in-flight
`transferIn()` promise rejects with `NotFoundError` on most
Chromium versions, regardless of whether the underlying
`usbDevice` is still in ` navigator.usb.getDevices()`. The
previous behavior of "throw on any non-`NetworkError`" means a
disconnect during a long-running shell stream surfaces as an
uncaught promise rejection in the consumer, not as a clean
"stream ended" signal. The patch turns the disconnect into the
same "stream ended" signal that a normal close would produce.

This is the same fix shape that the webrtc / WebSocket layers
have had for years — treat "the underlying resource went away"
as a normal end-of-stream, not an error. The WebUSB transport's
disconnect detection was the last major consumer of
ya-webadb's `Readback`/`Writeback` that didn't have it.

Three implications for downstream consumers:

1. **Stream handlers can drop their `try { ... } catch (e) { if (e.name !== "NotFoundError") throw }` boilerplate.**
   Before the patch, every consumer that wanted to gracefully
   handle disconnects had to filter `NotFoundError` themselves.
   Now the transport does it. A `ReadableStream`'s
   `cancel()` callback fires when the underlying source resolves
   with `undefined`, and the consumer can clean up state from
   there.
2. **Disconnect detection latency drops to whatever the next
   `transferIn` was scheduled to run.** Before, a disconnect
   would surface as the next `transferIn`'s rejection; now it
   surfaces the same way, just without throwing. There is no
   "proactive" detection — if no transfer is queued, the
   transport doesn't notice. The `disconnected: Promise<void>`
   on `AdbSession` is still the canonical "did the device go
   away" signal.
3. **The fix is upstream-only.** ya-webadb's transport handles
   this for every consumer; there's no app-level patch needed.
   If you've been writing `if (e.name === "NotFoundError")
   return` in your own WebUSB code, you can delete it once you
   upgrade.

## What's next on the ya-webadb release train

The two commits are on `main` but no `3.0.0-beta.4` tag has been
cut yet. The Sep 22 post anticipated the IndexedDB fix would land
"in `3.0.0-beta.4` (or RC)" and that's still the working
expectation. The `NotFoundError` fix is independent enough that it
could ship in the same beta or get folded into a `3.0.0` RC
depending on what else the maintainer has queued.

For webadb.online specifically, the IndexedDB fix doesn't change
our pinning calculus: we're on `TangoLocalStorage`, not
`TangoIndexedDbStorage`, and we pinned `3.0.0-beta.1` (not
`beta.3`) for unrelated reasons. What the fix *does* do is
unblock the option of pinning `beta.3` (or whatever the next
tagged version is) without taking on the regression. The
`NotFoundError` patch is a clean improvement to the WebUSB
transport and a freebie if we ever do bump.

The `webadb-roadmap` post we wrote back in July flagged "WebUSB
disconnect UX" as a P3 follow-up; this commit is upstream-of-
that-work. The improvement we'd still want on top is proactive
disconnect detection (a `Device.statechange` listener that
cancels in-flight transfers when the device is unplugged), but
that's a separate change.

## What this means for webadb.online

No code change required. We're still on `TangoLocalStorage`,
still pinned at `3.0.0-beta.1`, and neither of these upstream
commits is reachable from our deployed bundle. The IndexedDB fix
removes one of the two reasons we'd been wary of bumping to
`beta.3` (the other being the lack of field time on that beta
since release); the `NotFoundError` patch improves the resilience
of the WebUSB transport we do use, even if indirectly.

The takeaway for downstream ya-webadb integrators who were on
the IndexedDB path: when the next `adb-credential-web` tag
lands (presumably `3.0.0-beta.4`), upgrade. The fix is
structurally different from the synchronous-Promise workaround
the issue reporter proposed, and it closes a class of bugs
(yielding non-`IDBRequest` values, multi-step transactions
auto-committing, error paths auto-aborting) that the workaround
would not have caught. If you're on `TangoLocalStorage` like
we are, the upgrade is safe but optional; the new code paths
are unreachable from your call sites.

For the `NotFoundError` fix: if you're shipping a downstream
app and you have `if (e.name === "NotFoundError") return` in
your WebUSB error handlers, you can delete it once you pull in
`a5134b5` or later. The transport now does the right thing on
its own.

We'll keep watching `main` for the next beta tag. The Sep 22
"watch list" we wrote up — `7eaade3` closing the regression, a
new beta or RC, then a few weeks of field time — has now
checked the first box.