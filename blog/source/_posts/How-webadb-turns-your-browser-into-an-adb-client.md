---
title: How webadb.online turns your browser tab into an ADB client
date: 2026-08-25 14:00:00
tags:
  - webusb
  - adb
  - ya-webadb
  - internals
  - deep-dive
---

Open webadb.online in Chrome, hit **Connect device**, pick your phone in
the picker, and a seconds later a `>_` shell is running in your browser —
no driver install, no daemon, no native binary. There is no server in the
loop. USB traffic never leaves your machine. This post walks through how
that actually works, end to end: from the moment Chrome renders the
device picker to the moment `shell.exec("ls")` returns text in your
terminal pane.

## The three actors

The whole stack has three components that need to agree on a wire
protocol:

| Component       | Runs in              | Talks to                  |
|-----------------|----------------------|---------------------------|
| Chromium browser| your machine         | Android device via USB    |
| `webadb.online` | a Cloudflare Pages static bundle | Chromium (your tab)       |
| `ya-webadb`     | bundled in `webadb.online` (`@yume-chan/adb`, `@yume-chan/adb-daemon-webusb`) | Chromium → device         |

`ya-webadb` is the TypeScript ADB implementation that makes the browser
side possible. It reimplements the ADB protocol on top of a
`UsbConnectionInterface` that you wire up — for web, that's the
WebUSB-backed `WebUsbDaemonConnection` from the `-webusb` companion
package. We don't fork ya-webadb; we just import it and feed it the
device the user picked.

## Step 1 — the device picker

The whole flow starts with a single line in `lib/use-connect-actions.ts`:

```ts
const device = await AdbDaemonWebUsbDeviceManager.requestDevice();
```

That call hands control to Chrome, which renders the native USB device
picker (anchored to the top-left of the page on macOS, top-center on
Windows). Chrome reads every USB device the host kernel knows about,
filters the ones exposing the ADB interface (vendor `0x18d1` /
`0x04e8` / `0x12d1` / …), and shows just those.

Once you pick one, Chrome returns a `USBDevice` handle. **Your
browser tab, not webadb.online, owns that handle.** From this point on,
no other browser tab and no host-side `adb` daemon can talk to the
phone — the kernel driver is bound to whichever process opened the
device. If you try `adb devices` on the host while a webadb.online
session is live, you'll see no devices. This isn't a bug, it's how USB
works.

`USBDevice` is then passed to `WebUsbDaemonConnection`, which builds
the ADB daemon transport around it.

## Step 2 — the ADB handshake

ADB is a length-prefixed binary protocol over a bulk USB endpoint.
Every "connection" is a stream of framed packets; each packet has a
24-byte header (command, arg0, arg1, payload length, magic, checksum)
followed by a payload. ADB version, max payload, banner, etc. are
exchanged in plain ASCII during `OPEN`.

ya-webadb implements the entire protocol in pure TypeScript. Its
`AdbDaemonConnection` consumes the framed stream from WebUSB, dispatches
by command, and gives you back `Adb` objects that wrap sync / async /
shell / file services.

Our `lib/adb-client.ts` is a thin wrapper around that. It owns:

- the `Adb` object (one per session)
- a `disposers` array so the React effect cleanup can call `.close()`
  on the connection when the user disconnects
- a tiny event bus that the React layer subscribes to

The `Adb` object itself exposes typed services — `AdbSync`, `AdbShell`,
`AdbFile`, `AdbReverse`, `AdbForward`, `AdbTcp`, `AdbPower` —
that's every subsystem the panels use.

## Step 3 — auth (the RSA fingerprint dance)

ADB requires an RSA keypair to authenticate the host. The browser
generates one with `crypto.subtle.generateKey` on first connect; it
persists in `IndexedDB` (the `webadb-online:credentials` database).
Every subsequent connection uses the same key.

On the phone, the first time you connect with a new host key, Android
pops a system dialog asking you to confirm the fingerprint of the host
key. The user's "Always allow from this computer" check permanently
trusts the key. After that, the browser-side auth is invisible.

This is the part people hit most often. If you tapped **Cancel** once
and now the panel says "device unauthorized", the fix is to revoke the
authorization from Developer Options on the phone (USB debugging
settings → Revoke authorizations → re-plug). The browser-side key
stays the same, so you don't have to re-grant every app — just once
per device.

