---
title: ya-webadb v3.0.0-beta.4 ships scrcpy 5.0/5.0.1 aliases and rewrites `bipedal` around `Generator`
date: 2026-10-10 01:00:00
tags:
  - ya-webadb
  - scrcpy
  - release
  - struct
  - bipedal
  - generator
  - deep-dive
---

ya-webadb `v3.0.0-beta.4` was tagged on 2026-10-09 with four commits
on top of `v3.0.0-beta.3`:

- [`d8d1ddc`](https://github.com/yume-chan/ya-webadb/commit/d8d1ddc) —
  `feat(scrcpy): add version 5.0 and 5.0.1 as aliases`
- [`53f3b7a`](https://github.com/yume-chan/ya-webadb/commit/53f3b7a) —
  `fix: use consistent Node.js type names`
- [`991335b`](https://github.com/yume-chan/ya-webadb/commit/991335b) —
  `chore: run prettier --check in CI`
- [`7bcec61`](https://github.com/yume-chan/ya-webadb/commit/7bcec61) —
  `chore: release v3.0.0-beta.4`

It also pulls the two commits that were already sitting on `main` and
un-tagged when we wrote up
[`2026-10-04`](https://webadb.online/blog/2026/10/04/ya-webadb-credential-web-indexeddb-fix-lands-pr-871-and-a-webusb-notfounderror-patch/)
(PR #871's IndexedDB fix and the WebUSB `NotFoundError` handler) into a
coherent beta release. The headline feature is the new
`AdbScrcpyOptions5_0` / `5_0_1` client classes that let consumers talk
to scrcpy server `5.0` and `5.0.1`. The interesting infrastructure work
is the rewrite of `bipedal` in
[`@yume-chan/struct`](https://github.com/yume-chan/ya-webadb/tree/main/libraries/struct),
which switched from a hand-rolled `{ resolved, error }` sentinel
protocol to a normal `iterator.next(value)` / `iterator.throw(error)`
generator protocol.

This post is the read-through: how the new scrcpy aliases plug into
the existing version-permutations architecture, why the maintainer
went for aliases instead of a real `5_0` implementation (and why that's
fine), what `bipedal` actually does under the hood, and what changed
in the rewrite that's worth noticing even if you never call
`bipedal` yourself.

## The new `5_0` / `5_0_1` aliases are version-permutations, not a rewrite

The repo has had one source file per scrcpy server version since
`1.x`. Files like `2_1.ts`, `3_3_3.ts`, `4_0.ts`, `4_1.ts` each declare
a class extending the matching `ScrcpyOptions<X>` type from
`@yume-chan/scrcpy`. The pattern for beta.4 is the same — what changes
is that the "latest" pointer now flips from `4_1` to `5_0_1`:

```ts
// libraries/adb-scrcpy/src/latest.ts (beta.3)
import { AdbScrcpyOptions4_1 } from "./4_1.js";

export class AdbScrcpyOptionsLatest<
    TInit extends AdbScrcpyOptions4_1.Init = AdbScrcpyOptions4_1.Init,
> extends AdbScrcpyOptions4_1<TInit> {
    constructor(init: TInit, clientOptions?: AdbScrcpyClientOptions) {
        super(init, clientOptions);
    }
}

// libraries/adb-scrcpy/src/latest.ts (beta.4)
import { AdbScrcpyOptions5_0_1 } from "./5_0_1.js";

export class AdbScrcpyOptionsLatest<
    TInit extends AdbScrcpyOptions5_0_1.Init = AdbScrcpyOptions5_0_1.Init,
> extends AdbScrcpyOptions5_0_1<TInit> {
    constructor(init: TInit, clientOptions?: AdbScrcpyClientOptions) {
        super(init, clientOptions);
    }
}
```

Two new files appear, both doing exactly the same thing as their `4_1`
counterparts:

```ts
// libraries/scrcpy/src/5_0.ts (new in beta.4)
export { ScrcpyOptions4_1 as ScrcpyOptions5_0 } from "./4_1/index.js";

// libraries/scrcpy/src/5_0_1.ts (new in beta.4)
export { ScrcpyOptions4_1 as ScrcpyOptions5_0_1 } from "./4_1/index.js";
```

That is, **`scrcpy server 5.0` re-exports `ScrcpyOptions4_1` under a
new name.** No new options, no new control messages, no new codec
quirks. The maintainer has decided that scrcpy server `5.0` and `5.0.1`
are wire-compatible with `4.1` for the purposes of the option-shape
the library models (video codec, audio codec, control socket layout,
video metadata orientation). This matches the pattern used for older
jumps where, for example, `3_0_3` re-exported `3_0_1`'s options. The
opt-set of a scrcpy server release tends to change very little
between patch versions, so re-exporting is the right amount of code.

What does differ is the version string the client sends on the wire:

```ts
// libraries/adb-scrcpy/src/5_0_1.ts (new in beta.4)
constructor(init: TInit, clientOptions?: AdbScrcpyClientOptions) {
    super(init);
    this.version = clientOptions?.version ?? "5.0.1";
    this.spawner = clientOptions?.spawner;
}
```

The server uses that string to decide whether it should accept the
connection (newer servers reject older version strings; older servers
reject newer ones in some cases). By default the client says
`"5.0.1"`, but `clientOptions.version` lets you say `"5.0"`,
`"5.0.1"`, or whatever variant you actually deployed.

## Why aliases instead of a real `5_0` implementation

If you've watched the repo over the last year, you might remember
that `4_1` was the first version where a real new file got written
(`feat(scrcpy): support server version 4.0 and 4.1 (#854)`), with
new `ScrcpyOptions4_0` and `ScrcpyOptions4_1` types in `libraries
/scrcpy/src/4_0/` and `4_1/`. The non-alias approach makes sense
when a server version adds a real protocol feature — for example, the
`video` / `audio` codec options that became first-class in `3_0`.

For `5.0` and `5.0.1`, nothing in the option shape the library models
has changed. Reading the upstream scrcpy release notes between `4.x`
and `5.0` confirms this: the changes are bug fixes in the server
binary, not wire-protocol additions. So writing a new `5_0/` directory
that mirrored `4_1/index.ts` line-for-line would have been a copy of
code that would immediately fall behind as soon as `4_1` got bugfixes
ported back. The alias keeps a single source of truth — if the
maintainer adds a new option to `ScrcpyOptions4_1`, both `4_1` and
`5_0` and `5_0_1` get it for free.

## The `bipedal` rewrite is mostly invisible, except where it isn't

The commit that's not in the headline but is by far the largest in the
diff is the rewrite of `libraries/struct/src/bipedal.ts`. `bipedal`
is the helper that turns a "bipedal generator" — a generator that
yields promise values to ask the host to await them — into an
ordinary function that returns a promise. It's used by the
IndexedDB-transaction fix we wrote up two weeks ago: that's how
`waitRequest()` lets a generator `yield store.getAll()` and get
back the resolved value.

The old implementation passed an `Iterator<unknown, T, unknown>` to a
helper called `advance`, which on each iteration inspected the yielded
value, and if it was a promise, attached `.then()` handlers that
**wrapped the resolved value in `{ resolved: value }` and the rejected
value in `{ error }`** before passing it back into the iterator:

```ts
// BEFORE (struct/bipedal.ts on beta.3)
function advance<T>(
    iterator: Iterator<unknown, T, unknown>,
    next: unknown,
): MaybePromiseLike<T> {
    while (true) {
        const { done, value } = iterator.next(next);
        if (done) {
            return value;
        }
        if (isPromiseLike(value)) {
            return value.then(
                (value) => advance(iterator, { resolved: value }),
                (error: unknown) => advance(iterator, { error }),
            );
        }
        next = value;
    }
}
```

The generator helper that yielded the promise had to recognize the
sentinel:

```ts
// BEFORE
function* <U>(
    value: MaybePromiseLike<U>,
): Generator<
    PromiseLike<U>,
    U,
    { resolved: U } | { error: unknown }
> {
    if (isPromiseLike(value)) {
        const result = yield value;
        if ("resolved" in result) {
            return result.resolved;
        } else {
            throw result.error;
        }
    }
    return value;
}
```

The new implementation just hands the resolved value back via
`iterator.next(value)` and the rejected value via
`iterator.throw(error)`, which is the way every other generator
library (Koa, redux-saga, learning Generators) does it:

```ts
// AFTER (struct/bipedal.ts on beta.4)
function advance<T>(
    iterator: Generator<unknown, T, unknown>,
    result: IteratorResult<unknown, T>,
): MaybePromiseLike<T> {
    do {
        if (result.done) {
            return result.value;
        }
        if (isPromiseLike(result.value)) {
            return result.value.then(
                (value) => advance(iterator, iterator.next(value)),
                (error: unknown) =>
                    advance(iterator, iterator.throw(error)),
            );
        }
        result = iterator.next(result.value);
    } while (true);
}
```

The generator helper gets correspondingly simpler:

```ts
// AFTER
function* <U>(value: MaybePromiseLike<U>): Generator<PromiseLike<U>, U, U> {
    if (isPromiseLike(value)) {
        return yield value;
    }
    return value;
}
```

Two things are worth noticing here:

1. **`do { … } while (true)` instead of `while (true) { … }`** —
   the old loop body used `next = value` to re-assign and fall
   through to the next iteration, which meant the next-iteration
   value was set at the bottom of the loop. The new loop takes an
   `IteratorResult` argument (so the recursive calls pass
   `iterator.next(value)` rather than `value`) and has nowhere clean
   to put that bottom-of-loop assignment. `do/while` lets the body
   assign into the loop variable and the conditional sits at the
   bottom instead of the top.

2. **The type signature tightened too**. The old type
   `Iterable<unknown, T, unknown>` for the iterator parameter was
   technically wrong — the third type parameter is the value passed
   *back into* the iterator via `.next()`, and it should match the
   yield type, not `unknown`. The new signature is
   `Generator<unknown, T, unknown>`, which (a) locks in that it's a
   generator and not just an iterable, and (b) lets `iterator.throw`
   type-check without an extra cast.

   The old code had `as never` at the call site (`fn.call(...) as
   never`) because of this looseness. The new code drops it.

If you have a code path that does something exotic with the
sentinel — for example, inspecting `{ resolved, error }` from a
generator you wrote yourself — that will break across the upgrade.
The IndexedDB-related call sites in `@yume-chan/adb-credential-web`
all go through the `then:` helper, not directly through `advance`, so
they keep working without changes. We checked `libraries/` on the
beta.4 tree and no other file imports `advance` or the sentinel
shapes.

## The dep churn is the boring half

The non-source half of the beta.4 diff is a `pnpm-lock.yaml` rewrite
(713 lines, ~ half insertions, ~ half deletions) plus package
metadata bumps across all twenty workspace libraries. The lockfile
diff is dominated by `eslint-config` → `lint` directory rename and
the prettier CI step:

```
toolchain/{eslint-config => lint}/eslint.config.js
toolchain/{eslint-config => lint}/package.json
toolchain/lint/run-lint.js
```

The interesting dep-side change is `991335b` — `chore: run prettier
--check in CI` — which pins the project to a single canonical
formatting. If you're a ya-webadb contributor, expect PRs that fail
CI on a missing semicolon to come back with "run prettier." This is
the maintainer moving from "please remember to format" to "the
formatter is in CI," and `53f3b7a` (`fix: use consistent Node.js
type names`) is the kind of one-line cleanup that prettier would
have caught automatically — a reminder of why this matters.

## What this means for webadb.online

We're still on `ya-webadb@3.0.0-beta.1` in
[`package.json`](https://github.com/webadb/webadb.online/blob/main/package.json),
pending the v3.0.0 stable cut. The beta.4 changes don't change that
plan, but they do firm up three things we were holding our breath on:

1. **WebUSB `NotFoundError` is now in a tagged release.** This is the
   five-line fix from [`a5134b5`](https://github.com/yume-chan/ya-webadb/commit/a5134b59)
   we wrote up on 2026-10-04 — when a USB transfer is interrupted
   by a device unplug, the loop now resolves the promise cleanly
   instead of throwing. Our existing transfer-retry state machine
   already handles an undefined result, but we couldn't tell anyone
   "this is fixed in upstream" until the tag landed.

2. **PR #871 is in a tagged release.** Same story for the IndexedDB
   credential-storage fix. As of beta.4, a fresh `ya-webadb` install
   will not regress on the "credentials don't persist" path that
   bit users in beta.3.

3. **scrcpy 5.0 wire compatibility is library-acknowledged.** Anyone
   running scrcpy server `5.0` or `5.0.1` against our `Screencast`
   panel will hit the version-negotiation handshake cleanly; if we
   want to pin our `latest` to `5_0_1` in a future bump, the option
   shape is identical to `4_1` so the upgrade is a one-line change.

The `bipedal` rewrite doesn't affect us at runtime — none of our
panels call into `@yume-chan/struct` directly — but it is the kind
of cleanup that makes the upstream maintainer likely to cut a stable
`v3.0.0` sooner rather than later, which is the thing we're actually
waiting on to drop the `-beta.1` pin.