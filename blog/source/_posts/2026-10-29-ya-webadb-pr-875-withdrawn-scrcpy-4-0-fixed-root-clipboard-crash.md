---
title: "PR #875 is withdrawn — scrcpy 4.0 already fixed the root-clipboard crash, so ya-webadb is not shipping a `su 2000` shim"
date: 2026-10-29 01:00:00
tags:
  - ya-webadb
  - scrcpy
  - adb-scrcpy
  - clipboard
  - android-security
---

On 2026-10-28 at 00:09 UTC, `colinaaa` closed their own pull request against
`yume-chan/ya-webadb` — [PR #875,
`fix(adb-scrcpy): launch scrcpy as shell under root
adbd`](https://github.com/yume-chan/ya-webadb/pull/875) — without merging it,
and closed the underlying issue
[#874](https://github.com/yume-chan/ya-webadb/issues/874) in the same breath.
The reason, given in both closing comments, is that the bug was fixed upstream
in **scrcpy 4.0** and never needed a library-side workaround at all. This
reverses yesterday's post on this blog, which described #875 as a fix landing
in ya-webadb. It did not land. The library's `main` branch has not changed
since `3a7d781c` and still contains no UID-switching code.

What did land, in the upstream project, is a sixteen-line method in the scrcpy
server that drops root privileges at startup. The interesting part is not the
method — it is the long arc that produced it, and the fact that the
library-level fix was rejected for a reason that has nothing to do with code
quality.

## The upstream fix: `Os.setuid(2000)` in `Server.java`

The scrcpy commit is
[`42632d3f53657238ca653b6f39d4226e9f0a1971`](https://github.com/Genymobile/scrcpy/commit/42632d3f53657238ca653b6f39d4226e9f0a1971),
titled *"Drop root privileges on startup"*, authored 2025-12-29 and committed
the following day. It touches exactly one file,
`server/src/main/java/com/genymobile/scrcpy/Server.java`, +16 lines, no
deletions:

```java
    @SuppressWarnings("deprecation")
    private static void dropRootPrivileges() {
        try {
            if (Os.getuid() == 0) {
                // Copy-paste does not work with root user
                // <https://github.com/Genymobile/scrcpy/issues/6224>
                Os.setuid(2000);
            }
        } catch (Exception e) {
            Ln.w("Cannot set UID", e);
        }
    }
```

and the call site sits in `internalMain`, immediately before the main looper is
prepared and the options are parsed:

```java
        dropRootPrivileges();

        prepareMainLooper();

        Options options = Options.parse(args);
```

That placement matters. The UID drop happens *before* `Options.parse(args)`,
before the encoder is created, before any control socket is opened — so by the
time scrcpy touches `ClipboardService`, its calling UID is already 2000 and the
identity check that was failing now passes.

The `@SuppressWarnings("deprecation")` is not decoration.
[`Os.setuid(int)`](https://developer.android.com/reference/android/system/Os#setuid(int))
was deprecated in API level 29 with the note *"Android Applications do not
have sufficient privileges to call this method."* The deprecation is aimed at
ordinary apps trying to change their own identity; the scrcpy server is
running as root at that moment, which is precisely the case where the call
*does* work, so upstream suppresses the warning rather than shipping a
deprecated call that fails to compile under `-Werror`. The catch block is
what makes the suppression honest: a ROM where the `setuid` is refused logs
`"Cannot set UID"` and the server continues rather than dying. Note that the
`Os.getuid() == 0` guard means the call is never *attempted* on a device where
adbd was not root to begin with — the whole method is a no-op there, and the
catch arm exists for the genuinely awkward case: a device where adbd *is*
root but the `setuid(2000)` is nevertheless refused.

The commit message is terse in the way that upstream scrcpy commits usually
are, and it credits the suggestion to the person who drove the whole thing:

```
Drop root privileges on startup

On rooted devices, switch to user 2000 during startup.

Copy-paste does not work as root (user 0), so switching to 2000 fixes
the issue.

Fixes #6224 <https://github.com/Genymobile/scrcpy/issues/6224>

Suggested-by: Simon Chan <1330321+yume-chan@users.noreply.github.com>
```

`Simon Chan` is `yume-chan` — the ya-webadb maintainer, the author of the
scrcpy.js-adjacent TypeScript port, and the person who spent the five months
between filing the analysis and landing the fix reverse-engineering Samsung's
clipboard stack to get this resolved upstream. "Suggested-by" in a scrcpy
commit is the project maintainer's way of crediting an external contributor
for an idea that landed in upstream code; the commit itself was authored and
committed by Romain Vimont (`rom1v`).

It shipped in **scrcpy v4.0**, released 2026-05-12, whose changelog line reads
exactly:

```
- Fix copy-paste on rooted device (#6224)
```

## The bug, and the arc that produced the fix

The failure is a UID/identity mismatch in `ClipboardService`, and it has been
reported upstream since January 2024 as
[scrcpy issue #4614](https://github.com/Genymobile/scrcpy/issues/4614),
"Unable to copy / paste between device and computer". The reporter was running
a rooted Android 9 device, and the stack trace bottoms out in the Android
framework rather than in scrcpy:

```text
Caused by: java.lang.SecurityException: Calling uid 0 does not own package com.android.shell
        at android.os.Parcel.readException(Parcel.java:1943)
        at android.os.Parcel.readException(Parcel.java:1889)
        at android.content.IClipboard$Stub$Proxy.getPrimaryClip(IClipboard.java:187)
        ... 7 more
Caused by: android.os.RemoteException: Remote stack trace:
        at com.android.server.clipboard.ClipboardService.addActiveOwnerLocked(Unknown Source:57)
        at com.android.server.clipboard.ClipboardService.access$600(Unknown Source:0)
        at com.android.server.clipboard.ClipboardService$ClipboardImpl.getPrimaryClip(Unknown Source:30)
```

Read that carefully: `ClipboardService` requires that the *calling UID* owns
the package identity `com.android.shell`. `com.android.shell` is UID 2000 on
every Android version that matters. When `adbd` runs as root — which is what
`adb root` does, and what a rooted emulator or a `Magisk`-granted root adbd
gives you — the scrcpy server inherits UID 0, and the framework refuses the
call. The copy-paste breaks, and on scrcpy 3.3.1 the `control-recv` thread
*exits*, taking the control stream and the screen stream down with it.

`yume-chan` stated the root cause in September 2025, in one line:

> Google forgot to allow root to access the clipboard without an associated
> app. So Scrcpy must run as system (uid 1000) or shell (uid 2000)
> (ref #1606 and #4127)

There is no framework permission to grant. Root is UID 0, and UID 0 owns no
package. The only correct answer is to *not be root* by the time the
clipboard is touched.

### Why it took so long: Samsung's SEM clipboard

The reason this was hard is that scrcpy's clipboard access on Samsung devices
does not go through a plain `Context.getSystemService(CLIPBOARD_SERVICE)`.
Samsung's One UI layers a vendor clipboard service on top, and the call chain
reaches into a package that scrcpy has no identity for. From
[scrcpy issue #6224](https://github.com/Genymobile/scrcpy/issues/6224) — the
issue that the merged commit closes — the trace on a Samsung S10 / S9 running
Android 11 goes somewhere completely unexpected:

```text
        at com.samsung.android.emergencymode.SemEmergencyManager.getModeType(SemEmergencyManager.java:343)
        at com.samsung.android.content.clipboard.SemClipboardManager.isUPSMode(SemClipboardManager.java:1641)
        at com.samsung.android.content.clipboard.SemClipboardManager.isEnabled(SemClipboardManager.java:1039)
        at android.content.ClipboardManager.setPrimaryClip(ClipboardManager.java:132)
        at com.genymobile.scrcpy.wrappers.ClipboardManager.setText(ClipboardManager.java:36)
        at com.genymobile.scrcpy.device.Device.setClipboardText(Device.java:128)
```

Samsung's `SemEmergencyManager` — emergency mode, UPS mode — is consulted
*inside* `setPrimaryClip`, and it calls `context.createPackageContext("android", 2)`
to get a context whose package name is `android`. That derived context is not
scrcpy's `FakeContext`, so the UID ownership check inside
`ClipboardService.addActiveOwnerLocked` sees the `android` package and the
caller's UID 2000 and throws *"Given calling package android does not match
caller's uid 2000"*. The same report shows the regression introduced by
scrcpy commit
[`8a02e3c2f58cffc3fdd8c08b26aae04bbf9d5a97`](https://github.com/Genymobile/scrcpy/commit/8a02e3c2f58cffc3fdd8c08b26aae04bbf9d5a97),
which moved clipboard access onto the SDK `ClipboardManager` (previously
scrcpy 3.2 worked fine on the same devices).

`yume-chan` proposed a series of progressively deeper patches to scrcpy's
`FakeContext` — first patching the `mContext` field of the `ClipboardManager`
service, then noticing that `SemEmergencyManager`'s `createPackageContext` call
bypasses `FakeContext` entirely, then trying the radical version where the
patching happens on `Workarounds.getSystemContext()` rather than on a
`ContextWrapper`:

> Tried this idea.
> <https://github.com/Genymobile/scrcpy/compare/dev...yume-chan:feat/patch-system-context?expand=1>
>
> Most things work, but `getContentResolver` can't be patched (especially for
> derived contexts created by `createXXXContext()`), causing
> `java.lang.SecurityException: Unable to find app for caller ... when getting
> content provider settings`

Every one of those approaches is a fight with a vendor framework's private
field layout. In December 2025, `yume-chan` proposed the boring solution
instead — drop privileges — and `rom1v` (the scrcpy maintainer) replied
"Yes, that might be a solution :+1:", tested
`81b90bf58bd4f0a297f9c50ab7b35b5fdcbc9c98` with a prebuilt server binary, and
merged `42632d3f` a day later.

The chronology matters for understanding what the *library-side* patch was
actually up against. By the time PR #875 was opened on 2026-10-26, the
upstream fix had been in scrcpy for **ten months**, and the maintainer of
ya-webadb knew it — his review comment on 2026-10-27 pointed at it directly:

> The upstream issue has been fixed in 4.0:
> https://github.com/Genymobile/scrcpy/issues/6224#issuecomment-3694901268

## Why the library patch was rejected

The withdrawn PR was not rejected for being wrong. It was rejected for being
*unnecessary* and for changing a default that some users depend on.

The proposal was to rewrite the default launcher in
[`libraries/adb-scrcpy/src/client.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/adb-scrcpy/src/client.ts),
replacing the plain argv spawn with a device-side shell snippet:

```ts
            if (options.spawner) {
                process = await options.spawner(args);
            } else {
                // ClipboardService checks that the caller owns com.android.shell (UID 2000).
                const command = escapeArg(
                    [
                        `CLASSPATH=${escapeArg(path)}`,
                        ...args.slice(1).map(escapeArg),
                    ].join(" "),
                );
                process = await adb.subprocess.noneProtocol.spawn(
                    `if [ "$(id -u)" = 0 ]; then exec su 2000 sh -c ${command}; else exec sh -c ${command}; fi`,
                );
            }
```

That is a well-built patch. The `escapeArg` nesting is the interesting part:
the classpath and each server argument are escaped once for the inner `sh -c`,
and the resulting command string is escaped again for the outer shell — a
double-layer quoting scheme that the PR's own regression tests exercise against
paths and options containing spaces, quotes, command substitution, and
semicolons, asserting that the embedded commands do not execute. CodeRabbit
flagged the first version of this as an escaping bug and the author fixed it;
the bot approved the second. There was also a 209-line test file with a
fixture that fakes `id`, `su`, and `app_process` on `PATH` to assert the
UID-switch behaviour without a device.

None of that is why it was dropped. The maintainer's objection was about
*semantics*, in two parts.

**First, `su` compatibility cannot be assumed.** The comment:

> Does it work on real rooted device? (maybe yes because you used
> `su 2000 sh -c`?) https://github.com/Genymobile/scrcpy/pull/4127#issuecomment-1615943436

`su` is not a standard Android binary. On a Magisk-patched device it is
Magisk's `su`; on a KernelSU device it is KernelSU's; on a rooted emulator
image it may be a BusyBox `su` with different argument handling; on some
OEM-locked builds there is no `su` at all even though `adbd` runs as root.
`su 2000` — passing a *numeric UID* rather than the username `shell` — is
also not universally supported: toybox `su` and Magisk's `su` accept it,
several older `su` implementations accept only names. A default path that
depends on `su` behaving a specific way is a default path that can break on
devices the library currently supports.

**Second, running as root is a feature for some users.** The maintainer's
issue-level comment:

> If the `su` command works on all root devices, I will accept this
> workaround. However, some people might actually want to run Scrcpy as
> root/system to get secure displays on Android 12+, so this should be an
> opt-in feature.

That is the crux, and it is a real platform constraint rather than a
preference. `FLAG_SECURE` surfaces — the ones that exclude their content from
screenshots and screen recording — can only be created by a process running as
`AID_GRAPHICS` (UID 1000) or `AID_SYSTEM`. Since Android 12,
`createSecureDisplay` from a shell-UID process is refused outright; the
upstream scrcpy v1.18 release notes recorded the restriction at the time:

> Since Android 12, creating a secure display with shell permissions is not
> permitted anymore (#2129). As a consequence, protected content may not be
> mirrored on Android 12.

The workaround scrcpy shipped at the time was to *not* create a secure
display — mirroring everything, including protected content — which is a
security regression the user may not want. Users who deliberately run
`adb root` before launching scrcpy do it to get those secure displays, and
the alternative of launching as UID 1000 is exactly what the upstream
[scrcpy PR #4127](https://github.com/Genymobile/scrcpy/pull/4127) ("Introduce
`--root` option for (rooted) secure display support on Android 12+") proposes
as an opt-in flag. A library default that silently drops privileges would
remove a capability that currently works, in exchange for fixing a clipboard
bug that the upstream server already fixed on its own.

**The resolution: the escape hatch that was already there.** The maintainer
pointed at it in an inline review comment:

> `options.spawner` is the escape hatch for these situations (I used this to
> launch Scrcpy as uid 1000 on Android 10).

`AdbNoneProtocolSpawner` is
`(command: string | readonly string[], signal?: AbortSignal) => Promise<AdbNoneProtocolProcess>`
([`libraries/adb/src/service/subprocess/none/spawner.ts`](https://github.com/yume-chan/ya-webadb/blob/main/libraries/adb/src/service/subprocess/none/spawner.ts)),
and `AdbScrcpyClient.start` checks it before falling back to the default:

```ts
            if (options.spawner) {
                process = await options.spawner(args);
            } else {
                process = await adb.subprocess.noneProtocol.spawn(args);
            }
```

A caller who needs UID-specific behaviour supplies a spawner; the library
does not guess on their behalf. The closing comments confirm that is exactly
what the PR author did:

> Thanks @yume-chan for the thoughtful feedback and for explaining the
> root/system use cases. I agree that changing the default UID could break
> callers that need those privileges, and that `su` compatibility should not
> be assumed across rooted devices. The existing `options.spawner` is a good
> fit for our environment-specific workaround; we've moved it into our
> application and verified it on our affected Android 10 setup.

So the workaround still exists — it just moved from the library's default
launcher into the application that needed it, which is the correct place for
an environment-specific hack. Nothing ships in ya-webadb. The library's
`main` branch still has exactly one commit since 2026-10-09, and the
`AdbScrcpyClient` default launcher is still the two-line `spawn(args)` above.

## What actually ships: the fix is in the server, not the library

The important structural point for anyone consuming ya-webadb is that this
class of bug is fixed **on the device side**, in the scrcpy server binary, and
ya-webadb already ships the options classes that select the fixed server.

ya-webadb's `@yume-chan/scrcpy` package has a directory per server version,
and `libraries/adb-scrcpy/src/` mirrors it:

| Server version | Options class | File | `options.version` default |
|---|---|---|---|
| 3.3.3 | `AdbScrcpyOptions3_3_3` | `libraries/adb-scrcpy/src/3_3_3.ts` | `"3.3.3"` |
| 3.3.4 | `AdbScrcpyOptions3_3_4` | `libraries/adb-scrcpy/src/3_3_4.ts` | `"3.3.4"` |
| 4.0 | `AdbScrcpyOptions4_0` | `libraries/adb-scrcpy/src/4_0.ts` | `"4.0"` |
| 4.1 | `AdbScrcpyOptions4_1` | `libraries/adb-scrcpy/src/4_1.ts` | `"4.1"` |
| 5.0 | `AdbScrcpyOptions5_0` | `libraries/adb-scrcpy/src/5_0.ts` | `"5.0"` |
| 5.0.1 | `AdbScrcpyOptions5_0_1` | `libraries/adb-scrcpy/src/5_0_1.ts` | `"5.0.1"` |

Each one carries the server version string it will send to `app_process`:

```ts
export class AdbScrcpyOptions4_0<
    TInit extends ScrcpyOptions4_0.Init = ScrcpyOptions4_0.Init,
> extends ScrcpyOptions4_0<TInit> implements AdbScrcpyOptions<...> {
    readonly version: string;
    readonly spawner: AdbNoneProtocolSpawner | undefined;

    constructor(init: TInit, clientOptions?: AdbScrcpyClientOptions) {
        super(init);
        this.version = clientOptions?.version ?? "4.0";
        this.spawner = clientOptions?.spawner;
    }
```

and `libraries/scrcpy/src/latest.ts` points at 4.1:

```ts
export { ScrcpyOptions4_1 as ScrcpyOptionsLatest } from "./4_1/index.js";
```

The version string is how the client tells the server which build it is
talking to, and the scrcpy server binary is what contains
`dropRootPrivileges()`. So the version selection *is* the fix selection:
`AdbScrcpyOptions4_0` and later transparently get the UID drop, because the
server binary does it, not the TypeScript. `AdbScrcpyOptions3_3_3` — the
version used in the original bug report — does not, because that server
predates the fix.

This is worth stating plainly because the natural assumption runs the other
way. A reader might expect the clipboard fix to be a JavaScript-side concern,
something the library could toggle. It is not. The library cannot drop the
server's UID after the fact; it can only choose which server binary to run.
The browser-side code has no `Os.setuid` to call.

## The version string is a contract, not a label

There is a subtlety worth stating: the server version is a *string in the
options object*, and the library does not validate it against the server
binary that was actually pushed to the device.

`AdbScrcpyClient.pushServer` writes whatever bytes it is handed to
`DefaultServerPath`:

```ts
    static async pushServer(
        adb: Adb,
        file: ReadableStream<MaybeConsumable<Uint8Array>>,
        path = DefaultServerPath,
    ) {
        await adb.sync.write({ path, readable: file });
    }
```

and `start` builds the argv from `options.version`:

```ts
            const args = [
                // Use `CLASSPATH=` as `-cp` argument requires Android 8.0
                `CLASSPATH=${path}`,
                "app_process",
                /* unused */ "/",
                "com.genymobile.scrcpy.Server",
                options.version,
                ...options.serialize(),
            ];
```

So a mismatch between the pushed binary and the declared version is possible
in principle, but it is caught immediately and loudly: the server compares the
client-supplied version string against its own compiled-in `VERSION_NAME` and
throws on the first line of `Options.parse`:

```java
    public static Options parse(String... args) {
        if (args.length < 1) {
            throw new IllegalArgumentException("Missing client version");
        }

        String clientVersion = args[0];
        if (!clientVersion.equals(BuildConfig.VERSION_NAME)) {
            throw new IllegalArgumentException(
                    "The server version (" + BuildConfig.VERSION_NAME + ") does not match the client " + "(" + clientVersion + ")");
        }
```

The failure surfaces in the library as an `AdbScrcpyExitedError` carrying the
server's log lines, because `Options.parse` runs inside the spawned process and
the thrown exception kills it before the streams are consumed:

```ts
            const streams = await Promise.race([
                process.exited.then(() => {
                    throw new AdbScrcpyExitedError(lines);
                }),
                connection.getStreams(),
            ]);
```

The practical consequence is that the *declared* version string is a
load-bearing part of the protocol contract, not a cosmetic label. The
`@yume-chan/fetch-scrcpy-server` package exists to make keeping the two in
sync a non-issue by generating a version-pinned module per server release,
so that `options.version` and the pushed binary cannot drift apart by
accident.

## What this means for webadb.online

Direct impact on webadb.online today: none, and that is by design rather than
by luck.

webadb.online's screencast panel does **not** use `AdbScrcpyClient`. It
implements its own capture path in `lib/screencast/pipeline.ts` — a
file-based polling pipeline built on `adb shell screenrecord` writing to
`/sdcard/webadb-stream.mp4`, with the device's own `ftyp`/`moov` used as the
init segment and an incremental `readSince(offset)` tail, because stock AOSP
`screenrecord` has no stdout mode and the OEM ROMs we target strip the
Pixel-only `--output-format=h264` extension entirely. That pipeline never
spawns the scrcpy server, so the root-UID clipboard bug cannot reach it: it
has no clipboard bridge at all. It mirrors pixels and injects touch and key
events; it does not read or write the device clipboard.

The clipboard panel in webadb.online is a separate mechanism again — it
uses `adb shell cmd clipboard` and `navigator.clipboard`, not the scrcpy
control socket. On the OEM-restricted ROMs we care about, `cmd clipboard` is
often stripped entirely, and the panel's job is to say so plainly rather than
pretend. The scrcpy control socket's clipboard path — the one that crashed on
rooted devices — is a third mechanism that webadb.online does not expose.

What this episode *is* useful for, beyond the upstream history, is as a
worked example of the architecture we are deliberately not adopting. The
library-side fix was rejected not because it was badly written — it was
well written, with device-free regression tests and a fixture that fakes
`id`/`su`/`app_process` — but because it guessed at device state that only
the caller knows. The correct shape turned out to be: fix it where the
privilege is held (the server binary), keep the escape hatch (the custom
spawner) for the cases where the caller needs to override, and do not change
a default that some users depend on.

If webadb.online ever grows a scrcpy-server-based panel — which would be the
natural way to get a real control channel and clipboard bridging that the
`screenrecord` pipeline cannot provide — the rules for that panel are now
written: use `AdbScrcpyOptions4_1` or later so the server drops root
privileges on its own, and expose a spawner override for users who
deliberately want root or system UID for secure displays on Android 12+.

One closing note on the release cadence, since it affects when this fix
reaches people: the upstream commit landed 2025-12-29 and shipped in scrcpy
v4.0 on 2026-05-12 — a four-and-a-half month gap between merge and release.
The library-side workaround that existed in parallel for those four months was
solving a problem that had already been solved upstream, in a binary that
users would only pick up once 4.0 was published. That is the kind of lag
worth remembering before opening a library-side PR for something that a
dependency might already have fixed.
