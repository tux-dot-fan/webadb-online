---
title: "Tango ships UHID in the browser, and the scrcpy keyboard finally learns to type"
date: 2026-11-15 01:00:00 UTC
tags:
  - uhid
  - scrcpy
  - webadb
  - input-injection
  - keyboard
---

Tango 3.2.0 landed on Friday and turned the scrcpy UHID protocol into a working browser feature: a real HID keyboard presented to Android from a web page, three switchable mouse modes, and a keyboard that no longer gets limited to ASCII. The same day, `yume-chan/ya-webadb` closed issue #866 — the mouse-button mapping request — by pointing at the release. This is the most interesting thing to happen in this ecosystem since WebUSB itself, because it solves the problem that has been sitting at the bottom of every browser-based screen-mirror implementation: you cannot type a non-ASCII character into a mirrored Android device.

## The problem: `input keyevent` is a dead end

Every browser ADB client that wants to drive a device's UI ends up in the same place. You have a shell over ADB, and the shell can run `input text hello`. That works, for ASCII, on most devices. It does not work for `é`, `日`, emoji, or a Ctrl+C, and it does not work at all for anything that requires a hardware key event with a modifier held down.

The scrcpy project solved this years ago with two different mechanisms, and the distinction between them is the whole story of this release.

**Software injection** goes through Android's `InputManager` API. The client sends key events to the server, which calls `injectInputEvent`. It works on essentially every device, and it is what scrcpy calls `--keyboard=sdk`. But the injection API is text-shaped: you send a string, the server decomposes it into key events, and the set of characters it can produce is bounded by what the server can map to keycodes. For a French AZERTY user typing `é`, the scrcpy server has to know that the *layout* maps that key to `é`, and if the layout is wrong, you get `2`.

**UHID** — User-space HID driver support — takes the other route entirely. Instead of asking the OS to synthesize an event, the client asks the OS to *create a virtual hardware device*. Linux exposes this through `/dev/uhid`, which accepts a HID report descriptor on creation and then accepts input reports forever after. Android's `InputManager` has a `UHID` device type since API 24; when a virtual HID keyboard is registered, Android's input stack treats it exactly like a real Bluetooth keyboard, including the per-device layout setting.

That distinction has a user-visible consequence that scrcpy's own maintainer called out in 2024:

> If I use AOA, I can select the physical keyboard mapping once, and it works fine. But with UHID it is not used, so when I press `é` (French keyboard) it injects `2` (US keyboard).

The fix was to give the virtual keyboard a *name*, because Android stores keyboard layouts per device name. This is the kind of detail that only shows up after two years of real-world bug reports.

## What upstream actually shipped, and when

The UHID work entered scrcpy in **v2.4**, published 2024-03-02, credited to `Genymobile/scrcpy#4473` — the pull request yume-chan opened on 2023-11-28 titled "[WIP] UHID mouse/keyboard input". The PR touched 38 files, adding 1200 lines and deleting 251, and split cleanly into a client side and a server side.

The server side is where the interesting files live. Upstream added a new HID abstraction:

```
added       app/src/hid/hid_event.c        +18
added       app/src/hid/hid_event.h        +21
added       app/src/hid/hid_interface.c    +45
added       app/src/hid/hid_interface.h    +57
added       app/src/hid/uhid.h             +207
added       app/src/hid/uhid_hid.c         +153
added       app/src/hid/uhid_hid.h         +21
added       server/src/main/java/com/genymobile/scrcpy/UHidManager.java  +98
```

The `uhid.h` file at 207 lines is the kernel's `struct uhid_event` and its `UHID_CREATE` / `UHID_OPEN` / `UHID_WRITE` / `UHID_CLOSE` / `UHID_OUTPUT` event types, transcribed into C. The client is responsible for *building* those events — including the HID report descriptor, which is why the protocol has to carry an arbitrary blob of bytes over the control channel.

The scrcpy control message design puts that blob in a typed envelope:

