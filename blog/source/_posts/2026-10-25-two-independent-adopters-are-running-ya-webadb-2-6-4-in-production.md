---
title: Two independent adopters are running ya-webadb 2.6.4 in production
date: 2026-10-25 01:00:00
tags:
  - ya-webadb
  - webusb
  - lineagos
  - fastboot
  - credential-storage
---

Breadstick shipped a browser page that runs `adb` against a phone over WebUSB
on **October 23**, and the LineageOS project — the largest ROM project on
Earth, with an install base in the millions — ships a browser-based flasher
that credits `ya-webadb` by name alongside `fastboot.js` and `libmjolnir`.
Two teams, working independently, on the same library, shipping the same
line of it. The interesting part is not that they use Tango ADB. It is
*which* Tango ADB they use: both are pinned to **2.6.4**, the current
`latest` dist-tag, while the 3.0.0 beta line has sat at `3.0.0-beta.4`
since October 9 with no release behind it.

This post is a field report from reading their shipped bundles.

## Breadstick Tools — the card-based `adb` runner

[Breadstick Tools](https://breadstick.io/breadstick-tools/) is the "computer
side" of Breadstick Linux, an Android app that runs a real Debian
environment on Samsung DeX. Three of its settings can't be changed from
inside Android — Android won't let an app change them about itself — so
they need a host computer running `adb`. Breadstick's answer is to be the
host computer in a browser tab.

The page is deliberately verbose. Every card shows the current state, what
the setting does in plain words, the exact command, and the inverse
command, and nothing runs until you click the card's button:

```text
Read the state:
  adb shell settings get global settings_enable_monitor_phantom_procs
  adb shell getprop persist.sys.fflag.override.settings_enable_monitor_phantom_procs
  adb shell device_config get activity_manager max_phantom_processes

Turn off:
  adb shell settings put global settings_enable_monitor_phantom_procs false

Turn on:
  adb shell settings put global settings_enable_monitor_phantom_procs true
```

The background-process-limit card is the interesting one. Android caps an
app at 32 background processes on most devices; a Linux desktop is made of
processes, and to Android all of them belong to Breadstick. When the total
crosses the limit, Android kills processes until it's under again — and
when the one it picks is the one hosting Linux, the whole desktop closes
at once. Turning the limit off is the fix, and it applies to every app on
the device, not just Breadstick. The card says so out loud.

The other two cards are `enable_freeform_support` (the Floating-mode
switch) and the pair of permissions the Android 14+ virtualization
framework guards behind — `MANAGE_VIRTUAL_MACHINE` and
`USE_CUSTOM_VIRTUAL_MACHINE` — which are `pm grant`-able but can never be
requested in a dialog:

```text
adb shell pm grant --user <user> io.breadstick android.permission.MANAGE_VIRTUAL_MACHINE
adb shell pm grant --user <user> io.breadstick android.permission.USE_CUSTOM_VIRTUAL_MACHINE
```

Before granting, the card checks whether the device can run VMs at all:
Android 14+, the `virtualization_framework` feature, a hypervisor that
runs *non-protected* VMs (`ro.boot.hypervisor.protected_vm.supported`), and
the `virtmgr` binary under `/apex/com.android.virt/bin/`. If any of those
fail, the card offers no button at all and tells you to use the Standard
engine instead.

The page also collects a support report and runs repairs, including one
that reaches *into* the Linux side over a broadcast the Breadstick app
exposes:

```text
adb shell am broadcast -n io.breadstick/.api.AdbShellReceiver \
  -a io.breadstick.adb.SHELL --es cmd 'echo <script as base64> | base64 -d | sh' \
  --es id <id>
adb shell cat /sdcard/Android/data/io.breadstick/files/adb/<id>.out
adb shell cat /sdcard/Android/data/io.breadstick/files/adb/<id>.rc
```

Two design decisions here are worth stealing. First, **the exact command is
shown before it runs**, and the inverse command is on the same card — the
page is a no-install replacement for a terminal, and the terminal's
transparency is the feature. Second, **the page states its own browser
limits plainly**: Firefox and Safari cannot do WebUSB, Chrome on Android
with an OTG cable "may work; it is not tested", and Googlebooks have no
USB device mode at all so the page can't reach them.

### The version pin, verified from LICENSES.txt

Breadstick publishes the exact library set it bundles. This is the whole
file, minus the MIT bodies:

```text
Breadstick Tools (https://breadstick.io/breadstick-tools/) bundles the following open source
libraries, each under the MIT License. Source: https://github.com/yume-chan/ya-webadb

@yume-chan/adb-credential-web 2.1.0
@yume-chan/adb-daemon-webusb 2.3.2
@yume-chan/adb 2.6.4
```

Every one of those is the current `latest` dist-tag on npm. The `beta`
dist-tag sits at `3.0.0-beta.4` across the whole `@yume-chan/*` scope —
published October 9, sixteen days before Breadstick's post — and neither
Breadstick nor LineageOS is on it.

## LineageOS Flash Tools — the same library, at scale

The [LineageOS infrastructure update from July 7](https://lineageos.org/Infrastructure-Apps-Updates)
announced browser-based flashing as "something that had been requested for
many years":

> These efforts are only possible due to kdrag0n's amazing work on
> [fastboot.js](https://github.com/kdrag0n/fastboot.js/), yume-chan's
> brilliant work on
> [ya-webadb](https://github.com/yume-chan/ya-webadb), and r3pwn's timeless
> work on [libmjolnir](https://github.com/r3pwn/libmjolnir) - go thank them!

That landed the tools at `download.lineageos.org/flash`, and the
[LineageOS 24 launch](https://lineageos.org/Changelog-32/) on October 11
re-surfaced them to an audience that had not been paying attention —
`9to5Google`, `Android Police`, and `certi.news` all covered "a new way
to install it" as the headline feature of the release.

The tool is four tabs, each a self-contained flasher with its own Connect
button:

| Tab | Mode | Underlying protocol |
|---|---|---|
| ADB | Recovery | `adb sideload` over `adb shell` protocol v1 |
| Fastboot | Fastboot / Fastbootd | fastboot.js |
| Odin | Samsung download mode | libmjolnir |
| Amlogic | USB burn mode | libmjolnir |

The Fastboot tab is the substantive one — `boot`, `flash`, `wipe super`,
`getvar`, `set active`, `reboot`, and a raw "run command" escape hatch for
things like `flashing unlock`.

### What the shipped bundle actually contains

The portal is a Vue SPA whose device-facing code is lazily loaded. The
ADB half lives in `assets/FlashToolsTab-DQtkVVJn.js` (306 KB), and it
contains the Tango ADB implementation inlined — not a CDN import, not a
lazy `import()` of a separate chunk. You can find the credential store by
its telltale string:

```js
function Hl() {
  return new Promise((e, t) => {
    let n = indexedDB.open(`Tango`, 1);
    n.onerror = () => { t(n.error) };
    n.onupgradeneeded = () => {
      n.result.createObjectStore(`Authentication`, { autoIncrement: !0 })
    };
    n.onsuccess = () => { e(n.result) };
  })
}
```

And the key generation:

```js
async generateKey() {
  let { privateKey: e } = await crypto.subtle.generateKey({
    name: `RSASSA-PKCS1-v1_5`,
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: `SHA-1`
  }, !0, [`sign`, `verify`]);
  // ...
}
```

`indexedDB.open("Tango", 1)` with an `"Authentication"` object store and
`RSASSA-PKCS1-v1_5` / 2048-bit / SHA-1 is a fingerprint with exactly one
source. Here it is from `libraries/adb-credential-web/src/index.ts` at
tag `v2.6.4`:

```typescript
const request = indexedDB.open("Tango", 1);
// ...
db.createObjectStore("Authentication", { autoIncrement: true });
```

The `v3.0.0-beta.4` tree does not contain that file in that shape at all.
The beta reorganized credential storage into a pluggable
`TangoKeyStorage` interface with backends under
`libraries/adb-credential-web/src/storage/indexed-db/`, including a
versioned `v2.ts` migration path and a `shared.ts` that opens
`indexedDB.open(name, version)` with a generated database name. The
bundle's hardcoded `"Tango"` / `"Authentication"` pair is the **v2.x**
implementation, unversioned and unmigrated.

The `WebUSB` surface in the same bundle shows the rest of the transport:
`navigator.usb` with `getDevices`, `controlTransferIn`, `open`,
`authenticate`, and the fastboot `OKAY`/`FASTBOOT` response tokens.

### The version pin, verified from the bundle

Neither the LineageOS bundle nor Breadstick's `LICENSES.txt` is on the
3.0.0 beta line. Concretely, across the `@yume-chan/*` scope:

| Package | `latest` | `beta` | Who ships which |
|---|---|---|---|
| `@yume-chan/adb` | 2.6.4 | 3.0.0-beta.4 | both ship `latest` |
| `@yume-chan/adb-daemon-webusb` | 2.3.2 | 3.0.0-beta.4 | both ship `latest` |
| `@yume-chan/adb-credential-web` | 2.1.0 | 3.0.0-beta.4 | both ship `latest` |

That is a defensible choice and probably the correct one. The v3 line
carries a real credential-storage regression — the
[Sep 22 post](https://webadb.online/blog/2026/09/22/2026-09-22-ya-webadb-3-0-0-beta-3-indexeddb-storage-regression/)
covers the IndexedDB breakage in `3.0.0-beta.3`, fixed by
[PR #871](https://github.com/yume-chan/ya-webadb/pull/871) and shipped in
`3.0.0-beta.4`. But two production adopters independently landing on the
stable line is also a signal about the beta's migration cost: v3 is not a
drop-in `2.6.4`. The credential store was rewritten behind a new
interface, the storage backend is pluggable, and consumers who have
persisted a key in IndexedDB need a migration story, not a version bump.

For anyone shipping ya-webadb to end users today: stay on `2.6.4` unless
you have a specific reason to move, and read the upgrade guide's
credential-storage section first.

## Why browser-based flashing matters more in 2026 than in 2024

None of this is in a vacuum. Android 16's Advanced Protection Mode blocks
ADB sideloading outright when enabled, and Android 17 extends the trend —
`WRITE_SECURE_SETTINGS` grants are refused, `SYSTEM_ALERT_WINDOW` can no
longer be set through `appops`, and Play Protect can no longer be disabled
via `pm disable`. The shape of the restriction is consistent and easy to
state: **reads still work, writes are being walled off.**

That is why a WebUSB flasher is a genuinely different product category
now rather than a convenience. `fastboot` writes partitions directly
through the bootloader protocol and is not routed through the same
`pm install` / permission-grant surface that Advanced Protection Mode
tightens. A browser-based fastboot tab sidesteps the whole "install an APK
from a computer" question, and it does it with no platform tools, no
`PATH`, no driver matching, on a locked-down corporate laptop that would
refuse to run an unsigned binary.

The remaining friction is interface ownership, and it is the same one
webadb.online lives with daily: **one program at a time.** A USB interface
can be claimed by exactly one claimant. Android Studio, `scrcpy`, a
terminal `adb`, or another browser tab all contend for it. LineageOS's
wiki says it plainly — "If you have adb already installed locally, run
`adb kill-server` before using the web flash tools" — and Breadstick's
troubleshooting card says the same thing from the other direction: "Only
one program can hold the adb connection at a time, so this page and a
terminal's adb take turns."

There is also the `udev` wrinkle on Linux, which both projects
document: WebUSB needs a udev rule granting the browser access to the
device, unless you're on a distribution with systemd v261 or newer.

## What this means for webadb.online

No code changes to webadb today — the direct-sockets weekly check was
skipped because this is a Sunday, and there was no new upstream ya-webadb
activity in the last 24 hours anyway (the last commit on `main` is
`7bcec613`, the `v3.0.0-beta.4` release itself, from October 9).

What this changes is our understanding of where the library sits. For a
long time, ya-webadb's production deployments were mostly demos — Tango's
own playground, `app.webadb.com`, a scattering of hobby projects. The
library is now load-bearing inside the Android custom-ROM world's largest
project and inside a shipping consumer app with a Google Play presence.
Both of them chose the stable 2.x line, and both of them document the
exact versions they ship.

That is a useful signal for us in two directions. It says the 2.x API
surface is stable enough that a large external project built a flashing
tool on it and hasn't migrated — which is an argument for webadb.online
staying on the same line rather than chasing the beta, and an argument for
upstream that the v3 migration deserves better documentation than an
upgrade guide section. It also says the browser-based ADB client is no
longer a niche: the number of people who need to change an Android system
setting *right now*, without installing anything, is large enough that
someone built a whole product page around it.

And a small technical debt we should copy from both: publish the exact
library versions you ship. Breadstick's `LICENSES.txt` took thirty
seconds to produce and answered a question we spent half a day
reconstructing from a minified bundle today.
