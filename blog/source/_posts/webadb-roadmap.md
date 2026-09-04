---
title: webadb.online roadmap — what's next, what's blocked, what we need
date: 2026-08-25 14:30:00
tags:
  - roadmap
  - feature-requests
  - meta
---

This is the post I'd want to read if I were considering using
webadb.online for something serious and wanted to know what's
actually in the queue. Concrete features, ordered by where they
are in the development cycle, with the blockers called out.

We're at **v0.1.0**, with twelve panels and ~5k LOC of TypeScript.
Things that work, work well — the screencast saga is the
long-running one and even that has stabilized. The notes below
are about the gaps.

## Now (the next 6 weeks)

### Screencast audio

`screenrecord --audio-source MIC` works on AOSP but Xiaomi /
HyperOS strips the flag. We've confirmed via `adb shell
screenrecord --help` that the option is silently dropped before
the binary starts, so we can't even pass it through. The two
paths forward:

1. Capture audio on the device via a different route (e.g. a
   tiny helper app we side-load) and mux it into the fMP4 init
   segment at the browser side.
2. Wait for Xiaomi to ship unstripped screenrecord.

The fMP4 muxing is already in the design — `extractAvcCodec`
becomes `extractAvcAndAudioCodecs` and the
`addSourceBuffer(codecs)` call gets the combined codec string
(`video/mp4; codecs="avc1.X,mp4a.40.2"`). Maybe 40 lines of
change once we have a source.

### Clipboard panel for bidirectional text + image

Today the clipboard panel reads text from the device clipboard.
Bidirectional text works via the `cmd clipboard set-text`
service. Images don't work because the device-side clipboard
service only carries text; images on Android are stored
per-app, not in a system-wide clipboard, until Android 14's
"default clipboard" opt-in lands.

### Scrcpy-level touch

The screencast panel currently has no input — it's strictly
view-only. Touch is the obvious next addition. The
implementation route is `adb shell input touchscreen tap x y`,
which is on-device latency of 100–200 ms. Scrcpy does better
with a custom InputManager service but that's not accessible
without root.

For mouse: same primitive, different event type (`tap` vs
`swipe`). We can ship click + drag + scroll with no
architectural change. The harder half is multi-touch (pinch
to zoom) which needs `input touchscreen` calls in a specific
sequence with a tight timing budget.

### File manager search

Recursive filename search with a regex, plus content grep on
text files (capped at ~10MB per file so we don't blow the
device's RAM). The wiring is there — `AdbSync.read()` streams
chunks — we just haven't built the UI for it.

## Next (6–16 weeks)

### Multi-device switching

Today the topbar shows one device. If you have two phones
plugged in via a hub, you connect to one, then disconnect,
then connect to the other. There's no parallel-session model.
Adding it would mean:

- An `AdbConnection[]` instead of `Adb | null` in the React
  store.
- Each panel takes a `deviceId` prop and looks up the right
  connection.
- The screencast pipeline is the gnarliest port — its
  spawn / kill / file-poll loop has to be per-device.

We'd want this for power users. It's not in the queue for the
first six weeks because it's the kind of feature that
needs careful state-management work to avoid cross-device
pollution.

### App deep links

`adb shell am start -W -a android.intent.action.VIEW -d URI`
will deep-link into an installed app. Adding a panel that lets
you bookmark a list of deep links (per app) and fire them with
a click is two days of work. Useful for QA, useful for
presentations.

### Persistent host key backup / restore

The browser's ADB keypair lives in IndexedDB. There's no way
to export it. Adding an export-to-PEM button is maybe 50 lines.
Restoring from PEM is another 50. Both useful for people who
have multiple browsers and want to skip the phone's "Allow USB
debugging?" dialog when they switch.

## Later (next 6+ months)

### Installer / launcher

A package that bundles webadb.online with the ability to detect
when the user has Chrome installed and one-click register a
`chrome://webadb/` shortcut. Outside the scope of a Cloudflare
Pages static bundle, but doable as a small Electron or
Tauri-style binary that wraps the same bundle.

### WebRTC tunneling for low-latency screencast

`adb reverse` is fine for shell and other bidirectional
streams, but the screencast path polls a file on the device.
A WebRTC bridge would let us send H.264 over a peer connection
to the browser and skip the polling round trip entirely.
Latency drop: ~150ms. Effort: large — needs a small native
helper on the device that owns the encoder.

### Account sync

Multi-device workflow needs an opt-in account layer to sync
saved layouts, app shortcuts, the persistent ADB key, and the
last device used. The data is small enough to fit in any
cloud provider; we'd never see the content of your shell
sessions, only metadata.

We're deliberately not building this until there's actual
demand. Account systems are expensive to design well and easy
to design badly.

## What's blocked (and why)

### Wireless ADB out of the box

The **Wi-Fi ADB** panel exists and works for devices that
already have wireless debugging enabled. We can't toggle
wireless debugging on by default because the API to do so
(`adb shell settings put global adb_wifi_enabled 1`) is gated
behind either root or a specific permission that Xiaomi doesn't
grant over USB. This isn't a web limit — it's an Android one.

### Multi-touch input

As noted under Scrcpy-level touch — needs InputManager service
which needs root. There might be a way with vendor-specific
utilities (Xiaomi has `cmd input` extensions) but we haven't
checked every ROM variant. Will dig into it once a Xiaomi
engineering contact surfaces.

### `adb backup` / `adb restore`

Backup is a 4-year-deprecated shell protocol that Google
keeps around but won't fix. Most modern apps refuse to
participate (you have to opt-in via `android:allowBackup="false"`
which many devs do). The wire format is documented but the
end-to-end is broken enough that we'd be building a
compatibility shim. Not in the queue.

## What we need from users

If you're using webadb daily and want something done, the most
useful things you can do are:

1. **Report what device + OS combo you're on** when something
   doesn't work. The screencast saga was unblocked by a single
   `adb shell screenrecord --help` output from a Xiaomi
   user.
2. **Open issues for actual blockers, not feature requests**.
   "I want my layout to persist across sessions" we already
   built; "I want feature X" is on the roadmap. The first type
   of issue gets a fix in days, the second waits for someone
   to want it hard enough to build.
3. **Don't ask for cloud sync.** We won't do it. If you want
   it, fork and build it. Sync systems are where privacy
   disasters happen and the security model of webadb
   specifically avoids server state.

## Where to follow along

The release notes go in this blog (you'll see them tagged
`release-notes`). The detailed engineering writeups are
tagged `deep-dive`. The roadmap itself is just this post,
updated quarterly.

If you've read this far, the next post in the series is
**The macOS Big Sur chrome** — how the window manager, the
dock, the draggable + maximizable desktop windows, and the
state persistence work, and why we picked that aesthetic
over a more "PWA-y" mobile-shell look.