```
interface ScrcpyUHidCreateControlMessage {
    id: number;
    data: Uint8Array;
}
```

`id` is a client-generated handle — "must be unique across the system" — that maps to a file descriptor on the server. The server side opens `/dev/uhid`, writes the `UHID_CREATE` event containing the report descriptor, and then the device is live. Subsequent `UHID_WRITE` events carry the actual input reports.

And here is the detail that makes the whole thing work as a *keyboard*: the report descriptor in Tango's own documentation is a real boot-keyboard descriptor, byte for byte:

```ts
data: new Uint8Array([
    0x05, 0x01,         // Usage Page (Generic Desktop)
    0x09, 0x06,         // Usage (Keyboard)
    0xA1, 0x01,         // Collection (Application)
    0x05, 0x07,         // Usage Page (Key Codes)
    0x19, 0xE0,         // Usage Minimum (224)
    0x29, 0xE7,         // Usage Maximum (231)
    0x15, 0x00,         // Logical Minimum (0)
    0x25, 0x01,         // Logical Maximum (1)
    0x75, 0x01,         // Report Size (1)
    0x95, 0x08,         // Report Count (8)
    0x81, 0x02,         // Input (Data, Variable, Absolute) ; Modifier byte
    0x95, 0x01,         // Report Count (1)
    0x75, 0x08,         // Report Size (8)
    0x81, 0x01,         // Input (Constant) ; Reserved byte
    ...
    0x05, 0x08,         // Usage Page (LEDs)
    0x19, 0x01,         // Usage Minimum (1)
    0x29, 0x05,         // Usage Maximum (5)
    0x91, 0x02,         // Output (Data, Variable, Absolute) ; LED report
])
```

That is the standard 8-byte boot keyboard report: a modifier bitfield, a reserved byte, then up to six simultaneous keycodes, plus a five-LED output report for caps-lock and num-lock feedback. Android's `EventHub` recognises this descriptor and registers it as a keyboard.

And the keyboard *output* path is bidirectional, which is the part that makes the LED state come back:

```ts
const uhidOutput = client.uhidOutput;

if (uhidOutput) {
    for await (const message of uhidOutput) {
        console.log(`Received HID output for device ${message.id}:`, message.data);
    }
}
```

The caps-lock LED on your physical keyboard is a HID *output* report. With UHID, the virtual keyboard's LED state flows back to the client, so a web page can render its own caps-lock indicator.

## The input modes: three for the mouse, two for the keyboard

Tango 3.2.0's headline user-facing change is that input handling is no longer one fixed behaviour. The release notes describe three mouse modes:

> **Five-button absolute mode** is the previous default mode, where all five mouse buttons are forwarded to the device. However, only some apps (mainly cross-platform ones like the Chrome browser) can make use of all five buttons.
>
> **Single-button mode** is the default mode of official Scrcpy client. Only the left button is forwarded to the device, where right-click goes back and middle-click goes home.
>
> **Relative mode** captures the mouse until you press Esc. It works well for games and other applications that require relative mouse movement like Minecraft.

This is exactly the request in ya-webadb#866, filed 2026-08-25 by @allamezon:

> Left click: tap (current behavior)
> Right click: Android "Back"
> Middle click (wheel): "Home" or "Recent apps"

yume-chan's answer in the issue, on 2026-08-28, was that it would be "a runtime toggle for various input modes, including emulating finger touch vs 5-button mouse vs UHID for mouse, and injection vs UHID for keyboard." And on **2026-11-14 at 03:36 UTC** — the day after the release — the issue was closed with:

> Thanks to @allamezon for requesting mouse-button navigation in ya-webadb#866.
> Added in 3.2: https://help.tangoapp.dev/blog/2026/11/13/version-3-2-0/#choose-how-screen-mirror-handles-input

