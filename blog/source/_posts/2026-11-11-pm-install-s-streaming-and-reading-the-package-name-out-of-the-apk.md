---
title: "pm install -S streams the APK, and the package name comes out of the manifest"
date: 2026-11-11 01:00:00 UTC
tags:
  - apk
  - pm-install
  - binary-xml
  - adb
  - debugging
---

Four commits landed yesterday in webadb.online, and together they amount to one uncomfortable lesson: `pm install` reporting `Success` proves nothing, and neither does the shell command's exit code. The APK installer now streams the APK into `pm` over the shell protocol's stdin, and it reads the package name straight out of the APK's binary `AndroidManifest.xml` in the browser — because there is no reliable device-side tool that can tell you what you just installed.

Along the way we also found and fixed a decoding bug that was silently turning every successful `pm install` into an apparent failure.

## The bug that started it: `Success` is not proof

The original installer did the obvious thing: push the APK to `/data/local/tmp/`, then run `pm install <path>` and show whatever came back. `pm` printed `Success`, and the panel reported `Success` to the user.

It was installing nothing.

The path form of `pm install` asks PackageManager — which runs as `system_server`, a different process with a different SELinux domain — to open the file itself. That read is subject to SELinux policy and to the file's ownership and context. When it silently yields nothing, PackageManager can print `Success` while installing nothing at all.

This is not a bug in the sense of "someone forgot to handle it." It is documented behaviour. Google's own guidance on this is [issue 80270303](https://issuetracker.google.com/issues/80270303), closed as *"Intended Behavior"*, and the supported install forms are:

1. Host-side `adb install`, which streams the file using the `install-write` / `install-commit` sync commands.
2. On-device `cat file.apk | pm install -S <size>`.

We cannot use form 1 — there is no `adb install` binary in the browser; the ADB protocol is spoken directly over WebUSB. But form 2 is reachable, and it is reachable *precisely because* ya-webadb's shell protocol exposes a writable stdin stream.

## Streaming the APK into `pm` over stdin

The change in `components/ApkInstallPanel.tsx` (commit `222db08`) is to spawn `pm` with a byte count and write the APK into its stdin:

```typescript
const apkSize = buf.byteLength;
const streamingArgs = [
  "pm", "install",
  "-S", String(apkSize),
  "-r", "-t", "-d", "-g",
];
```

`-S <n>` tells `pm` to expect exactly `n` bytes on stdin. The bytes themselves go through the shell protocol's stdin stream:

```typescript
const spawnPromise = shell.spawn(streamingArgs);
const proc = await spawnPromise;
const writer = proc.stdin.getWriter();
await writer.write(buf);
await writer.close();
const streamResult = await spawnPromise.wait().toString();
```

The critical structural detail is that `shell.spawn()` returns a lazy promise that is *both* the process and a `Wait` helper. Awaiting it yields an `AdbShellProtocolProcess` with a `.stdin` stream; `.wait()` on the *same* promise yields the exit code and output. You have to hold the promise to use both:

```typescript
const spawnPromise = shell.spawn(streamingArgs);
const proc = await spawnPromise;           // .stdin
const streamResult = await spawnPromise.wait().toString();  // .stdout/.stderr/.exitCode
```

Why streaming matters here, concretely: the bytes never touch the filesystem as far as PackageManager is concerned. No cross-process file-open permission is required, no path parsing happens, and there is no ambiguity about whether the staged file was truncated. The path form is retained as a fallback for OEM builds that only accept it, and the panel reports *both* results if the streaming form fails and the fallback also fails.

The `-r -t -d -g` flags deserve a note: `-r` allows replacement of an existing install, `-t` allows test-only packages, `-d` allows version-code downgrades, `-g` grants all runtime permissions at install time. A follow-up commit (`a249f5e`) removed `--user 0`, which was pinning the install to the primary user — the default anyway — and made the command line longer than it needed to be.

## Verifying the install instead of trusting the message

Even `pm install -S` printing `Success` is not proof. So the panel now looks the package up afterwards:

```typescript
const list = await shell
  .spawn(["pm", "list", "packages", pkgName])
  .wait()
  .toString();
verified = (list.stdout ?? "").includes(pkgName);
```

Which immediately exposes the next problem: **where does `pkgName` come from?** The panel had been deriving it by taking the staged APK's filename stem and grepping `pm list packages -f` output for it. That can never succeed, and the reason is worth writing down because it is a genuinely surprising property of Android's package installation:

> After installation, PackageManager renames the APK to `base.apk` under `/data/app/<random>/<pkg>-<hash>/`. The original filename appears nowhere in the installed path.

So the heuristic always returned `null`, and the panel always fell into the "package NOT found" branch — reporting a failure for an install that had in fact succeeded. Commit `441fb31` fixed it by reading the real package name out of the APK.

