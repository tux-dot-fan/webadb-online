---
title: Inside the webadb screencast panel — streaming a device screen via MSE + fMP4
date: 2026-08-25 14:10:00
tags:
  - screencast
  - mse
  - fmp4
  - hyperos
  - deep-dive
---

The screencast panel is the only place on webadb.online where bytes
flow from the device into the browser at the speed of a small video
stream. Everything else — terminal output, logcat, file uploads — is
small text. The screencast pipeline is a few hundred lines of code
that has to deal with three things that are not in any textbook:

1. **screenrecord writes the moov box only at end-of-recording** —
   the device-side file is half-finished at every moment during the
   recording. ISO BMFF init segments aren't optional.
2. **`screenrecord -` (stdout mode) is broken on HyperOS** — the
   kernel returns "Read-only filesystem" when screenrecord tries to
   open stdout. So we have to use the file mode and poll a path on
   `/sdcard`.
3. **The 4-GB size limit on 32-bit box headers** — Xiaomi's
   screenrecord uses 64-bit `largesize` boxes for the mdat, which
   need BigInt parsing on the JavaScript side.

This post is the writeup of the design that finally shipped — commit
`b8fcb37` on `main`, after four false starts.

## The naive plan (what doesn't work)

The most straightforward screencast implementation is:

```ts
const stream = await adb.shell.raw("screenrecord - --time-limit 5");
const chunks: Uint8Array[] = [];
for await (const chunk of stream) chunks.push(chunk);
// stitch chunks, mux into fMP4, appendBuffer to MediaSource
```

The muxing step is the part `mp4-muxer` does for you. You push H.264
NALs in, you get fMP4 init + media segments out, you append them to a
`SourceBuffer` and `video.src = MediaSource` plays it. This is the
shape of the implementation most scrcpy-web clones use.

Two problems:

1. **`screenrecord -` fails on Xiaomi / HyperOS / API 36.** It writes
   to stdout, then the kernel refuses because stdout isn't a regular
   file on Android. You get `error: cannot open 'w-': Read-only
   filesystem`. You can verify this on your phone with
   `adb shell "screenrecord - /sdcard/foo.mp4"` — same error.

2. **Even where stdout works, the moov box lives in screenrecord's
   internal buffer until end-of-recording.** If you mux from raw
   NALs yourself you don't need moov (you build your own init
   segment with SPS/PPS extracted from the first IDR). But every
   short-lived recording of 3 seconds means 3 seconds of
   **dead video at the start** — the mux needs an IDR to extract
   SPS/PPS, and screenrecord emits an IDR every couple of seconds,
   so you usually wait ~2 seconds before the first frame paints.

   The dead-video problem is also why trying to do the obvious
   thing — pipe screenrecord stdout straight into your muxer —
   gives you a panel where the video is permanently ~3 seconds
   behind real time.

## What we landed on

Use screenrecord in **file mode**, then **poll the file** from a
second adb shell command. Use screenrecord's **own** ftyp + moov
boxes verbatim (no custom muxing) and stream them to MediaSource.

This works because screenrecord writes complete, self-contained MP4
files. Every file has ftyp at offset 0, mdat in the middle, and moov
at the end. The moov contains the avcC box which has the SPS/PPS.
The mdat contains only H.264 NALs (no SPS/PPS — those are in avcC).
This is verifiable by pulling a finished recording off the device
and running `ffprobe`:

```
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'r3.mp4':
  Duration: 00:00:04.96, bitrate: 1185 kb/s
    Stream #0:0: Video: h264 (High), 480x1072, 1185 kb/s, 30 fps
```

…and parsing the mdat's first NALs with a custom walker that
classifies each by NAL type byte: you see `[5, 1, 5, 1]` (IDR +
non-IDR) but never a 7 (SPS) or 8 (PPS).

So: **device gives us a self-contained MP4; we ship it verbatim to
MSE.**

But we have the live-streaming problem — screenrecord takes the full
`--time-limit` to write moov, and we don't want to wait 3 seconds
with a black screen.

## Rotating short recordings

The fix is **rotating recordings**:

```ts
const CHUNK_SECONDS = 3;
while (!stopRequested) {
  await shell.spawn(["rm", "-f", STREAM_PATH]).wait();
  const proc = await shell.spawn([
    "screenrecord",
    "--size", `${w}x${h}`,
    "--bit-rate", String(bitrate),
    "--time-limit", String(CHUNK_SECONDS),
    STREAM_PATH,
  ]);
  // Auto-kill in case screenrecord ignores --time-limit on weird ROMs.
  setTimeout(() => proc.kill(), (CHUNK_SECONDS + 1) * 1000);
  await sleep(CHUNK_ROTATION_SECONDS * 1000); // CHUNK_SECONDS + 2
  proc.kill(); // forces moov flush
  await sleep(500);
}
```

Each iteration produces a complete MP4 file with its own moov. We
use the **first** chunk's ftyp + moov as the init segment for the
entire MSE session. Subsequent chunks' mdat content gets appended
as media segments — their ftyp and moov are discarded.

Why this works:

- screenrecord uses the same encoder config across runs (same
  resolution, same bitrate, same frame rate), so the SPS/PPS in
  every chunk's avcC are identical to the first chunk's.
- MSE remembers the init segment's stsd/stts/stsc/stsz/stco tables
  and uses them to interpret subsequent media samples. As long as
  the new mdat bytes correspond to those tables, MSE is happy.

There's a brief gap between chunks — the kill / rm / re-spawn takes
~500 ms during which the file is empty. The MediaSource stays open
and the buffered video keeps playing back during that gap. The
user sees a brief stutter every ~5 seconds, which is much better
than 3 seconds of black screen at start.

## Polling a growing file (the part that took longest)

The naive "poll the device-side file" function does this:

```ts
// WRONG — DO NOT USE
const stream = await shell.spawn([
  "tail", "-c", `+${offset + 1}`, STREAM_PATH,
]);
```

That looks correct but **blocks forever** when screenrecord is
actively writing to the file. `tail -c +N` reads from offset N to
EOF and only terminates on EOF — for a file with an open writer,
EOF never comes, so the process never exits, so
`ya-webadb`'s `shell.spawn().wait()` (which awaits
`process.exited`) never resolves.

The CDP-attached trace that surfaced this is on file in the
screencast saga — `[screencast] screenrecord chunk started` was
logged, then **zero** poll lines, even after 20 seconds. The shell
subprocess was just hanging.

Three iterations to fix:

| Attempt               | What we tried                            | Why it failed                          |
|-----------------------|------------------------------------------|----------------------------------------|
| `tail -c +N`          | Standard incremental tail                | Blocks on never-EOF writer             |
| `wc -c < file`        | One-shot, returns on EOF                 | Same problem — wc also reads to EOF    |
| `dd if=… skip=… count=` | Read N bytes only                      | `count` cap was missing initially      |

The actual working implementation uses two shells in sequence:

```ts
// size probe — stat() is a syscall, never reads content
const size = await shell.spawn(["stat", "-c", "%s", STREAM_PATH])
  .wait().toString();

// bounded read — dd exits after reading `count` bytes
const bytes = await shell.spawn([
  "dd", `if=${STREAM_PATH}`,
  "bs=1", `skip=${offset}`, `count=${want}`,
]).then(p => {
  // pipe stdout through ReadableStream
  const reader = (p.stdout as ReadableStream).getReader();
  // … collect chunks
});
```

`stat -c %s` returns the current file size immediately even if
screenrecord is mid-write — the kernel tracks size on every
write(2) call regardless of whether the process has called
fdatasync(2). And `dd` exits the moment it's read `count` bytes,
which terminates the shell subprocess and resolves `.wait()`.

The 8-MB per-poll cap on `want` keeps each shell transfer
bounded — if we fall way behind for some reason we never drain
megabytes through a single shell call.

## The BigInt detour

The mdat box in screenrecord's output is huge (hundreds of MB for
a 30-min recording). When the file size crosses 4 GB the box
header switches from a 32-bit size to a 64-bit largesize with a
length-1 sentinel at offset 0–3 and the real size at offset 8–15.