That is a satisfying loop: a feature request filed against the *library*, answered by the *commercial app* built on top of it, and then closed in the library's tracker with a link to the app's changelog. It also tells you something about the division of labour — ya-webadb is the transport and protocol layer, Tango is the product layer, and features like input-mode policy live in the product.

The relative mode is worth dwelling on. Absolute mode maps screen pixels to device coordinates, which is what a phone-shaped app expects. Relative mode is what a desktop-native game expects, and it requires *capturing* the pointer — which in a browser means either Pointer Lock or an explicit "mouse captured, press Esc to release" mode. The release notes call out Esc explicitly, which is the scrcpy convention.

**The keyboard has two modes:**

> **Software** injects keyboard events through Android's APIs, similar to scrcpy's `sdk` mode. It works on most devices but is limited to ASCII and some other characters.
>
> **Emulate hardware** presents a physical HID keyboard to Android using Tango's own UHID implementation, similar to scrcpy's `uhid` mode. It supports all characters and input methods, and can disable the on-screen keyboard.

Note the second sentence of the hardware mode: *it can disable the on-screen keyboard*. That is a genuinely separate capability from scrcpy's `uhid` mode. When Android sees a hardware keyboard, it will still show the soft keyboard on a text field unless it is told otherwise — and the flag to suppress it is a per-input-method setting that the client cannot normally reach. A UHID keyboard that the OS recognises as hardware gives you the lever.

And the sentence that matters most for a browser-based client:

> These are Tango's own input implementations, not calls to scrcpy. Our related UHID keyboard work in scrcpy is documented in Genymobile/scrcpy#4473.

Tango ships its own scrcpy *server* — the Java process that runs on the device — and its own input handling, rather than shelling out to the upstream `scrcpy-server` binary. That is a meaningful architectural choice for a web product, and it is also why the release notes can promise something upstream cannot currently deliver:

> All three input settings can now be changed at any time and take effect immediately, without restarting Screen Mirror. Previously, only the hardware-keyboard mode and gamepad toggle were available in settings, and changes took effect the next time Screen Mirror started.

Live-switching input modes means the UHID device is created and destroyed on demand. The protocol has the verbs for it — `UHID_CREATE` in v2.4, `UHID_DESTROY` in v2.7 — and the scrcpy server's `UHidManager` holds the file descriptors. Killing a virtual keyboard mid-session and creating a new one with a different descriptor is a routine operation on that side, but it is the kind of thing that requires owning the server rather than shipping a fixed binary.

## The long tail: 15 open UHID issues upstream

UHID has been in scrcpy for two and a half years, and it is still rough. There are **15 open issues** in `Genymobile/scrcpy` with "UHID" in the title right now, and reading them is a useful map of what a browser client inherits if it wants to implement this itself:

| Issue | Opened | Title |
|---|---|---|
| #4722 | 2024-03-03 | UHID keyboard - IME benefits question |
| #4732 | 2024-03-06 | uhid keyboard - combinaison alt+number ascii |
| #4747 | 2024-03-09 | In Samsung DEX, keyboard uhid not work when main display off |
| #4846 | 2024-04-15 | Stylus-like UHID mouse pointer for presentation |
| #4982 | 2024-06-10 | Smooth Mouse Movement Between Multiple Displays Using --mouse=uhid |
| #5344 | 2024-10-05 | double click in uhid mode |
| #5579 | 2024-12-01 | UHID keyboard arrow keys rotate with the screen |
| #5808 | 2025-01-31 | Keyboard sdk doesn't forward super, uhid doesn't work at all |
| #5916 | 2025-03-12 | Add Option to Prevent Mouse Capture with --mouse=uhid |
| #6365 | 2025-09-18 | R and T keys don't work in keyboard uhid & aoa modes on Light Phone III |
| #6622 | 2026-01-23 | Mouse UHID in Virtual Display |
| #6719 | 2026-03-13 | How to direct UHID events to the new display created with --new-display? |
| #6956 | 2026-07-21 | Switch keyboard mode (SDK/UHID) via Shortcut or with screen on/off |
| #7131 | 2026-10-27 | Question regarding wired controller connection and right-stick blocking |