## Step 4 — per-service plumbing

Once `Adb.authenticate()` returns, the panels open connections to
specific services:

```ts
// from lib/screencast/pipeline.ts
const stream = await adb.shell.raw(`screenrecord ...`);
```

ADB services are addressed by name. `shell:v2:raw:command` opens a
shell subprocess. `sync:` opens the file service (used by File
Manager, APK install). `shell:exec:command` runs a one-shot exec
without a PTY. Each of these has its own framing — some are
length-prefixed streams, some are bidi, some have their own handshake.

ya-webadb models each service as a class. When a panel calls
`adb.shell.raw("...")`, ya-webadb:

1. Opens a new USB bulk endpoint pair (in/out).
2. Sends `OPEN(1, "shell:v2:raw:screenrecord ...")` to the daemon.
3. The daemon forks the subprocess and pipes its stdout to the bulk
   in endpoint of the new connection.
4. Returns a `ReadableStream<Uint8Array>` that yields the subprocess
   output as it's produced.

## Step 5 — streaming binary data (the screencast case)

Screencast is the gnarliest user of the protocol because it streams
megabytes per second through a 16-MB-payload USB endpoint, where each
MP4 chunk is its own complete ISO BMFF file. We use `shell:v2:raw`
specifically because the default `shell:exec:` protocol caps payloads
at the device-side `MAX_PAYLOAD` from `OPEN` (usually 256 KB on modern
phones). The `:raw` variant skips that aggregation layer and gives us
the raw fd, which is what `screenrecord --output -` would write to —
except HyperOS won't let `screenrecord` write to stdout, so we use the
file-mode trick (writing to `/sdcard/webadb-screencast.mp4` and polling
the file via a separate `stat` / `dd` shell command — see the
screencast deep-dive for why this works and what edge cases we hit).

## Step 6 — disconnect

`webadb.online` only holds the USB device for the lifetime of the tab.
When you close the tab, hit **Disconnect** in the top bar, or refresh,
the cleanup effect in `use-connect-actions.ts` calls `adb.close()`
which:

1. Sends `CLOSE` on every open service.
2. Calls `USBDevice.close()` on the WebUSB handle.
3. Releases the kernel driver back to the host (so `adb devices` on
   the host works again).

The browser may also revoke the persisted device permission, depending
on the version of Chrome. To re-grant, you click **Connect device**
again — the picker remembers the last device, so it's one click, not a
fresh flow.

## What this means for the security model

Three properties worth calling out:

1. **Zero server trust.** The static bundle never talks to anything
   other than your USB device. The Cloudflare Pages origin only serves
   files. There's no analytics endpoint, no session server, no debug
   ping. GA4 is loaded with `anonymize_ip` and respects
   `prefers-reduced-motion` so it doesn't change behavior in
   privacy-sensitive contexts.

2. **The USB device grant is the security boundary.** WebUSB grants
   are per-origin (scheme + host + port). A different origin can't
   reuse your grant. That's why we don't embed a third-party iframe
   for the ADB handshake even when the temptation is real (CDN
   debugging, support tooling).

3. **The persistent key is local.** Your ADB host key is in
   `IndexedDB` under the webadb.online origin. If you clear site data
   the next connection will produce a new key and the phone will ask
   you to authorize again. There's no way to "back up" the key
   across browsers; that's intentional.

## What's in the queue

The deeper-cut topics we'll cover in separate posts:

- the moov-at-end / rotating-recorder design in the screencast panel,
  and why we can't just rely on `screenrecord -` stdout on modern
  Android
- cross-origin isolation (COEP `require-corp` + COOP) and the exact
  sequence of headers that lets us use `MediaSource`,
  `SharedArrayBuffer`, and WebUSB in the same page without breaking
  GA4
- the roadmap: audio capture, app deep links, Scrcpy-level touch
  emulation, and a real installer
- the macOS Big Sur window chrome — why we did it, what the
  accessibility trade-offs are, and how the dock persists state

If you want to peek at the protocol itself, `@yume-chan/adb` ships a
debugging `dump` mode that logs every frame to the console — useful
when you're trying to figure out what `cp -r` is doing under the hood.