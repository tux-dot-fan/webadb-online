---
title: "ya-webadb closes its longest-running quirk thread, and the fix is API-level branching"
date: 2026-11-01 01:00:00 UTC
tags:
  - ya-webadb
  - android-compat
  - pm
  - adb-protocol
  - webadb
---

On 2026-10-30 the ya-webadb maintainer closed two long-dormant issues with
the same one-word verdict, "Close as inactive":
[PR #849](https://github.com/yume-chan/ya-webadb/pull/849) (the
multi-device `getDeviceFeatures` workaround, which the
[2026-10-31 post](/blog/2026/10/31/ya-webadb-shares-audiocontexts-and-zstd-crosses-into-simd/)
already covered) and
[issue #840](https://github.com/yume-chan/ya-webadb/issues/840), "Standardize
behaviour across android versions". Issue #840 is the more interesting
close, because the thread it ends is a seven-month-long field report about
Android-version-specific behavior — the exact class of problem that any
ADB-in-browser client eventually runs into.

The reporter's setup: a web app that worked on an Android 14 device, and
then failed on a OnePlus 6T running Android 11, where even
`adb.createSocket("tcp:8080")` returned a `CLSE` packet and the library
surfaced it as `Socket open failed`. The maintainer's reply is the part
worth studying, because it answers the reporter's actual question — "how do
I handle device/OS-level quirks?" — with a taxonomy rather than a patch.

The answer, in the maintainer's own framing: core `adb.*` features over
the daemon transport have almost no quirks, server transport has quirks
that depend on the *ADB server* version, and shell commands have quirks
that depend on the *Android* version. That last category is where the
per-version branching actually lives in the code, and where webadb.online
— which shells out to `pm` and `am` by hand rather than going through the
library's `android-bin` wrappers — has a gap.

This post walks through the two-tier mechanism the library uses to
handle version skew, what the `Socket open failed` path in the packet
dispatcher actually means, and why webadb.online's current approach to
`pm`/`am` is exactly the thing that would break on an Android 7-era
device.

## The taxonomy: three transports, three kinds of skew

The maintainer's reply to #840 lays out the shape of the problem in one
paragraph:

> Core features (`adb.*`) in daemon transport (`AdbDaemonTransport`) have
> almost no quirks. Server transport has quirks depending on server
> version. Shell commands have quirks depending on Android versions.

Three layers, three independent sources of version skew, and the fix for
each is different because the *fallback mechanism* is different.

**Daemon transport** (`AdbDaemonTransport`) is the direct WebUSB path
that webadb.online uses. It speaks the ADB wire protocol straight to
`adbd` on the device — CNXN, AUTH, OPEN, WRTE, OKAY, CLSE — with no
host-side ADB server in the middle. The daemon on the device is
reasonably consistent across versions, so this layer is stable.

**Server transport** (`AdbServerClient`) is the path that talks to a
host `adb` server over TCP. That server is a separate piece of software
with its own version number, and the protocol it speaks has changed over
time. This is where #849 lived: `getDeviceFeatures()` sends a
device-context switch followed by `host:features`, and the host service
does not inherit the device context from the switch — so with more than
one device attached, the server rejects the request with `"more than one
device/emulator"`.

**Shell commands** are the third layer. Once you send `shell:...` to the
device, the command is interpreted by whatever binary is on the device's
`PATH` — and Android's versions of `pm`, `am`, `cmd`, `settings`, and
friends are not stable across releases. This is the layer where a
browser-based client hits the most surprises, because the client has no
way to know what the device's userspace looks like until it asks.

## Tier one: feature negotiation, not version numbers

Before version-specific branches come into play, the library has a
mechanism that needs no guessing: the device advertises its capabilities
in its feature string, and the library reads them.

`libraries/adb/src/features-value.ts` defines the constants, and the
ordering comment points at the authoritative source:

```typescript
// The order follows
// https://cs.android.com/android/platform/superproject/main/+/main:packages/modules/adb/transport.cpp;l=81;drc=2d3e62c2af54a3e8f8803ea10492e63b8dfe709f

export const Shell2 = "shell_v2";
export const Cmd = "cmd";
export const Stat2 = "stat_v2";
export const Ls2 = "ls_v2";
export const FixedPushMkdir = "fixed_push_mkdir";
export const Abb = "abb";
export const FixedPushSymlinkTimestamp = "fixed_push_symlink_timestamp";
export const AbbExec = "abb_exec";
export const RemountShell = "remount_shell";
export const TrackApp = "track_app";
export const SendReceive2 = "sendrecv_v2";
export const SendReceive2Brotli = "sendrecv_v2_brotli";
export const SendReceive2Lz4 = "sendrecv_v2_lz4";
export const SendReceive2Zstd = "sendrecv_v2_zstd";
export const SendReceive2DryRunSend = "sendrecv_v2_dry_run_send";
export const DelayedAck = "delayed_ack";
```

The client-side query is `adb.canUseFeature(...)`. This is the mechanism
that lets a browser client avoid hardcoded version tables where the
device will just tell it what it supports.

The `Cmd` helper in `libraries/android-bin/src/cmd/` is where feature
negotiation becomes a *transport* decision. `createNoneProtocol` tries
three strategies in order:

```typescript
export function createNoneProtocol(
    adb: Adb,
    fallback?: NonNullable<Cmd.Fallback>,
): Cmd.NoneProtocolService | undefined {
    if (adb.canUseFeature(AdbFeature.AbbExec)) {
        return {
            mode: Cmd.Mode.Abb,
            spawn: adbNoneProtocolSpawner(async (command, signal) => {
                const service = serializeAbbService("abb_exec", command);
                const socket = await adb.createSocket(service);
                return new AdbNoneProtocolProcessImpl(socket, signal);
            }),
        };
    }

    if (adb.canUseFeature(AdbFeature.Cmd)) {
        return {
            mode: Cmd.Mode.Cmd,
            spawn: adbNoneProtocolSpawner(async (command, signal) => {
                checkCommand(command);

                const newCommand = command.map(escapeArg);
                newCommand.unshift("cmd");
                return adb.subprocess.noneProtocol.spawn(newCommand, signal);
            }),
        };
    }

    if (fallback) {
        return {
            mode: Cmd.Mode.Fallback,
            spawn: adbNoneProtocolSpawner(async (command, signal) => {
                checkCommand(command);

                const newCommand = command.map(escapeArg);
                newCommand[0] = resolveFallback(fallback, command[0]!);
                return adb.subprocess.noneProtocol.spawn(newCommand, signal);
            }),
        };
    }

    return undefined;
}
```

Three tiers, and the order matters:

1. **`abb_exec`** — the modern, most efficient path. The command goes
   over a dedicated `abb_exec:` socket rather than through a shell, with
   `\0` as the argument separator so arguments can contain spaces:

   ```typescript
   export function serializeAbbService(
       prefix: string,
       command: readonly string[],
   ): string {
       checkCommand(command);

       // `abb` mode uses `\0` as the separator, allowing space in arguments.
       // The last `\0` is required for older versions of `adb`.
       return `${prefix}:${command.join("\0")}\0`;
   }
   ```

   Note the trailing `\0` — "required for older versions of `adb`". That
   is a version quirk baked into a single character, and it is the kind
   of thing that only shows up on old devices.

2. **`cmd`** — the `cmd <service> <args>` dispatcher available from
   Android 7 onward. This is the tier that replaced shelling out to the
   standalone `pm`/`am` binaries.

3. **Fallback** — a caller-supplied mapping from service name to
   standalone binary name. This is the pre-Android-7 path where you run
   `pm` directly instead of `cmd package`.

The `fallback` parameter can be a string, a record, or a function, and
`resolveFallback` handles all three shapes:

```typescript
export function resolveFallback(
    fallback: Cmd.Fallback,
    command: string,
): string {
    if (typeof fallback === "function") {
        fallback = fallback(command);
    } else if (typeof fallback === "object" && fallback !== null) {
        fallback = fallback[command];
    }

    if (!fallback) {
        throw new Error(`No fallback configured for command "${command}"`);
    }

    return fallback;
}
```

So the library has a *feature-flag* tier for "how do I invoke this
service" and a *version-number* tier for "which subcommand does this
service understand." Those are different problems and need different
answers.

## Tier two: the API-level branch, and why `cmd package path` is special

Feature negotiation cannot solve every problem, because some breakage is
*within* a feature. `cmd` exists on Android 7 and later, and the `cmd`
subcommand set differs per service. The library handles this with an
explicit API-level check in the `android-bin` wrappers.

The clearest example is `PackageManager.getPath` in
`libraries/android-bin/src/pm.ts`:

```typescript
const command = [PackageManager.ServiceName, "path"];

// Android 7 and 8 support `cmd package` but not `cmd package path` command
let process: AdbNoneProtocolProcess;
if (this.#apiLevel !== undefined && this.#apiLevel <= 27) {
    command[0] = PackageManager.CommandName;
    process = await this.#adb.subprocess.noneProtocol.spawn(
        command.map(escapeArg),
    );
} else {
    process = await this.#cmd.spawn(command);
}
```

Read the comment carefully, because the situation is counterintuitive.
On Android 7 and 8 (API 24–27), `cmd package` *works* — the service
exists — but the `path` subcommand is missing from it. So the fix is to
*fall back to the older standalone binary*, swapping the service name:

```typescript
static readonly ServiceName = "package";
static readonly CommandName = "pm";
```

`command[0] = PackageManager.CommandName` turns `["package", "path"]`
into `["pm", "path"]`, and the spawn goes through
`adb.subprocess.noneProtocol.spawn` instead of the `cmd` wrapper. The
result on the wire is a plain `pm path <package>` invocation.

The `ActivityManager` wrapper in `libraries/android-bin/src/am.ts` does
the same thing at a different threshold:

```typescript
// Android 7 supports `cmd activity` but not `cmd activity start` command
let process: AdbNoneProtocolProcess;
if (this.#apiLevel !== undefined && this.#apiLevel <= 25) {
    command[0] = ActivityManager.CommandName;
    process = await this.#adb.subprocess.noneProtocol.spawn(
        command.map(escapeArg),
    );
} else {
    process = await this.#cmd.spawn(command);
}
```

API 25 is Android 7.0; API 27 is Android 8.1. So `cmd activity start`
was added in Android 8, while `cmd package path` was added in Android 9.
The two services grew their subcommand sets at different times, and the
library tracks each one separately.

There is a third variant worth calling out, because it is not a
"command doesn't exist" problem but an "output goes to the wrong stream"
problem. In `pm.ts`'s `sessionCommit`:

```typescript
// Android 7 did support `cmd package install-commit` command,
// but it wrote the "Success" message to an incorrect output stream,
// causing `checkResult` to fail with an empty message
let process: AdbNoneProtocolProcess;
if (this.#apiLevel !== undefined && this.#apiLevel <= 25) {
    command[0] = PackageManager.CommandName;
    process = await this.#adb.subprocess.noneProtocol.spawn(
        command.map(escapeArg),
    );
} else {
    process = await this.#cmd.spawn(command);
}
```

`checkResult` is strict about this:

```typescript
async checkResult(stream: ReadableStream<Uint8Array>) {
    const output = await stream
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new ConcatStringStream())
        .then((output) => output.trim());

    if (!output.startsWith("Success")) {
        throw new Error(output);
    }
}
```

`output.startsWith("Success")` — so on Android 7, where the message
arrives on stderr instead of stdout, `checkResult` sees an empty string
and throws `new Error("")`. A user seeing that would reasonably file it
as a webadb bug. The fix is invisible from the outside: the same binary,
spawned through a different transport, whose output lands on the stream
the library is actually reading.

Note also the `apiLevel !== undefined` guard on every branch. If the
caller does not supply an API level, the library does *not* guess — it
uses the modern `cmd` path and lets the device decide. That is a
deliberate design choice: a wrong guess is worse than a device that
answers "unknown command."

## Where the API level comes from

The `apiLevel` is a constructor argument, not something the library
detects:

```typescript
constructor(adb: Adb, apiLevel?: number) {
    this.#adb = adb;
    this.#apiLevel = apiLevel;
    this.#cmd = Cmd.createNoneProtocol(adb, PackageManager.CommandName);
}
```

And a `grep` across `libraries/` for `ro.build.version` returns nothing —
the library never reads `getprop ro.build.version.sdk` itself. The caller
supplies it if they want version-specific behavior, and `undefined` (the
default) means "use the modern path and hope for the best."

For webadb.online this is the concrete gap. Our `lib/adb-client.ts`
invokes `pm` and `am` directly:

```typescript
async listInstalledPackages(opts?: { includeSystem?: boolean }): Promise<PackageInfo[]> {
    const s = this.requireSession();
    const includeSystem = opts?.includeSystem !== false;
    const args = ["pm", "list", "packages", "-f"];
    if (!includeSystem) args.push("-3");
    const out = await spawnText(s.adb, args);
    return parsePackageList(out);
}
```

and

```typescript
async launchPackage(packageName: string): Promise<string> {
    const s = this.requireSession();
    const resolved = await spawnText(s.adb, [
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        packageName,
    ]);
    ...
    return spawnText(s.adb, ["am", "start", "-n", activity]);
}
```

Two different invocation styles in the same file, chosen per call site
rather than per device: `launchPackage` uses `cmd package
resolve-activity` (requiring the `cmd` feature, i.e. Android 7+), while
`listInstalledPackages` uses the standalone `pm` binary (working
everywhere but older than the `cmd` path would prefer). Neither checks
the device's API level, and neither knows that `cmd package path` does
not exist before Android 9.

Our `package.json` pins `@yume-chan/adb` at `^3.0.0-beta.1` and does not
depend on `@yume-chan/android-bin` at all — the `android-bin` package
that contains `pm.ts` and `am.ts` is not in our dependency tree. So the
version-aware wrappers are simply not available to us today.

## The `Socket open failed` path, for completeness

The reporter's Android 11 symptom — `createSocket()` returning
`Socket open failed` — comes from a specific place in the ADB daemon
packet dispatcher, `libraries/adb/src/daemon/dispatcher.ts`:

```typescript
// If the socket is still pending
if (
    packet.arg0 === 0 &&
    this.#initializers.reject(
        packet.arg1,
        new Error("Socket open failed"),
    )
) {
    // Device failed to create the socket
    // (unknown service string, failed to execute command, etc.)
    // it doesn't break the connection,
    // so only reject the socket creation promise,
    // don't throw an error here.
    return;
}
```

The semantics are worth understanding precisely, because they explain
why the failure looks like a bug and is not one. The ADB daemon replies
to an `OPEN` request with either `OKAY` (success) or `CLSE` (failure).
On `CLSE`, `arg0` is `0` if the *open* failed, and the daemon responds
with a "close" of the local socket ID that was never successfully
opened.

The comment above that block spells out the historical wrinkle:

```typescript
// From https://android.googlesource.com/platform/packages/modules/adb/+/65d18e2c1cc48b585811954892311b28a4c3d188/adb.cpp#459
/* According to protocol.txt, p->msg.arg0 might be 0 to indicate
 * a failed OPEN only. However, due to a bug in previous ADB
 * versions, CLOSE(0, remote-id, "") was also used for normal
 * CLOSE() operations.
 */

// Ignore `arg0` and search for the socket
const socket = this.#sockets.get(packet.arg1);
if (socket) {
    await socket.close();
    socket.dispose();
    this.#sockets.delete(packet.arg1);
    return;
}
```

Old ADB versions sent `CLSE(0, ...)` for *normal* closes too, so a `CLSE`
packet with `arg0 === 0` is ambiguous between "open failed" and "close
acknowledged". The library disambiguates by checking whether a socket
with that local ID is still pending in `#initializers`: if it is, the
open failed; if a socket object exists in `#sockets`, it was a close
confirmation.

Critically, the failure is *scoped*. A failed `OPEN` does not tear down
the ADB connection — only the socket-creation promise rejects. The
comment says so explicitly, and it matters: a browser client that treats
one failed `OPEN` as a fatal transport error will disconnect a perfectly
healthy device.

Now, why did the reporter's Android 11 device reject `OPEN("tcp:8080")`
while the same device accepted `toybox nc 127.0.0.1 8080` over a shell
socket? The answer is that these are two different ADB services with
different implementations:

- `OPEN("tcp:8080")` asks `adbd` to open a TCP connection **from the
  device** to `127.0.0.1:8080`, using `adbd`'s own socket-opening code.
- `OPEN("shell:...")` asks `adbd` to spawn a subprocess.

The `tcp:` service in `adbd` has historically been implemented with
`local_connect` and its own path/permission handling, and its behavior
varies across Android versions and OEM forks. The maintainer's reaction
was appropriately skeptical — "That's indeed really wired" — and he asked
the reporter to verify against the official Google `adb` binary with
`adb forward tcp:8080 tcp:8080`. The reporter went quiet for three
months and the issue was closed.

That is the honest state of it: an unreproduced, now-closed issue. The
value in it for the ecosystem is not the bug, but the maintainer's
taxonomy — which is the part that generalizes.

## What this means for webadb.online

Two concrete takeaways, one about our code and one about our
dependencies.

**Our `pm`/`am` calls are the fragile part, not the ADB transport.** The
library's own framing is that daemon-transport `adb.*` features have
almost no quirks. Everything version-sensitive in our app lives one level
up, in the shell commands we hand-roll. Our `launchPackage` uses
`cmd package resolve-activity`, which requires the `cmd` feature
(Android 7+) and — on older Android — a `cmd package` service whose
subcommand set differs from modern. Our `listInstalledPackages` uses
the standalone `pm` binary, which is the *more* compatible choice but
not the one the library would make on a modern device.

A concrete, low-risk improvement: read the device's API level once at
connect time (`getprop ro.build.version.sdk` over the shell we already
have), and use it to pick between the `cmd` and standalone-binary forms
per call site. That mirrors what `android-bin` does, at a fraction of the
effort, and it makes our App Manager panel behave predictably on
Android 7/8 devices instead of failing with an opaque "unknown command"
string from the device.

**`@yume-chan/android-bin` is the package that would fix this properly,
and it is a dependency we do not have.** It carries the `pm.ts`/`am.ts`
wrappers with their API-level branches, the `Cmd` service with its
three-tier fallback (ABB → `cmd` → standalone binary), and the
`checkResult`/`serializeAbbService` helpers that encode years of
device-version archaeology. Adopting it would mean replacing our
hand-rolled `pm`/`am` invocations in `lib/adb-client.ts` with typed
method calls — `packageManager.getPath(pkg)` instead of
`spawnText(s.adb, ["pm", "path", pkg])` — and passing the detected API
level into the constructors so the branches actually engage.

That is a real refactor rather than a patch: our `lib/adb-client.ts`
parses `pm list packages -f` output with a hand-written
`parsePackageList`, and `android-bin` has its own parser with its own
format assumptions. It is not a change to make casually. But the
direction is clear, and the upstream library is not going to absorb the
problem for us — issue #840 sat open for seven months because it is
inherently a per-integration problem.

The Chrome Direct Sockets check was skipped this week — that source is
only scanned on Mondays — so this post covers upstream ya-webadb issue
activity only.