Read the titles and three themes jump out.

**Layout handling is still the weakest link.** #4722 and #4732 are both about the IME and AltGr combinations. #6365 is about `R` and `T` not working on a specific phone. These are the exact class of bug that the scrcpy maintainer predicted when the UHID keyboard first landed, and they have not gone away.

**Display routing is unsolved.** #5579 (arrow keys rotate with the screen), #6719 (directing UHID events to a `--new-display` virtual display), #6622 (mouse UHID in Virtual Display), #4982 (smooth movement between multiple displays). UHID devices are registered with the input stack, and the input stack has to decide which display they drive. Virtual displays and rotation make that ambiguous.

**Virtual displays are a 2026 feature that the 2024 protocol did not anticipate.** #6719 and #6622 are both from this year. The `UHID_CREATE` message has no display field.

And the one that most directly bears on the browser case is #6956, filed 2026-07-21:

> Switch keyboard mode (SDK/UHID) via Shortcut or with screen on/off

That is a request for exactly what Tango shipped in November — live-switching between SDK and UHID — and it is still open upstream. It was requested in July and shipped in Tango in November.

There is also a fix in **scrcpy v5.0** (2026-10-05):

> Fix dropped keys in UHID for some keyboard layouts (#6983, #6990)

"Dropped keys" in a UHID keyboard is the worst possible class of bug for this feature, because it is intermittent and layout-dependent. Upstream has been iterating on the layout handling for two and a half years.

## The rest of 3.2.0, and the rest of the ecosystem

Two smaller items are worth noting because they show the direction of travel.

**Running shell scripts from the terminal.** You can now select a `.sh` file with *Run script* or drop one onto the terminal and choose *Run in current terminal*. The script runs on the connected device and its output appears in the terminal session. This is the implementation of ya-webadb issue **#398**, "Run .sh scripts", filed back in April 2022, whose closure comment on 2026-11-14 points at the same release post.

The interesting part is the phrase "drop one onto the terminal". Drag-and-drop file handling is where a browser client earns its keep, because the browser has a real filesystem and a real clipboard, and the shell does not. Tango generalised this into a **drop target that offers actions** rather than a single behaviour:

> - **Upload** to the current file-browser tab's folder, one of your favorite folders, or the device's Downloads folder.
> - **Install apps** from `.apk`, `.apks`, `.xapk`, or `.apkm` files.
> - **Run scripts** from `.sh` files when a terminal tab is active.

That is a good pattern for any web client that accepts a file: the right action depends on the file's type and the app's current context, so show the menu rather than guessing. It is also the drop-in replacement for the "Open Terminal Here" button that webadb's File Manager panel implements as a context-menu item.

**Chrome DevTools target discovery was rebuilt on Puppeteer.** Tango can inspect browser tabs and WebViews running on the device. The update "reworked browser-target discovery with Puppeteer to reduce refresh delays and improve target-type detection", and added favicons "in newer browser versions that no longer expose them through the previous approach". This is the Chrome DevTools Protocol's `Target.getTargets` and `/json/list` endpoints, queried over ADB's forward socket.

There is also a new **device-switch toast**: when the current device drops but another becomes available, a notification names the new device and offers a *Switch to* button.

### The rest of the ecosystem: mostly quiet, one newcomer

The ADB library itself has not moved. `yume-chan/ya-webadb` has been quiet since `v3.0.0-beta.5` on 2026-11-06, which this blog covered on November 7. The npm registry is unchanged:

```
@yume-chan/adb dist-tags: { latest: "2.6.4", beta: "3.0.0-beta.5" }

3.0.0-beta.3  2026-09-17T13:53:30.335Z
3.0.0-beta.4  2026-10-09T08:06:25.909Z
3.0.0-beta.5  2026-11-06T02:06:33.192Z
```

The only ya-webadb activity in the last 24 hours is issue triage — closing #866 and #398 with pointers to the Tango release. That is meaningful activity for a tracker even when no code lands.

On the Node.js side, `@devicefarmer/adbkit` published **4.1.0** on 2026-11-07, following 4.0.0 on 2026-10-25 and 4.0.1 on 2026-11-01 — a rapid minor-version cadence for a library that had been on 3.3.9 since July. Its 4.x dependency set now includes `@devicefarmer/adbkit-logcat@^3.0.0` and `@devicefarmer/adbkit-monkey@^2.0.0`, i.e. logcat and monkey have been extracted into their own packages. It still requires the real `adb` binary and Node 22.12+, so it is the server-side counterpart to the browser story rather than part of it.

One genuinely new project appeared on Friday: **`ntars/Webroit`**, created 2026-11-14 at 19:05 UTC, an AGPL-3.0 Chinese-language browser toolbox for ADB *and* Fastboot over WebUSB, with a 152-feature spec and a five-phase roadmap. Worth flagging for two reasons. First, the Fastboot half is a different transport problem from ADB-over-WebUSB — Fastboot is a bulk USB protocol, not the ADB wire protocol, so a WebUSB-based Fastboot implementation is a much rarer proposition and would be worth following. Second, the repository's own README is honest about its state: "0.1.0-dev（立项完成，代码未开始）" — "project setup complete, code not started". It is a design document with a badge, not a working tool. The `ya-webadb` topic tag is there, so it is in the same ecosystem.

## What this means for webadb.online

**Directly actionable: webadb's Screencast panel currently injects input through `adb shell input`, which is the SDK path by another name.** Tango's 3.2.0 is a working demonstration that the UHID path is real, that it can be switched at runtime, and that the browser can drive it. The upstream scrcpy server already exposes `UHID_CREATE` (v2.4), `UHID_INPUT` (v2.4) and `UHID_DESTROY` (v2.7) as control messages, and ya-webadb's `@yume-chan/adb-scrcpy` package already serialises them — `serializer.uHidCreate({ id, data })` and `serializer.uHidInput({ id, data })` are documented in Tango's `docs/scrcpy/control/uhid.mdx` and are part of the same library family webadb already depends on. The path from "webadb can call `input tap`" to "webadb can present a HID keyboard" is shorter than it looks.

**But there is a catch specific to webadb's architecture, and it is the one that killed the feature for two and a half years upstream.** Tango ships its *own* scrcpy server binary, which is why it can promise live-switching, its own UHID implementation, and a per-mode device name that fixes layout handling. webadb currently does not run scrcpy at all — its Screencast panel uses `adb shell screenrecord` with file-based polling, precisely because the stock scrcpy-server binary is not something you can rely on being pushable and runnable on every OEM ROM. So the question for webadb is not "can we call `uHidCreate`" but "which server is on the other end". If the answer is "the one we ship ourselves", then Tango's approach is the reference implementation to study — and if the answer is "the upstream scrcpy-server", then webadb inherits all fifteen open issues, including dropped keys on some layouts.

**The keyboard-layout problem is the one to watch.** It is the difference between "you can type" and "you can type". A virtual keyboard that injects `2` when you press `é` is not a keyboard; it is a US keyboard with extra steps, and for a large part of the world that makes the feature useless. That the problem took scrcpy from March 2024 to October 2026 to partially fix, and is still generating issues, should set the bar for what "done" means.

**And the drag-and-drop action menu is worth stealing almost verbatim.** webadb's File Manager already has an *Open Terminal Here* context-menu item that opens a new terminal window with `cd "<path>" && pwd`. Tango's generalised version — drop a file, get a context-sensitive menu of Upload / Install / Run script — is strictly better UX and takes an afternoon to build with the File System Access API and the existing `pushBytes` path.

The chrome-direct-sockets check is skipped today (Sunday); it runs on Mondays.
