---
title: "ya-webadb PR #875 runs the scrcpy server as shell under root adbd"
date: 2026-10-27 01:00:00
tags:
  - ya-webadb
  - adb-scrcpy
  - scrcpy
  - clipboard
  - shell-injection
---

A two-commit pull request against `yume-chan/ya-webadb` opens today fixes a
class of scrcpy-in-the-browser failure that has been open upstream since
January 2024: when `adbd` runs as root, the scrcpy server inherits UID 0, and
every clipboard operation dies with `SecurityException: Calling uid 0 does not
own package com.android.shell`. The fix drops the server to UID 2000
(`com.android.shell`) inside the device-side launch command itself, and the
second commit of the two exists because the first one had a command-injection
hole in it.

The interesting part is not that the bug was found. It is *where* the fix
lives: inside the shell string that runs on the device, with no extra ADB
round trip, and with a quoting discipline that a browser-based ADB client has
to get exactly right.

## The bug: UID 0 does not own com.android.shell

The reproduction is documented in
[yume-chan/ya-webadb#874](https://github.com/yume-chan/ya-webadb/issues/874),
opened 2026-10-26T14:50:48Z by `colinaaa`:

```text
java.lang.SecurityException: Calling uid 0 does not own package com.android.shell
    at android.content.IClipboard$Stub$Proxy.getPrimaryClip(IClipboard.java:333)
    at android.content.ClipboardManager.getPrimaryClip(ClipboardManager.java:135)
    at com.genymobile.scrcpy.wrappers.ClipboardManager.getText(ClipboardManager.java:27)
    at com.genymobile.scrcpy.device.Device.setClipboardText(Device.java:119)
    at com.genymobile.scrcpy.control.Controller.setClipboard(Controller.java:595)
```

The device is an Android 10 emulator with `adb root` already applied, so
`adb shell id -u` returns `0`. The reproduction path is the ordinary one:

```ts
const client = await AdbScrcpyClient.start(
    adb,
    DefaultServerPath,
    new AdbScrcpyOptions3_3_3({ audio: false, control: true }),
);
await client.controller.setClipboard({
    sequence: 0n,
    paste: true,
    content: "hello 中文🙂",
});
```

The stack trace is worth reading closely, because it explains *why* the fix is
a UID change and not a permission change. `ClipboardService` on the device
side checks that the calling UID owns the package identity
`com.android.shell`. On a normal device `adbd` runs as UID 2000 and the
scrcpy server inherits that UID, so the check passes. On a rooted device
`adbd` runs as UID 0, the server inherits UID 0, and UID 0 does not own
`com.android.shell` — so the call is rejected. The `control-recv` thread dies
on the exception and screen streaming stops with it.

This is not a webadb-specific problem. It is
[Genymobile/scrcpy#4614](https://github.com/Genymobile/scrcpy/issues/4614),
opened 2024-01-25 by `2011` on a rooted AOSP 9 device with scrcpy 2.1.1, and
it has been open, essentially unchanged, for **two years and nine months**. The
upstream maintainer's answer on that thread was the same workaround the
issue author had already found unpleasant:

> I have no good solution for this clipboard issue with rooted devices.

followed by `adb unroot` — which, as the issue author immediately points out,
makes the device disappear from the ADB server and requires a reboot to
recover. A later comment from `lordofscripts` on 2025-12-26 reports the same
symptom on scrcpy 3.3.3 on a *non-rooted* device, which suggests the class of
bug is not exclusively root-related even if the root case is the reproducible
one.

So: two years of an open upstream issue, and a browser-side ADB library
solving it in two commits.

## The fix, in eleven lines

The whole implementation is in
`libraries/adb-scrcpy/src/client.ts`, and it is eleven lines replacing six.
Before the change, `AdbScrcpyClient.start()` launched the server with a
plain argv array:

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

if (options.spawner) {
    process = await options.spawner(args);
} else {
    process = await adb.subprocess.noneProtocol.spawn(args);
}
```

After the change (`d658978d0394049478b2a1d94af4fa2578674c7f`,
2026-10-26T14:52:18Z):

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

Four properties of this diff are worth pulling apart, because each one is a
design decision rather than an implementation detail.

**The UID probe happens on the device, inside the command.** The obvious
alternative is to ask the host what UID `adbd` is running as — one extra
`adb shell id -u` round trip before the server launches — and then branch in
JavaScript. The author explicitly rejected that, and the test suite asserts
it:

```ts
assert.equal(
    device.spawn.mock.callCount(),
    1,
    "UID selection must not add an ADB round trip",
);
```

The reasoning is sound. `adb shell id -u` is a full ADB command execution:
a `none:` protocol request, a subprocess spawn on the device, a round trip
over WebUSB, and a `shell:` framing. Adding it to *every* scrcpy session
startup — including on the overwhelmingly common non-rooted path where it
would tell you something you already know — is a real latency cost for zero
information. Evaluating `$(id -u)` inside the device-side command string
costs one `fork`/`exec` of `id` on a device that is about to run `app_process`
anyway. The information is gathered exactly where it is needed, at the point
of use, for free.

**The `su` switch is explicit, and the failure mode is fail-closed.** The
command is:

```sh
if [ "$(id -u)" = 0 ]; then exec su 2000 sh -c '<command>'; else exec sh -c '<command>'; fi
```

`exec` replaces the current shell rather than forking, so there is no extra
process left to reap and the exit status of the server propagates directly.
And if `su 2000` fails — a ROM without `su`, an emulator image where `su`
requires a different invocation, a `su` that refuses the UID — the error
propagates out as a startup failure. It does *not* fall back to running as
root. The test asserts this explicitly:

```ts
await assert.rejects(device.start(), (error) => {
    assert.equal((error as { status?: number }).status, 23);
    return true;
});
assert.equal(
    device.spawn.mock.callCount(),
    1,
    "A failed UID switch must not retry as root",
);
```

Falling back to root on a failed `su` would be the wrong default. Root is
precisely the identity that triggers the clipboard failure in the first
place; a silent fallback would turn a clean, diagnosable startup error into
a session that starts and then mysteriously loses its control stream.

**Custom spawners are left completely alone.** If the caller supplies
`options.spawner`, it receives the *original* `args` array, unmodified —
no UID probe, no quoting, no wrapping. The test asserts both halves of that:
the custom spawner is called with the plain argv array, and the underlying
`adb.subprocess.noneProtocol.spawn` is never called at all
(`device.spawn.mock.callCount() === 0`). This matters because a custom
spawner is exactly the escape hatch a user reaches for when the default
launcher does not fit their device — a rooted setup that wants the server to
stay root, a Magisk-specific `su` invocation, a device with a non-standard
`app_process` path. The default path changes; the escape hatch does not.

**`su 2000`, not `su shell`.** The second argument to `su` is the numeric
UID. `com.android.shell` is UID 2000 on every Android version that matters
here, and passing the number avoids depending on a username that may or may
not not resolve on a given ROM.

## The second commit exists because the first one was wrong

The PR has two commits, and the gap between them is the most instructive
part of the whole thing:

```text
d658978d039  2026-10-26T14:52:18Z  fix(adb-scrcpy): launch scrcpy as shell under root adbd
f6cf7fe9dc  2026-10-26T15:22:47Z  fix(adb-scrcpy): escape inner shell arguments
```

The second commit was authored **thirty minutes** after the first, in
response to a CodeRabbit review comment. And CodeRabbit was right.

Here is the shape of the first commit's command construction. The inner
command is built by joining escaped arguments, and then the *result* is
escaped again for the outer `sh -c`:

```ts
const command = escapeArg(
    [
        `CLASSPATH=${escapeArg(path)}`,
        ...args.slice(1).map(escapeArg),
    ].join(" "),
);
```

Look at the first element: `CLASSPATH=${escapeArg(path)}`. The `escapeArg`
call wraps `path` in single quotes, and then the whole `CLASSPATH=...` string
is escaped *again* as part of the outer command. The outer escape turns the
inner single quotes into literal characters inside a single-quoted string.
The result is that the device shell sees a `CLASSPATH` whose value contains
literal quote characters rather than the path itself.

The CodeRabbit review summary names the concern precisely:

> CodeRabbit caught a subtle shell-injection risk: escape each inner server
> argument before quoting the outer command, while preserving
> `CLASSPATH=` semantics.

The fix in `f6cf7fe9dc` was to escape the value *inside* the `CLASSPATH=`
assignment, and each remaining argument, and then quote the joined inner
command — the shape shown above. In other words, the first commit had the
quoting order backwards for one of the seven elements, and the second commit
moved it.

This is not a nitpick. `CLASSPATH=` is an environment-variable assignment,
not a command word, and it has to be handled by a different rule than the
arguments that follow it: `CLASSPATH=/path` sets a variable, but
`CLASSPATH='/path'` sets a variable *whose value includes the quote
characters*. When you are building a nested-quoting command, the
environment-assignment position and the argument position need different
treatment, and getting them backwards produces a value that is subtly wrong
rather than loudly broken.

The author also added real-shell regression tests rather than mock-level
assertions. The test fixture writes actual `id`, `su`, and `app_process`
executables to a temp directory and puts that directory first on `PATH`:

```ts
await writeFile(
    join(directory, "id"),
    `#!/bin/sh\nprintf '%s\\n' '${uid}'\n`,
    { mode: 0o755 },
);
await writeFile(
    join(directory, "su"),
    '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$SCRCPY_TEST_SU_LOG"\nshift\nexec "$@"\n',
    { mode: 0o755 },
);
await writeFile(
    join(directory, "app_process"),
    '#!/bin/sh\nprintf \'%s\\n\' "$CLASSPATH" "$@"\n',
    { mode: 0o755 },
);
```

The `su` stub records the UID it was asked to switch to and then `exec`s the
rest of its arguments, so the test can assert that the server really was
launched as UID 2000 and that the `CLASSPATH` the server sees is the path,
not a quoted path. The spawn mock runs the command through a real `sh -c`
with that `PATH`:

```ts
const spawn = t.mock.fn((command: string | readonly string[]) => {
    output = execFileSync(
        "sh",
        ["-c", typeof command === "string" ? command : command.join(" ")],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${directory}:${process.env["PATH"]}`,
                SCRCPY_TEST_SU_LOG: suLog,
            },
        },
    );
    return Promise.resolve(serverProcess);
});
```

And then the adversarial case, which is the one that matters:

```ts
const marker = join(device.directory, "injected");
const special = `space 'quoted' "$(touch ${marker})"; value`;
const path = `/data/local/tmp/${special}.jar`;
const client = await device.start(undefined, path, {
    videoEncoder: special,
});
```

A path containing a space, single quotes, double quotes, a command
substitution that would `touch` a marker file, and a semicolon. The test
asserts the marker file was *not* created:

```ts
await assert.rejects(access(marker), { code: "ENOENT" });
```

and that the server received the special string as one literal argument:

```ts
assert.deepEqual(device.output().trimEnd().split("\n"), [
    path,
    "/",
    "com.genymobile.scrcpy.Server",
    client.options.version,
    ...client.options.serialize(),
]);
```

That last assertion is the interesting one: the fake `app_process` prints
`"$CLASSPATH"` and `"$@"` one per line, so the test is checking the exact
bytes that arrive at the server process. If the quoting is wrong in any way —
an extra quote character, a lost space, a `$(...)` that got expanded — the
split lines will not match and the test fails.

The PR description states the coverage honestly:

> The two new quoting cases fail before the fix and pass afterward; embedded
> commands do not execute.

"Fail before the fix" is the load-bearing phrase. The author ran the new
tests against the first commit and watched them fail, which is how the
injection was discovered rather than merely asserted away.

## Why this matters more than a clipboard bug

Two observations, one about the library and one about the ecosystem.

**First, this is the general shape of browser-based ADB.** Everything a
browser ADB client does on the device side eventually becomes a string
executed by a shell it does not control. ya-webadb's `none:` and `shell:`
protocols both end up as `sh -c ...` on the Android side — they differ only
in how stdin/stdout are framed on the wire, not in their execution model. The
library's own `escapeArg()` helper
(`libraries/adb/src/service/subprocess/utils.ts`) has been the answer to
this since PR #786 landed in August 2025:

```ts
export function escapeArg(s: string) {
    let result = "";
    result += `'`;

    let base = 0;
    while (true) {
        const found = s.indexOf(`'`, base);
        if (found === -1) {
            result += s.substring(base);
            break;
        }
        result += s.substring(base, found);
        // a'b becomes 'a'\''b', which is 'a' + \' + 'b'
        // (quoted string 'a', escaped single quote, and quoted string 'b')
        result += String.raw`'\''`;
        base = found + 1;
    }

    result += `'`;
    return result;
}
```

Single-quote wrapping, with embedded single quotes emitted as `'\''`. That
is correct POSIX single-quote escaping and it is inert against every
metacharacter — `$`, backtick, `;`, `|`, `&`, `(`, `)`, `<`, `>`, newline.
What the PR's second commit demonstrates is that *correctly applying* it is
harder than it looks, because the command being built is nested: the inner
command's arguments must be escaped once for the inner `sh -c`, and then the
*joined* inner command must be escaped again for the outer `sh -c`. Two
layers, two different rules, and the environment-assignment slot at the
front does not follow the same rule as the arguments.

**Second, the fix is not yet merged.** As of 2026-10-27T01:00Z, PR
[yume-chan/ya-webadb#875](https://github.com/yume-chan/ya-webadb/pull/875)
is open, `mergeable_state: clean`, head `f6cf7fe9dcc13bdd54805ab66eb655e9690b6fb7`,
base `main`, with a `patch` changeset queued for `@yume-chan/adb-scrcpy`. The
`main` branch has not moved since `7bcec613` (2026-10-09T08:02:12Z, the
v3.0.0-beta.4 release), so this is not in any published version yet. The
device-side validation in the PR description is on an Android 10 emulator
with root adbd and scrcpy server 3.3.3, through a local HTTPS/HTTP2 Preview
in Chrome 155 — consecutive Ctrl+V pastes of ASCII, Chinese/emoji, and a URL
matched the native text field exactly, with the control stream and video
stream both staying alive and `ps` confirming scrcpy was UID 2000 while
`adbd` stayed root. The author is explicit about the limits:

> This has not been device-tested on other Android versions or `su`
> implementations.

That caveat matters more than usual for a fix whose central mechanism is
`su`, because `su` is the least standardised program in the Android
ecosystem. Magisk's `su`, the emulator image's `su`, SuperSU, and a
vendor-blessed root solution all accept different argument shapes and
enforce different policies. `su 2000` is the most conventional form of the
invocation and the most likely to work, but "most likely" is doing real work
in that sentence.

## What this means for webadb.online

No code change to webadb, and no change to the webadb screencast panel.

webadb's screencast implementation does not use `@yume-chan/adb-scrcpy` at
all. It talks to `adb shell screenrecord` and polls the resulting file
(`lib/screencast/`), because `screenrecord` is a different mechanism with a
different set of OEM problems — the panel has no scrcpy server to launch as
root, no `ClipboardService` to talk to, and no `su` to negotiate. The
relevant dependency set in webadb's `package.json` is
`@yume-chan/adb`, `@yume-chan/adb-credential-web`,
`@yume-chan/adb-daemon-webusb`, and `@yume-chan/stream-extra` — the
`adb-scrcpy` package is not among them, and
`grep -rn "AdbScrcpy" lib/ components/` returns nothing.

Two things are worth keeping, though.

The first is that this PR is a live demonstration of the argument-escaping
problem that webadb's own device-side command layer has to solve. webadb
runs arbitrary shell commands on the device — `pm list packages -f`,
`dumpsys package`, `am start -n`, `stat`, `tail -c +N` for the screencast
poller — and the paths it operates on (a package name, a filename chosen by
the user in the File Manager) are not guaranteed to be free of spaces or
shell metacharacters. When PR #875 merges, the right response is not to
copy the UID-switch logic but to re-read the escaping discipline it
implements, and to check whether our own command construction quotes its
arguments at all. A browser ADB client is exactly the context where a
`$(...)` in a filename becomes a shell injection on the user's own device —
low severity, but the class of bug is worth auditing for rather than
inheriting by accident.

The second is the workflow lesson, which is more general than this bug. A
two-year-old upstream issue with no maintainer fix was closed in a
browser-based library in the same afternoon it was properly reported, with a
minimal patch, a real-device validation, and a regression suite that
specifically tries to break the fix. The upstream issue
[Genymobile/scrcpy#4614](https://github.com/Genymobile/scrcpy/issues/4614)
remains open. Nothing about the fix required anything that was not already
available to a scrcpy maintainer — the constraint was that scrcpy's own
launch path is a native binary with a different set of options, while the
library's launcher is a string it fully controls, which makes
"check the UID and re-exec" a two-line device-side change rather than a
native-binary feature.

That is the shape of the webadb project in general: the browser gives you
control over the *launch command* in a way that a native client never
does, and that control is worth more than it looks when something on the
device needs to be run as a specific user.
