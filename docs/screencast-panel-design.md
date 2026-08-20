# Screencast Panel — design notes

## What it is
12th dock panel in `lib/app-registry.tsx`, alongside the existing
Terminal / File Manager / Screenshot / etc. Streams the connected
Android device's live screen into a resizable window inside the
existing `Workspace` shell. Multiple Screencast windows can be open
at once (one per connected device, or per display).

## Pipeline (one direction, frame flow)

```
  Android device
    adb shell screenrecord --output-format=h264 --size=WxH --bit-rate=R
        │  (raw H.264 annex-B, no container, no audio)
        │  ts chunks via stdout
        ▼
  adb push from webusb side
        │  pull stdout, frame it in 64KB chunks
        ▼
  Browser (web worker, off main thread)
        │  WebSocket via postMessage to the panel
        ▼
  Panel React component
        │  VideoDecoder (WebCodecs) — H.264 high profile
        │  each VideoFrame → canvas (OffscreenCanvas) → main-thread draw
        ▼
  <canvas> in Workspace
        │  resize-observer → request new --size on the device
        ▼
  user sees device screen
```

## Bitrate policy (PPI reduction per user)
The user explicitly asked: "串流的 PPI 可以降低到浏览器所在平台的水平,
减少数据量". Today, ADB `screenrecord` hard-codes a fixed
`--bit-rate` (default 4 Mbps at the device's native resolution),
which is wasteful when the panel is e.g. 600 px wide on a 1080p
device. We scale the encoder dynamically to match the panel:

  `requested_bitrate_kbps = max(200, round(device_ppi * 0.5)) * (panel_w * panel_h) / (device_w * device_h)`

Concretely:

| device | DPR in browser | encoded size  | bitrate     |
|-------:|:--------------:|:-------------:|:------------|
| 1080×2400 (440 ppi) | 1.0 (400 px wide) | 400×889 | 200 kbps  |
| 1080×2400 (440 ppi) | 1.0 (800 px wide) | 800×1778 | 800 kbps  |
| 1080×2400 (440 ppi) | 1.0 (1080 px wide)| 1080×2400| 1.6 Mbps   |
| 1080×2400 (440 ppi) | 2.0 (1080 px wide)| 1080×2400| 3.2 Mbps   |

(So 400 px wide on a 1080-px screen at 440 ppi collapses to ~200 kbps,
roughly 20× less than the default 4 Mbps. That's the saving the user
asked for.)

The device has to support changing the encoder size at runtime.
`screenrecord` accepts `--size WxH` and `--bit-rate N`; we stop the
current process and start a new one with the new params whenever the
panel is resized. Stop/start takes ~150 ms; we live with that.

A cap of `max(panel_h, 720) × 4 Mbps / 2400` keeps the bitrate
bounded from above too, so resizing to a 4K window doesn't overflow
the USB pipe.

## Mouse / touch input
Per user: "除了串流, 也要能鼠标操作". Mirrors scrcpy:

  1. Pointer down/up/move on the <canvas> → synthesized `input` shell
     command sent over the existing ADB connection.
  2. Three button flavors:
       - left click   → `input touchscreen tap X Y`
       - middle click → `input keyevent KEYCODE_HOME` (so middle acts
                        like a Home button; standard scrcpy mapping)
       - right click  → `input keyevent KEYCODE_BACK`
  3. Scroll (wheel event) → swipe gesture:
       - one notch up   → `input swipe X Y X Y-100 200`
       - one notch down → `input swipe X Y X Y+100 200`
     (We avoid `input keyevent` for scroll because that's not what
     scrcpy does and feels wrong on Android.)
  4. Drag (left-down → left-move* → left-up) → single `input swipe`
     from start to end. The swipe duration is 200 ms to feel
     native; if the user wants to do something slower they can do
     a longer hold by holding the button.

Coordinate transform:

  panel_x_norm = (mouse_x - canvas_box.left) / canvas_box.width
  panel_y_norm = (mouse_y - canvas_box.top)  / canvas_box.height
  device_x     = round(panel_x_norm * device_screen_w)
  device_y     = round(panel_y_norm * device_screen_h)

`device_screen_w/h` is reported by `adb shell wm size` once at
connect and cached on the panel. If the device orientation changes
we re-read.

## Multi-window
Multiple Screencast windows can be open simultaneously — they just
each spawn their own `adb shell screenrecord` process. The two costs
are:

  - N × the per-window bitrate above (so a 4-window, all-400-px
    setup is 4 × 200 kbps = 800 kbps total — fine).
  - One USB bulk endpoint. Android's ADB implementation handles a
    couple of `screenrecord` stdout streams without issue on real
    devices; under load we can be capped. In practice we expect 2-3
    streams max per host controller.

Each Screencast window is its own React component instance, with its
own `panelId` prop and its own `Workspace` window frame (the
existing resizable window chrome handles drag/resize already).

## What we DON'T do (scope)
- **No audio.** `screenrecord` audio passthrough is tricky over
  WebUSB and not requested. Add later if needed.
- **No clipboard sync.** scrcpy supports it via the clipboard
  service. Out of scope for v1.
- **No wake / unlock.** Users plug in, the device must already be
  awake and unlocked. This matches how the rest of webadb already
  works.
- **No power-state UI.** Don't add a "wake device" button; the
  Screenshot panel already gives the user a way to nudge the device.

## Files to add
  components/ScreencastPanel.tsx     — the panel UI (canvas +
                                        pointer events + resize-observer
                                        + bitrate recompute).
  lib/screencast/
    pipeline.ts                      — start/stop `screenrecord`,
                                        H.264 framing, postMessage
                                        to the worker.
    worker.ts                        — Web Worker hosting the
                                        VideoDecoder; takes chunks,
                                        emits VideoFrame → ImageBitmap
                                        → main thread.
    types.ts                         — request/response types.
  lib/app-registry.tsx               — add the entry:
    { id: "screencast", title: "Screencast",
      icon: "📺", showInDock: true,
      Component: ScreencastPanel,
      description: "Live screen stream of the device, with mouse control." }

## Verification
  1. Open a Screencast window at 400 px wide. Confirm via
     `adb shell dumpsys media_session` that the encoder reports
     400-px source and ~200 kbps.
  2. Click in the panel. Confirm on the device that
     `adb shell input tap X Y` was issued (visible in
     `adb logcat -s ActivityManager:I` for the touch event).
  3. Open a second Screencast window. Confirm two `screenrecord`
     processes are running (`adb shell ps -A | grep screenrecord`).
  4. Scroll the wheel — confirm a swipe was issued.
  5. Resize the window from 400 px to 1080 px. Confirm the
     bitrate climbs and the encoded frame size matches.
