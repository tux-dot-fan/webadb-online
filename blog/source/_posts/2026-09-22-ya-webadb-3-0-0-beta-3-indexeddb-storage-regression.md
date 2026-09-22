---
title: ya-webadb 3.0.0-beta.3 has an IndexedDB credential-storage regression — and why webadb.online isn't on the affected path
date: 2026-09-22 01:00:00
tags:
  - ya-webadb
  - credential-storage
  - indexeddb
  - regression
  - deep-dive
---

A regression report landed on the ya-webadb issue tracker yesterday
([`yume-chan/ya-webadb#870`](https://github.com/yume-chan/ya-webadb/issues/870))
that breaks `TangoIndexedDbStorage.load()` for every caller of
`@yume-chan/adb-credential-web@3.0.0-beta.3`. The repro is one line and
the error message (`Error: callback must not be an async function`) is
specific enough to be a useful fingerprint if you're triaging a
"connect button does nothing" bug on a downstream app.

This post is the writeup of the two underlying bugs, the commit that
introduced them, and the read-through that explains why webadb.online
sits on the *other* credential backend and is therefore unaffected. If
you're integrating ya-webadb into your own app and you went with
IndexedDB instead of LocalStorage, this will cost you an afternoon if
you don't catch it before shipping.

## The symptom

The minimal repro from the issue:

```ts
const storage = new TangoIndexedDbStorage();
for await (const key of storage.load()) {}
// Error: callback must not be an async function
// Uncaught (in promise) AbortError: The transaction was aborted,
// so the request cannot be fulfilled.
```

`storage.save()` works the first time. The second `save()` throws
`InvalidStateError: connection already closed`. The issue reporter
flagged this in the `adbDaemonAuthenticate()` path with
`AdbWebCryptoCredentialManager(new TangoIndexedDbStorage(), name)`,
which is the documented setup for the IndexedDB backend — so the
failure happens before the device is even asked to authorize anything,
on both the USB daemon and the TCP daemon transports.

Two independent bugs in two files, both introduced by the same PR
([`#832`](https://github.com/yume-chan/ya-webadb/pull/832), merged
[`1522b5f`](https://github.com/yume-chan/ya-webadb/commit/1522b5f), via
the follow-up commit [`b6da6b1cfd`](https://github.com/yume-chan/ya-webadb/commit/b6da6b1cfd)
tagged "fix: review comments"). The original PR added reading the
scrcpy server listening address from env; the IndexedDB changes were
incidental drive-by refactors riding along on review feedback.

## Bug #1 — `createTransaction` rejects any Promise return

`libraries/adb-credential-web/src/storage/indexed-db/shared.ts` lines
27-61 are a small wrapper around `IDBTransaction` that resolves with
whatever the callback returned:

```ts
export function createTransaction<T>(
    database: IDBDatabase,
    storeName: string,
    callback: (transaction: IDBTransaction) => T,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        // ...
        try {
            result = callback(transaction);
            if (result instanceof Promise) {
                throw new Error("callback must not be an async function");
            }
        } catch (e) {
            // ...
            try { transaction.abort(); } catch {}
        }
    });
}
```

The intent is reasonable: callback fires synchronously, transaction
auto-commits, we resolve in `oncomplete`. The problem is that
`IDBRequest` is inherently asynchronous — `getAll()`, `get()`, `put()`,
`add()` all return `IDBRequest` whose `.result` isn't available until
the next microtask. The natural way to bridge that is to return
`waitRequest(store.getAll())` from the callback. That `waitRequest`
helper is a `Promise<T>` (defined right above, lines 1-10 of the same
file). And `result instanceof Promise` matches it. Boom.

The `load()` method in `v2.ts` does exactly this:

```ts
const keys = await createTransaction(db, this.#storeName, (tx) => {
    const store = tx.objectStore(this.#storeName);
    return waitRequest(store.getAll() as IDBRequest<TangoKey[]>);
});
```

So `load()` rejects with `Error: callback must not be an async function`
on every call. Then the helper runs `transaction.abort()` to clean up,
which fails the `getAll()` request mid-flight, which produces the
unhandled `AbortError`. Two error events from one bug.

The old version (pre-`b6da6b1cfd`) "adopted" the promise the callback
returned and awaited it inside the `Promise` constructor. That worked
for `IDBRequest` because `waitRequest` is a thenable. The refactor
tried to enforce a stricter contract (sync callback only, resolve in
`oncomplete`) but didn't migrate the call sites.

The fix from the issue reporter is clean:

```ts
transaction.oncomplete = () => {
    resolve(request.result); // every request has settled by oncomplete
};
// callback returns the IDBRequest itself, not a Promise
const request = callback(transaction);
if (request instanceof Promise) throw ...
```

Returning the `IDBRequest` (not a Promise) and resolving in
`oncomplete` with `request.result` works because by the time
`oncomplete` fires, every request started in the transaction has
already completed and `.result` is populated.

## Bug #2 — cached connection closed after every operation

`v2.ts` caches the database connection in a private promise:

```ts
#openDatabasePromise: Promise<IDBDatabase> | undefined;

async #openDatabase() {
    return (this.#openDatabasePromise ??= this.#openDatabaseCore());
}
```

But `save()`, `load()`, and `clear()` each call `db.close()` in a
`finally`:

```ts
async save(privateKey, name) {
    const db = await this.#openDatabase();
    try {
        await createTransaction(db, this.#storeName, (tx) => { ... });
    } finally {
        db.close();   // ← closes the cached connection
    }
}
```

So the *second* operation gets back the same cached connection from
`#openDatabasePromise` — but that connection has been closed by the
first operation's `finally`. IndexedDB throws `InvalidStateError` the
moment you try to start a transaction on a closed `IDBDatabase`. The
"#openDatabasePromise" cache survives the close because nothing resets
it, so every subsequent call also gets the closed handle.

The pre-`b6da6b1cfd` version opened a fresh `IDBDatabase` per
operation. Slow (each `openDatabase` call goes through `onupgradeneeded`
gating on the version number), but correct. The cache was a review
suggestion to amortize that cost. The reviewer missed the `finally`
blocks.

Two reasonable fixes:

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

Option A is the safer default — `IDBDatabase` handles concurrent
connections from the same origin fine, and the close ensures any
underlying IndexedDB worker thread is freed when the consumer goes
idle. Option B is faster for hot loops (key rotation, etc.) but
requires the consumer to manually `close()` the storage instance.

## Why both broke at once

The PR description on `#832` is about scrcpy server env variables. The
IndexedDB changes came in as "review feedback" cleanup on the same
PR — a `git log` on the file confirms only one commit touches it:

```
1522b5f feat(adb/server): support reading server listening address from env (#832)
```

So `b6da6b1cfd` ("fix: review comments") was the only commit that
ever touched `shared.ts` and `v2.ts`. The refactor was bundled in
because the IndexedDB helpers were touched up incidentally during the
scrcpy PR's review cycle. If you have a local fork of
`adb-credential-web` predating this PR, you're unaffected; if you
upgraded past `beta.2`, both bugs are in your tree.

## How to detect this in your own app

Two fingerprints from the issue are enough to triage:

1. **`Error: callback must not be an async function`** from
   `createTransaction` in any IndexedDB credential flow → Bug #1.
2. **`InvalidStateError: connection already closed`** on the second
   `storage.save(...)` call after a successful first save → Bug #2.

If you see both, you're on `beta.3` with the IndexedDB backend, and
your credential storage is permanently broken — `adbDaemonAuthenticate`
fails before the device is asked to authorize.

Three workarounds for downstream apps that need to keep using
`beta.3`:

- **Pin `3.0.0-beta.2`** (`yume-chan/ya-webadb@7ab6729`) until the fix
  ships. `beta.2` doesn't have either bug.
- **Switch backends to `TangoLocalStorage`** (the LocalStorage-backed
  credential store in the same package). It's a one-line change in
  `AdbWebCryptoCredentialManager(new TangoLocalStorage(...), name)`
  and the wire format is identical.
- **Monkey-patch `TangoIndexedDbStorage` in your app bundle** — patch
  `createTransaction` to not throw on Promise returns, and remove
  the `finally { db.close() }` from the three operation methods. We
  did not ship this as a PR; the bug is still open and unfixed at
  the time of writing.

## What this means for webadb.online

webadb.online is not on the affected path. Our credential backend is
`TangoLocalStorage`, not `TangoIndexedDbStorage` — the choice was
made in [`lib/adb-client.ts:89`](https://github.com/webadb-online/webadb.online/blob/main/lib/adb-client.ts)
when we wired up `AdbWebCryptoCredentialManager` against
[`TangoLocalStorage(ADB_KEY_STORAGE_KEY)`](https://tangoadb.dev/classes/_yume-chan_adb-credential-web.TangoLocalStorage.html).
The reason we picked LocalStorage over IndexedDB back then was
operational, not technical: LocalStorage keys are inspectable from
DevTools → Application → Local Storage, which made "why won't my
stored credential work?" support tickets faster to triage. IndexedDB
requires you to open the database, expand the object store, and
page through cursor results — fine for code, hostile for users
self-diagnosing.

We also pin `ya-webadb@3.0.0-beta.1`, not `beta.3`, for unrelated
reasons that we wrote up
[here](https://webadb.online/blog/2026/09/20/ya-webadb-3-0-0-beta-3/)
last week. So neither of these bugs is reachable from our deployed
bundle, and the IndexedDB bug being open upstream does not delay any
shipped feature.

What we *will* be watching for: a fix PR from the upstream maintainer
that closes the issue, and the eventual `3.0.0-beta.4` (or RC) that
will be the version we pin next. The push-completion fix in
[`69fffaf0`](https://github.com/yume-chan/ya-webadb/commit/69fffaf0)
(the headline `beta.3` change for our File Manager upload path) is
genuinely worth the bump, but we won't move until both the IndexedDB
regression is closed *and* we have a few weeks of `beta.3` field time
without further regressions. Two regression-shaped releases in a row
is enough to make us cautious.

If you're maintaining your own ya-webadb fork, the take-aways are:

1. **`createTransaction` needs to accept async callbacks or the
   call sites need to return `IDBRequest` directly.** The issue
   reporter's suggested fix (return request, resolve with
   `request.result` in `oncomplete`) is the cleaner direction.
2. **A cached `IDBDatabase` cannot be closed by the operation that
   opened it** unless you reset the cache. Either don't cache, or
   don't close per-operation.
3. **Drive-by refactors in a release PR are still part of the
   release diff.** The scrcpy-server env-var PR shipped two
   IndexedDB bugs as a side effect because the review feedback was
   bundled into the same commit. The fix-everything-in-one-PR
   instinct is understandable but it makes bisecting downstream
   failures harder than splitting the IndexedDB cleanup into its
   own PR.

The full report, with the exact `libraries/adb-credential-web/src/`
file paths and a suggested fix, is at
[`yume-chan/ya-webadb#870`](https://github.com/yume-chan/ya-webadb/issues/870).
