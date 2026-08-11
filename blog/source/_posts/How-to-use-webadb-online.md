---
title: How to use webadb.online
date: 2026-08-11 21:06:47
tags:
  - tutorial
  - getting-started
  - adb
  - webusb
---

A quick walkthrough of the seven things you'll actually use webadb.online
for: pairing the device, dropping into an interactive shell, moving files
around, browsing images, managing installed apps, watching CPU and
memory, and the smaller utilities (text editor, APK install, Wi-Fi ADB)
that round out the dock.

## 1. Connect your device

Open [https://webadb.online](https://webadb.online) in a desktop Chromium
browser — Chrome, Edge, or Opera. WebUSB isn't available on Safari or
mobile, and Firefox needs the deprecated native-flag workaround, so
stick to one of the three.

Hit the big **Connect device** button. The browser opens a device picker
— usually anchored to the top-left of the window — listing every USB
device you've granted permission to before. Pick your phone.

On the phone, accept the **"Allow USB debugging?"** prompt that pops up
the first time you plug in (Settings → Developer options → USB
debugging must be enabled). Tick "Always allow from this computer" if
you don't want to confirm every session.

You'll land on the desktop — a top bar, a dock at the bottom, and a
workspace in the middle. The Shell window opens by default. From here
on, every session picks up where the previous one left off (the
workspace layout and your pinned items are stored in `localStorage`,
not on a server).

## 2. ADB shell

The shell dock icon is the first thing you'll see. It's a real PTY:
arrow keys work, Ctrl+C interrupts, the window resizes with the
column-count environment variable, and ANSI colors pass through
verbatim — so `ls --color=auto`, `vim`, `top`, and any tool that uses
24-bit escapes render correctly.

Three things to know:

- **Saved commands.** Sidebar shortcuts (commands, scripts, binary
  files you've uploaded) persist across sessions in `localStorage`.
  Switching machines or browsers resets them — there is no cloud sync,
  by design, because the ADB session itself doesn't go through any
  server.
- **No streaming on shared devices.** If you're using a lab phone, the
  shell can be observed by anyone who reconnects with the same RSA
  key — revoke the key from Developer options when you're done.
- **`adb root` requires userdebug build.** `su` won't help on stock
  builds; if you need root, flash a `userdebug` image or use
  `Magisk`/`KernelSU` and run `su` from inside the shell.

> **Screenshot:** Terminal with `ls -la /data/local/tmp` output showing
> a colored directory listing.

## 3. File Manager

Open the File Manager from the dock. It mirrors a desktop file browser:

- Navigate by clicking folders; the path bar updates.
- **Double-click the path bar** to type an absolute path. This is the
  only way to reach `/data/local/tmp`, `/sdcard/Android/data/<pkg>/`,
  and other paths you can't step into one directory at a time.
- Right-click (or the kebab menu) for **Pin to sidebar** — pinned
  folders stick across sessions and across reconnects.
- Drag-and-drop a file onto the window to upload it.
- Double-click text files to open them in the in-browser text editor;
  double-click images to open them in the image viewer.

> **Screenshot:** File Manager showing `/sdcard/Pictures/` with the
> path bar in edit mode.

## 4. Browse images

Open any image and the viewer pre-loads the rest of the folder, so
left/right arrow keys flip through the whole album without going back
to the directory listing. This is much faster than the Android gallery
app for triage — especially when you're picking the one screenshot
out of forty that you actually wanted to upload.

Useful while testing:

- `Save` writes to your Downloads folder with the original filename.
- The viewer's zoom follows the image's intrinsic size; on
  `wallpaper.png` it respects the EXIF orientation flag (so portrait
  phone photos don't show sideways on the desktop).

> **Screenshot:** Image viewer showing a phone photo at full resolution.

## 5. App Manager

The dock's Apps icon lists every installed package with its launcher
icon (lazy-fetched from the APK — see [the previous post](/blog/2026/08/07/Hello-webadb/)
for why the row list uses a letter avatar). For each app you can:

- **Launch** — `am start -n <pkg>/<activity>` for the resolved launcher.
- **Uninstall** — `pm uninstall <pkg>`, with a confirmation dialog.
- **Force-stop / Clear data / Disable / Re-enable** under the
  overflow menu.
- **Permissions** — see every granted runtime permission, toggle them
  with the same prompts Android would show.
- **APK info** — versionCode, install date, target SDK, signature
  scheme, native libraries — anything you'd otherwise need
  `aapt2 dump badging` for.

> **Screenshot:** App Manager detail panel for a sample app showing
> the permissions grid.

## 6. System Monitor

The dock's chart icon opens a four-pane monitor modeled on GNOME's
System Monitor:

- **CPU** — per-core usage with sparklines (1s / 5s / 30s windows).
- **Memory** — total / used / available / cached, plus a breakdown by
  category (Java heap, native, graphics, system) when the device
  exposes the right `/proc` files.
- **Network** — per-interface sent/received, on both the cellular and
  Wi-Fi interfaces (when the device surfaces both).
- **Processes** — sorted by CPU by default; click a column to sort by
  RSS, PID, or user. The list polls every two seconds.

It's a faithful translation of `top` / `vmstat` into something you can
leave running in a corner while you do something else.

> **Screenshot:** System Monitor with CPU sparklines and a process list
> sorted by memory.

## 7. Other features

A few smaller dock icons round out the workspace:

- **Text Editor** — opens any text file you click in the File
  Manager. Edits buffer locally and save pushes the whole file back
  over ADB; there's no in-browser file watcher, so save and walk
  away rather than expecting live updates.
- **Install APK** — drag an APK onto the workspace and confirm. When
  this fails (it does occasionally — mostly on packages signed with
  v2-only signatures that need `pm install -t -r` instead of the
  installer flow), the workaround is to push to `/data/local/tmp/`
  with the File Manager, then run `pm install xxx.apk` from the
  shell. Both paths end up at the same place on the device.
- **Screenshot** — captures the foreground app and offers a download.
  Useful for grabbing an error dialog without unlocking the phone.
- **Wi-Fi ADB** — enables `adb tcpip 5555` and reports the device's
  current LAN IP, so you can unplug and keep the session going over
  Wi-Fi. Pair this with a saved-sidebar shortcut to the disconnect
  command when you want to clean up afterwards.

That's the full tour. If something's missing from the dock that you
expected to see — Sockets? Reverse port-forwarding? — open an issue
on the GitHub repo and it'll land in a future release.