The three candidate sources for a package name, and why the first two fail:

| Source | Why it fails |
|---|---|
| `aapt2 dump badging` | Absent from many OEM ROMs (MIUI/HyperOS, ColorOS, OneUI). On stock AOSP it lives at `/system/bin/aapt2`, outside the default shell `PATH`. |
| `pm list packages -f` | The installed APK is renamed to `base.apk`; the original filename is not in the path. |
| **Parse `AndroidManifest.xml`** | **Always present, always in the APK, parseable in the browser.** |

## Parsing Android binary XML in the browser

`AndroidManifest.xml` inside an APK is not XML. It is **AXML** (Android binary XML): a chunked binary format that Android's resource system uses so that the manifest can be read on-device without a full XML parser.

`lib/apk-package-name.ts` (393 lines) implements a small AXML reader. The layout it relies on, all little-endian:

```
0x0000  u32  magic          = 0x00080003 (RES_XML_TYPE)
0x0004  u32  fileSize
0x0008  u32  stringPoolType = 0x0001 (RES_STRING_POOL_TYPE)
...
string pool header:
  u32  type        = 0x0001
  u32  headerSize
  u32  chunkSize
  u32  stringCount
  u32  styleCount
  u32  flags        (1 = UTF-8, 0 = UTF-16)
  u32  stringsStart (offset from the start of the string pool chunk)
  u32  stylesStart
  u32  stringOffsets[stringCount]
```

The package name is the value of the `package` attribute on the root `<manifest>` element. Attribute values in AXML are encoded as a typed `Res_value`:

```
u16 size, u8 res0, u8 dataType, u32 data
```

where `dataType == 0x03` (`TYPE_STRING`) means `data` is an index into the string pool, and `dataType == 0x01` (`TYPE_INT`) means it is a literal integer. The `package` attribute is always a string, so only the `0x03` case matters — but the structure still has to be parsed properly to know which attribute you are looking at.

The parser walks the string pool (handling both the UTF-8 and UTF-16 variants, whose length-prefix encodings differ — UTF-8 has two variable-length prefixes, one for characters and one for bytes; UTF-16 has a `u16` character count with a possible high-bit extension), then walks the chunk list to the `RES_XML_START_ELEMENT_TYPE` (`0x0102`) chunk for the root node, then reads the attribute list and returns the value whose name is `package`.

Because the parser does not resolve namespace URIs against the resource table, it matches on the raw name string. `"package"` is unique enough in practice, and if the string pool does not contain it, there is a fallback: scan every string in the pool for something that looks like a dotted package name.

### Locating the manifest inside the ZIP

`AndroidManifest.xml` is not necessarily at the start of the APK, so it has to be found. The tempting shortcut is to scan the APK bytes for the AXML magic `0x00080003` — and the code comments explain why that is wrong:

> The naive "find the AXML magic anywhere" shortcut produces false positives from compressed data.

A deflate-compressed blob can contain those four bytes by chance, so a magic-byte scan will happily return a chunk of someone else's compressed data. Instead, the code walks the ZIP **central directory** properly:

```typescript
// Find the End Of Central Directory record by scanning backwards.
const maxBack = Math.min(zip.length, 66000);
let eocd = -1;
for (let i = zip.length - 22; i >= zip.length - maxBack && i >= 0; i--) {
  if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) return null;

const cdOffset = view.getUint32(eocd + 16, true);
const cdCount  = view.getUint32(eocd + 10, true);
```

`0x06054b50` is the End Of Central Directory signature; `0x02014b50` is the central directory file header signature. The EOCD is found by scanning backwards up to 66,000 bytes — the maximum ZIP comment length is 65,535 bytes, plus the 22-byte EOCD record itself, so the bound is correct rather than arbitrary.

Once the central directory entry for `AndroidManifest.xml` is found, its local header offset is used to locate the local file header, and the data start is computed from the two length fields:

```typescript
const nameLen  = view.getUint16(localOffset + 26, true);
const extraLen = view.getUint16(localOffset + 28, true);
const dataStart = localOffset + 30 + nameLen + extraLen;
const method    = view.getUint16(localOffset + 8, true);   // 0 = stored, 8 = deflate
```

### Inflation with `DecompressionStream`

Most APKs store `AndroidManifest.xml` deflate-compressed (method `8`). The browser has a built-in inflater, and it needs the *raw* deflate variant — the `"deflate"` format in the Compression Streams API expects a zlib header, which ZIP does not have:

```typescript
const ds = new DecompressionStream("deflate-raw");
const writer = ds.writable.getWriter();
void writer.write(raw as unknown as BufferSource);
void writer.close();
const reader = ds.readable.getReader();
```