JS Number only has 53-bit mantissa precision. Reading the largesize
as `hi * 2^32 + lo` silently rounds once `hi > 1`, which gives you
garbage. CDP traces showed `mdat(4557430888798830600 @24)` — the
`4557430888798830600` is `0x3f3f3f3f3f3f4008`, which is actually
uninitialized kernel page bytes (the file was allocated but the
content hadn't been written yet, so the largesize field reads as
sparse placeholder bytes). Even after the field is properly
initialized, the JS rounding still corrupts large values.

Fix:

```ts
const big = new DataView(
  bytes.buffer, bytes.byteOffset + off + 8, 8
).getBigUint64(0, false);
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const totalSize = big > MAX
  ? Number.MAX_SAFE_INTEGER
  : Number(big);
```

The clamp to `Number.MAX_SAFE_INTEGER` is only a safety net —
no real recording on a phone will hit 8 PB. In practice the BigInt
read gives us the correct size every time.

## Walkers, not magic numbers

The mp4 box walker used to be a single-purpose `findMdatOffset()`
function that returned one offset. As soon as we needed to find
ftyp, moov, **and** mdat in one pass it became a one-shot walker
that records every top-level box it sees:

```ts
const walkTopBoxes = (bytes: Uint8Array): Array<{
  type: string; headerOffset: number;
  contentOffset: number; contentLength: number;
}> | null => { /* … */ }
```

A generic walker is more code but it's easier to reason about and
easier to add a new box type to (which we did a few times —
adding `ftyp` capture for the first chunk's ftyp box so the init
segment uses screenrecord's exact ftyp verbatim, including the
right brand string and minor version).

## The init / media dispatch

The dispatch logic is the part of the pipeline most likely to
silently misroute bytes:

```ts
const boxes = walkTopBoxes(bytes);
let newFtyp: Uint8Array | null = null;
let newMdatContent: Uint8Array | null = null;
let newMoov: Uint8Array | null = null;
for (const box of boxes) {
  if (box.type === "ftyp" && !ftypBytes) newFtyp = bytes.slice(...);
  else if (box.type === "mdat") newMdatContent = bytes.slice(...);
  else if (box.type === "moov") newMoov = bytes.slice(...);
}

if (newFtyp) ftypBytes = newFtyp;
if (newMdatContent) pendingMdatContent.push(newMdatContent);

if (newMoov && !initSegmentSent) {
  // First moov arrives — send init, then flush pending mdat
  initSegmentSent = true;
  await sourceOpenPromise;
  const codec = extractAvcCodec(bytes, newMoov);
  const sb = mediaSource.addSourceBuffer(codec);
  await sb.appendBufferAsync(concat(ftypBytes, newMoov));
  await sb.appendBufferAsync(concat(...pendingMdatContent));
  pendingMdatContent = [];
} else if (initSegmentSent && newMdatContent) {
  // Subsequent chunks — just append new mdat content
  await sourceBuffer.appendBufferAsync(newMdatContent);
}
```

Three branches, all named: **buffer-only** (no moov yet),
**first-flush** (init + buffered mdat), **streaming** (subsequent
mdat). The `initSegmentSent` flag is the line that separates
"we're buffering" from "we're streaming".

## What would change for audio

screenrecord v3 on AOSP can capture mic audio with
`--audio-source MIC`, but Xiaomi/HyperOS strips that flag. We
don't have an audio path yet. The cleanest fix when it ships is
to mux the audio track into the same fMP4 init segment — the
codec extraction in `extractAvcCodec` becomes
`extractAvcAndAudioCodecs` returning `video/mp4; codecs="avc1.X,
mp4a.40.2"` and the rest of the pipeline is unchanged. Pulled
into a separate post when we have hardware that supports it.

## Where to look in the code

- `lib/screencast/pipeline.ts` — the whole pipeline (~700 lines)
- `lib/screencast/types.ts` — the codec + progress message types
- `components/ScreencastPanel.tsx` — the React panel that owns
  the video element and dispatches start/stop

A future post will dive into the cross-origin isolation setup
(COEP / COOP / CORP) that makes `MediaSource` and
`SharedArrayBuffer` available without breaking GA4 — that's a
whole separate can of worms.