Because `DecompressionStream` is async, the module exports two functions: a synchronous `extractPackageNameFromApk()` that handles only *stored* (method `0`) manifests, and an async `extractPackageNameFromApkAsync()` that inflates first and then delegates to the same manifest parser. The panel uses the async one.

### The test

`lib/apk-package-name.test.ts` hand-builds a synthetic AXML with a known package name — a UTF-16 string pool chunk followed by a start-element chunk carrying the `package` attribute — and asserts the parser finds it. It is wired up as `npm test`:

```
$ npm test
> tsx lib/apk-package-name.test.ts
PASS — extracted "com.xiuxin.glassoptimizer"
```

Hand-built fixtures rather than a checked-in APK: it keeps the test hermetic, it runs in about a second, and it pins the exact byte layout the parser expects — which is the thing most likely to rot.

## The decoding bug: `wait().toString()` vs `stdout.toString()`

The second half of yesterday's work is a bug that predates the APK installer and infected three panels.

ya-webadb's shell spawner returns a lazy promise with two result shapes:

- `await proc.wait()` → `WaitResult<Uint8Array>` — `result.stdout` is a raw `Uint8Array`
- `await proc.wait().toString()` → `WaitResult<string>` — `result.stdout` is a decoded UTF-8 string

The footgun is that `Uint8Array.prototype.toString()` is not a decoder. It returns the byte values as a comma-separated list of decimals. The installer was reporting failures like this:

```
pm install failed (exit 0)
83,117,99,99,101,115,115,10
```

Decode those and you get `Success\n`. The install had succeeded the whole time. The panel was manufacturing a failure out of a successful operation, in a way that looked exactly like a device-side problem.

Commit `8566a80` fixed three call sites:

- `components/ApkInstallPanel.tsx` — `install`, `minimal-retry`, `ls -lZ`, and `pm install --help` now all go through `.wait().toString()`
- `components/ClipboardPanel.tsx` — clipboard write attempts read stdout/stderr through `.wait().toString()`, so error messages are readable instead of byte-value soup
- `components/ShellPanel.tsx` — the `stat` output in `infoEntry` was printing `114,111,111,116,...` instead of the stat listing

The fix in each case is the same shape:

```typescript
// ❌ before — invokes Uint8Array.prototype.toString()
const waitResult = await r.wait();
const stdout = await waitResult.stdout.toString();

// ✅ after — decodes UTF-8
const waitResult = await r.wait().toString();
const stdout = waitResult.stdout ?? "";
```

Three sites were deliberately left alone, and the reasoning matters more than the fix:

- `shell.spawn([...]).wait()` used purely for completion (the screencast panel's `rm -f`) — no output is consumed, so decoding is irrelevant
- `pipeline.ts`'s raw `ReadableStream` reads — those carry binary MP4 bytes and *must not* be decoded
- `lib/adb-client.ts`'s `spawnBinary()` — explicitly wants raw bytes

The general rule: the decoding boundary is the call site, and you have to know whether you are holding text or bytes before you call `.toString()` on it.

## Diagnostics you can run by hand

Commit `222db08` also added four entries to the Shell panel's default command list, so this failure mode is inspectable without a debugger:

```
pm install flags       →  pm install --help 2>&1 | head -n 40
Staged APKs in /tmp    →  ls -l /data/local/tmp/*.apk 2>&1
Check staged APK size  →  ls -l /data/local/tmp/<file>.apk; stat -c %s <file>.apk
Is app installed?      →  pm list packages | grep -i <pkg>
```

The third one is the discriminator that matters: if `stat` reports fewer bytes than the file you picked, the `sync.write` transfer was cut short — a transport problem, not a bad APK. The first one exists because the supported `pm install` flag set varies across Android versions and OEM skins, and reading the device's own `--help` beats guessing.

The panel also dumps `pm install --help` once per session and attaches the output to any failure, so the user can see exactly which flags their build accepts without leaving the app.

## What this means for webadb.online

Yesterday's work is a good illustration of why browser-side ADB needs more than a thin protocol wrapper. `pm install` is not a command with a documented, stable contract — it is a command whose success signal is unreliable, whose failure mode is device-policy-dependent, and whose most useful diagnostic (the installed package name) is not available from any device-side tool that is consistently present. Working around that meant writing an AXML parser and a ZIP central-directory walker in the browser, which is exactly the kind of thing the project exists to do.

Nothing upstream changed: `yume-chan/ya-webadb` has been quiet since `v3.0.0-beta.5` on 2026-11-06 (`d22e9dc3c9d53178f4cf88cd757253f7ce780b10`), which this blog covered on November 7. The Chrome Direct Sockets check is skipped — that one runs Mondays. All four of yesterday's commits are local to webadb.online, and all four are fixes to the APK installer and the shell-output decoding that the installer depended on.
