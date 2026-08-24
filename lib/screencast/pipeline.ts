// ── Screencast pipeline (main thread) ────────────────────────────────────────
//
// Glue between `session.adb.subprocess.shellProtocol` (the underlying
// ya-webadb API that panels get via the AppProps.session prop) and
// the MediaSource / SourceBuffer pair that drives the panel's
// `<video>` element.
//
// Architecture (file-based, used since device-side stdout screenrecord
// is blocked on HyperOS read-only filesystem):
//
//   device ─adb shell screenrecord /sdcard/webadb-stream.mp4─> writes
//        ISO-BMFF bytes incrementally
//   web   ─adb shell tail -c +N─> reads N bytes to end-of-file
//        ─chunks─> MPSE SourceBuffer.appendBuffer
//        ─decoded H.264─> <video> element
//        ─user clicks <video>─> `adb shell input tap`
//
// Why file-based instead of stdout:
//
//   stock AOSP screenrecord supports `--output-format=h264 -` (raw H.264
//   to stdout) but HyperOS 16 (Xiaomi) strips that flag — only the
//   file-output mode remains. Trying `screenrecord -` on this device
//   fails with "Read-only filesystem" because the kernel resolves `-`
//   to a path it can't create. Pixel screenrecord (which we used to
//   rely on) had a custom fork with the stdout flag; vanilla AOSP
//   screenrecord 1.4 doesn't.
//
//   The file-based approach costs us one `tail -c +N` round-trip per
//   poll (~250ms cadence). At ~30 fps and ~480x1072 we're pushing
//   ~500 KB/s through the shell — the round-trip is fast enough that
//   we keep up.
//
// What we feed MSE:
//
//   The device's screenrecord writes a fully-formed ISO-BMFF file
//   (ftyp + moov + mdat) using the AVC format: SPS/PPS live inside
//   the moov/avcC box, and mdat holds AVC length-prefixed NALUs.
//   We use the device's ftyp + moov verbatim as our init segment
//   (no need to construct it ourselves), and stream the mdat content
//   as media chunks. This is much simpler than the previous
//   muxer-from-scratch approach and lets the device's encoder do the
//   hard work.

import type { AdbSession } from "@/lib/adb-client";
import type { ProgressKind } from "./types";

// All console output is prefixed with [screencast] so it can be
// filtered easily in DevTools.
const TAG = "[screencast]";

/** Bitrate (in bits/second) at the device's native resolution. */
const NATIVE_BITRATE = 4_000_000;
const MIN_BITRATE = 200_000;
const MAX_BITRATE = 8_000_000;

/**
 * Path on the device where screenrecord writes its output. We pick a
 * name that's unique-ish to webadb so it doesn't collide with the
 * user's own screenrecord shortcuts (Android 12+ exposes screenrecord
 * in the Quick Settings tile — that one writes to
 * /storage/emulated/0/Movies/).
 */
const STREAM_PATH = "/sdcard/webadb-screencast.mp4";

/** Poll cadence for tailing the device-side file. */
const POLL_INTERVAL_MS = 250;

export interface PipelineHandle {
  bitrate: number;
  encodedWidth: number;
  encodedHeight: number;
  stop(): void;
}

export async function startScreencast(
  session: AdbSession,
  opts: {
    videoEl: HTMLVideoElement;
    panelWidth: number;
    panelHeight: number;
    devicePixelRatio: number;
    devicePhysical: { width: number; height: number };
    devicePpi: number;
    onError: (message: string) => void;
    onReady?: () => void;
    onProgress?: (kind: ProgressKind, detail?: string) => void;
  },
): Promise<PipelineHandle> {
  const aspect = opts.devicePhysical.height / opts.devicePhysical.width;
  let encodedWidth = Math.max(360, Math.round(opts.panelWidth));
  let encodedHeight = Math.max(
    Math.round(360 * aspect),
    Math.round(encodedWidth * aspect),
  );
  encodedWidth = encodedWidth & ~1;
  encodedHeight = encodedHeight & ~1;

  const nativeArea = opts.devicePhysical.width * opts.devicePhysical.height;
  const panelArea = encodedWidth * encodedHeight;
  const ppiFactor = Math.max(0.4, Math.min(1.0, opts.devicePpi / 440));
  const bitrate = Math.max(
    MIN_BITRATE,
    Math.min(
      MAX_BITRATE,
      Math.round((NATIVE_BITRATE * (panelArea / nativeArea)) * ppiFactor),
    ),
  );

  // ── 1. <video> + MediaSource + SourceBuffer setup ────────────────────────
  const videoEl = opts.videoEl;
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;

  const mediaSource = new MediaSource();
  console.log(TAG, "MediaSource created, initial state:", mediaSource.readyState);
  const objectUrl = URL.createObjectURL(mediaSource);
  videoEl.src = objectUrl;
  console.log(TAG, "video.src set, video dimensions:", videoEl.clientWidth, "x", videoEl.clientHeight);

  let sourceBuffer: SourceBuffer | null = null;
  const pendingMedia: ArrayBuffer[] = [];
  const sourceOpenPromise = new Promise<void>((resolve) => {
    if (mediaSource.readyState === "open") {
      resolve();
      return;
    }
    mediaSource.addEventListener("sourceopen", () => {
      console.log(TAG, "MediaSource sourceopen event fired, readyState:", mediaSource.readyState);
      resolve();
    });
    mediaSource.addEventListener("sourceended", () => {
      console.log(TAG, "MediaSource sourceended");
    });
    mediaSource.addEventListener("sourceclose", () => {
      console.log(TAG, "MediaSource sourceclose");
    });
    mediaSource.addEventListener("error", (ev) => {
      console.error(TAG, "MediaSource error event", ev, "readyState:", mediaSource.readyState);
      opts.onError(`MediaSource error: ${mediaSource.readyState}`);
    });
  });

  const appendBuffer = (buf: ArrayBuffer): void => {
    if (!sourceBuffer) return;
    if (sourceBuffer.updating) {
      pendingMedia.push(buf);
      return;
    }
    try {
      sourceBuffer.appendBuffer(buf);
    } catch (e) {
      opts.onError(
        `SourceBuffer.appendBuffer failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  };

  // Pending-media drain: every time SourceBuffer finishes an
  // append, append the next pending chunk. This keeps us appending
  // as fast as MSE accepts bytes.
  const drainPending = (): void => {
    if (!sourceBuffer || sourceBuffer.updating) return;
    while (pendingMedia.length > 0 && !sourceBuffer.updating) {
      const next = pendingMedia.shift()!;
      try {
        sourceBuffer.appendBuffer(next);
      } catch (e) {
        opts.onError(
          `SourceBuffer.appendBuffer failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return;
      }
    }
  };

  // moov gets written by the device only when screenrecord finishes
  // (typically --time-limit expires). Until then, polling returns only
  // ftyp + part-of-mdat, with no SPS/PPS anywhere. We buffer mdat
  // bytes in memory; once moov appears, we ship ftyp+moov as the init
  // segment and flush the buffered mdat content as the first media
  // chunks. After init is sent, subsequent polls are pure mdat content
  // (mdat doesn't grow once it's appended to, and the device writes
  // new frames into a fresh mdat).
  let initSegmentSent = false;
  let mdatContentOffset = 0;
  let lastReadOffset = 0;
  let pendingMdat: Uint8Array[] = [];
  let pendingMdatTotal = 0;

  // ── 2. Spawn screenrecord on the device ──────────────────────────────────
  const shell = session.adb.subprocess.shellProtocol;
  if (!shell || !shell.isSupported) {
    URL.revokeObjectURL(objectUrl);
    throw new Error("Device doesn't support Shell V2 protocol");
  }

  opts.onProgress?.(
    "spawning",
    `${encodedWidth}×${encodedHeight} @ ${(bitrate / 1_000).toFixed(0)} kbps`,
  );
  console.log(TAG, "spawning screenrecord (file mode)", { width: encodedWidth, height: encodedHeight, bitrate, path: STREAM_PATH });

  let stopRequested = false;
  let proc: { kill: () => void } | null = null;

  // Clean up any leftover file from a previous run.
  try {
    const clean = shell.spawn(["rm", "-f", STREAM_PATH]);
    await clean.wait();
  } catch {
    /* ignore — rm is best-effort */
  }

  // screenrecord writes ftyp + mdat during recording, and only writes
  // moov at end-of-recording. To get moov repeatedly during a long
  // live session we run screenrecord in a tight loop: each iteration
  // records `CHUNK_SECONDS` seconds, gets killed by us, and the moov
  // is written before we read the file. The first iteration's ftyp +
  // moov is shipped as the init segment; subsequent iterations'
  // mdat is appended to MSE as media chunks (their ftyp + moov is
  // discarded — same codec, same params, same SPS/PPS).
  const CHUNK_SECONDS = 3;

  const startOneRecording = async (): Promise<void> => {
    if (stopRequested) return;
    try {
      const rm = shell.spawn(["rm", "-f", STREAM_PATH]);
      await rm.wait();
      const newProc = await shell.spawn([
        "screenrecord",
        "--size", `${encodedWidth}x${encodedHeight}`,
        "--bit-rate", String(Math.max(200_000, bitrate | 0)),
        "--time-limit", String(CHUNK_SECONDS),
        STREAM_PATH,
      ]);
      if (stopRequested) {
        try { void newProc.kill(); } catch { /* ignore */ }
        return;
      }
      proc = newProc;
      console.log(TAG, "screenrecord chunk started");
      // Auto-kill after CHUNK_SECONDS so moov gets written. screenrecord
      // with --time-limit kills itself when the limit expires, but we
      // add our own timer in case the limit arg is ignored on some ROMs.
      setTimeout(() => {
        try { void newProc.kill(); } catch { /* ignore */ }
      }, (CHUNK_SECONDS + 1) * 1000);
    } catch (e) {
      console.warn(TAG, "failed to start screenrecord chunk:", e);
    }
  };

  // ── 3. Poll the device file and feed MSE ─────────────────────────────────
  // We poll file size via `wc -c` and read new bytes via `dd skip=N`.
  // Both are one-shot commands that return immediately — unlike
  // `tail -c +N`, which would wait forever for EOF on a file that
  // screenrecord keeps growing.
  //
  // `readSince(startOffset)` returns the bytes [startOffset, EOF] of
  // the device-side file. Each chunk has its own startOffset=0
  // (because we rm the file at the start of each new recording),
  // so the call site advances the offset locally.
  // `wc -c <file>` returns text. Use the ya-webadb short-text idiom:
  // shell.spawn().wait().toString() returns a WaitResult<string>.
  // See lib/adb-client.ts spawnText for the canonical wrapper.
  const wcSize = async (): Promise<number | null> => {
    try {
      const result = await shell.spawn(["wc", "-c", STREAM_PATH]).wait().toString();
      const m = result.stdout.match(/(\d+)/);
      if (!m) return null;
      return parseInt(m[1], 10);
    } catch {
      return null;
    }
  };

  const readBytes = async (
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> => {
    try {
      const dd = await shell.spawn([
        "dd",
        `if=${STREAM_PATH}`,
        `bs=1`,
        `skip=${offset}`,
        `count=${length}`,
      ]);
      const reader = (dd.stdout as unknown as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          chunks.push(value);
          total += value.byteLength;
        }
      } finally {
        reader.releaseLock();
        try { void dd.kill(); } catch { /* ignore */ }
      }
      if (total === 0) return null;
      const safeTotal = Math.min(Math.max(0, total), 256 * 1024 * 1024);
      const merged = new Uint8Array(safeTotal);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      return merged;
    } catch (e) {
      return null;
    }
  };

  const readSince = async (startOffset: number): Promise<Uint8Array | null> => {
    const size = await wcSize();
    if (size === null) return null;
    if (size <= startOffset) return null; // file doesn't have new bytes yet
    // Read [startOffset, size). Cap to ~8MB per poll to avoid huge
    // shell transfers if we fall way behind.
    const want = Math.min(size - startOffset, 8 * 1024 * 1024);
    return await readBytes(startOffset, want);
  };

  // Walk top-level boxes in an mp4 buffer. Returns the byte ranges
  // of the boxes we care about (ftyp, moov, mdat). Each entry is
  // {type, headerOffset, contentOffset, contentLength}. Returns null
  // if the buffer doesn't contain at least ftyp + the start of an
  // mdat header (i.e. not enough yet to call this a valid mp4).
  //
  // Handles both 32-bit size boxes (size=8..2^32-1) and 64-bit
  // largesize boxes (size=1, then largeSize at offset 8..15).
  const walkTopBoxes = (bytes: Uint8Array): Array<{
    type: string;
    headerOffset: number;
    contentOffset: number;
    contentLength: number;
  }> | null => {
    const boxes: Array<{
      type: string;
      headerOffset: number;
      contentOffset: number;
      contentLength: number;
    }> = [];
    let off = 0;
    while (off + 8 <= bytes.length) {
      const size32 =
        (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      let totalSize: number;
      let contentOffset: number;
      if (size32 === 1) {
        // 64-bit largesize. Reading the value into a Number directly
        // loses precision above 2^53 (mdat for a long recording can
        // be hundreds of GB on a 30-min screencast). Use BigInt, then
        // clamp to Number — if the clamp kicks in, the file is bigger
        // than we'll ever read in one poll anyway.
        if (off + 16 > bytes.length) break;
        let big: bigint;
        try {
          big = new DataView(bytes.buffer, bytes.byteOffset + off + 8, 8).getBigUint64(0, false);
        } catch {
          break;
        }
        const MAX = BigInt(Number.MAX_SAFE_INTEGER);
        totalSize = big > MAX ? Number.MAX_SAFE_INTEGER : Number(big);
        contentOffset = off + 16;
      } else if (size32 === 0) {
        // size=0 means "extends to end of file".
        totalSize = bytes.length - off;
        contentOffset = off + 8;
      } else if (size32 < 8) {
        break;
      } else {
        totalSize = size32;
        contentOffset = off + 8;
      }
      if (type === "ftyp" || type === "moov" || type === "mdat") {
        const contentLength = Math.max(0, totalSize - (contentOffset - off));
        boxes.push({
          type,
          headerOffset: off,
          contentOffset,
          contentLength,
        });
      }
      if (off + totalSize > bytes.length) break;
      off += totalSize;
    }
    return boxes.length > 0 ? boxes : null;
  };

  // Extract avcC bytes from moov/stsd/avc1/avcC. Used to derive
  // the codec string for addSourceBuffer.
  const extractAvcCodec = (bytes: Uint8Array, moovStart: number, moovLength: number): string | null => {
    // Walk boxes until we hit avcC, then read its parent avc1's
    // width/height to build the codec string. avc1 has the
    // structure: size(4)+'avc1'(4)+...+width(2)+height(2).
    const findAvcC = (start: number, end: number): Uint8Array | null => {
      let o = start;
      while (o + 8 <= end) {
        const sz =
          (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
        const tp = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
        if (tp === "avc1") {
          // avc1 layout: size(4)+'avc1'(4)+reserved(6)+data_ref_idx(2)+
          //   pre_defined(16)+width(2)+height(2)
          if (o + 36 <= end) {
            const avc1Width = (bytes[o + 32] << 8) | bytes[o + 33];
            const avc1Height = (bytes[o + 34] << 8) | bytes[o + 35];
            console.log(TAG, "avc1 found width=", avc1Width, "height=", avc1Height);
          }
          // Walk into avc1 looking for avcC.
          const innerStart = o + 8;
          const innerEnd = o + sz;
          let io = innerStart;
          while (io + 8 <= innerEnd) {
            const isz =
              (bytes[io] << 24) | (bytes[io + 1] << 16) | (bytes[io + 2] << 8) | bytes[io + 3];
            const itp = String.fromCharCode(bytes[io + 4], bytes[io + 5], bytes[io + 6], bytes[io + 7]);
            if (itp === "avcC") {
              return bytes.subarray(io, io + isz);
            }
            if (isz < 8 || io + isz > innerEnd) break;
            io += isz;
          }
          return null;
        }
        if (sz < 8 || o + sz > end) break;
        o += sz;
      }
      return null;
    };
    const avcC = findAvcC(moovStart, moovStart + moovLength);
    if (!avcC || avcC.length < 8) return null;
    // avcC payload starts at offset 8 in the box (skip size+type).
    // First bytes: configVersion(1)+profileIdc(1)+profileCompat(1)+
    //   levelIdc(1)+lengthSizeMinusOne(1)+numSPS(1)
    const profileIdc = avcC[9];
    const profileCompat = avcC[10];
    const levelIdc = avcC[11];
    const hex = (n: number): string => n.toString(16).toUpperCase().padStart(2, "0");
    // Codec string: avc1.PPCCLL where PP=profile, CC=compat, LL=level
    return `avc1.${hex(profileIdc)}${hex(profileCompat)}${hex(levelIdc)}`;
  };

  let pollCount = 0;
  let lastChunkEndTime = 0; // wall-clock ms of the last chunk's moov appearance

  const startFirstRecording = async (): Promise<void> => {
    await startOneRecording();
    opts.onProgress?.("screenrecord-started");
  };

  opts.onReady?.();
  void startFirstRecording();

  // After init is sent, run a rotation timer: every CHUNK_SECONDS,
  // kill the current screenrecord (so it flushes its moov) and
  // start a new one. The moov from each subsequent chunk is
  // discarded; we just want their mdat content as continuous media
  // samples. Each new file is rm'd at the start of the next, so the
  // poll loop always reads the fresh file from byte 0.
  //
  // The first rotation happens after CHUNK_ROTATION_SECONDS (longer
  // than the recording's --time-limit) to make sure the recording
  // naturally ends on its own and writes moov before we kill it.
  const CHUNK_ROTATION_SECONDS = CHUNK_SECONDS + 2;
  setTimeout(() => {
    if (stopRequested) return;
    void (async () => {
      // Wait until init is sent before starting rotations — we don't
      // want to interrupt the first recording before moov has been
      // shipped.
      while (!stopRequested && !initSegmentSent) {
        await sleep(200);
      }
      while (!stopRequested) {
        await sleep(CHUNK_ROTATION_SECONDS * 1000);
        if (stopRequested) break;
        // Kill the current screenrecord so its moov gets written.
        try { void proc?.kill(); } catch { /* ignore */ }
        // Brief pause so the device flushes the moov.
        await sleep(500);
        // Reset chunkReadOffset so the poll loop reads the new file
        // from byte 0.
        chunkReadOffset = 0;
        // Start a new chunk.
        await startOneRecording();
      }
    })();
  }, 0);

  // chunkReadOffset tracks where we left off reading in the current
  // chunk's file. It starts at 0 (chunk is rm'd before recording
  // starts), advances by the bytes returned from each successful
  // readSince() call. Reset to 0 at the start of every new chunk.
  let chunkReadOffset = 0;

  (async () => {
    // First chunk: wait for moov before doing anything (moov is the
    // only place we get SPS/PPS from).
    while (!stopRequested && !initSegmentSent) {
      await sleep(POLL_INTERVAL_MS);
      const bytes = await readSince(chunkReadOffset);
      if (!bytes || bytes.byteLength === 0) continue;
      pollCount++;
      chunkReadOffset += bytes.byteLength;
      lastReadOffset = chunkReadOffset;
      if (pollCount === 1) {
        console.log(
          TAG,
          "first read, total bytes:",
          bytes.byteLength,
          "hex-prefix:",
          bytes.subarray(0, Math.min(8, bytes.byteLength)),
        );
      }
      processBytes(bytes);
      if (initSegmentSent) {
        // Done with first chunk. Kick off the next one so the
        // recording loop continues.
        chunkReadOffset = 0; // will be reset by the rotation logic
        lastChunkEndTime = Date.now();
      }
    }

    // Continuing chunks: each one starts fresh, runs ~CHUNK_SECONDS,
    // gets killed, writes moov. We poll its file as it grows.
    while (!stopRequested) {
      await sleep(POLL_INTERVAL_MS);
      const readStartOffset = chunkReadOffset;
      const bytes = await readSince(chunkReadOffset);
      if (!bytes || bytes.byteLength === 0) {
        // File empty / not yet created — happens for the first
        // ~100ms after we rm + spawn. Stay quiet unless we haven't
        // seen anything in a while.
        if (pollCount > 0 && pollCount % 16 === 0) {
          console.log(
            TAG,
            "poll",
            pollCount,
            "no new bytes; chunkOffset:",
            chunkReadOffset,
          );
        }
        continue;
      }
      pollCount++;
      chunkReadOffset += bytes.byteLength;
      lastReadOffset = chunkReadOffset;
      // Log every poll for the first 20 then every 4th.
      if (pollCount <= 20 || pollCount % 4 === 0) {
        console.log(
          TAG,
          "poll",
          pollCount,
          "bytes:",
          bytes.byteLength,
          "fromOffset:",
          readStartOffset,
          "chunkOffset:",
          chunkReadOffset,
          "hex-prefix:",
          bytes.subarray(0, Math.min(8, bytes.byteLength)),
        );
      }
      processBytes(bytes);
    }
  })().catch((e) => {
    if (!stopRequested) {
      console.error(TAG, "poll loop crashed:", e);
      opts.onError(`screencast poll loop crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // screenrecord writes ftyp + mdat during recording, and only writes
  // moov at end-of-recording. We can't start MSE playback until
  // moov is present (SPS/PPS live in moov/avcC — no way to derive
  // them from mdat bytes alone). Strategy:
  //
  //   - If moov is present in this poll's bytes, we have everything
  //     we need: send ftyp+moov as the init segment, then send any
  //     mdat content from this poll + buffered mdat bytes from
  //     earlier polls as media chunks.
  //   - If moov is not present, append the mdat content to a local
  //     buffer and wait for the next poll. Continue polling — once
  //     moov finally appears (at recording end), we ship everything.
  //   - After init is sent, subsequent polls contain only mdat
  //     content (mdat is appended-to, never re-written), and we
  //     stream them straight to MSE.
  function processBytes(bytes: Uint8Array): void {
    const boxes = walkTopBoxes(bytes);
    if (!boxes) {
      // Not yet a valid mp4 — wait for next poll.
      return;
    }
    const ftyp = boxes.find((b) => b.type === "ftyp");
    const moov = boxes.find((b) => b.type === "moov");
    const mdat = boxes.find((b) => b.type === "mdat");
    if (!ftyp) {
      // No ftyp yet — wait.
      return;
    }
    if (!mdat) {
      // No mdat content yet — wait.
      return;
    }

    if (!initSegmentSent) {
      // Before moov is present, buffer mdat content locally. We
      // can't send anything to MSE yet (no SPS/PPS to put in the
      // init segment), but we don't want to lose these bytes either.
      if (!moov) {
        const available = Math.max(0, bytes.length - mdat.contentOffset);
        const safeLength = Math.min(mdat.contentLength, available);
        if (safeLength > 0) {
          // Copy because the input buffer can be reused by ReadableStream.
          const copy = new Uint8Array(safeLength);
          copy.set(bytes.subarray(mdat.contentOffset, mdat.contentOffset + safeLength));
          pendingMdat.push(copy);
          pendingMdatTotal += copy.byteLength;
        }
        console.log(
          TAG,
          "buffering mdat (no moov yet), buffered total:",
          pendingMdatTotal,
          "bytes,",
          "boxes:",
          dumpMp4Boxes(bytes),
        );
        return;
      }

      // moov is here — time to ship the init segment.
      const moovBoxEnd = moov.headerOffset + moov.contentLength + 8;
      const initBuf = bytes.subarray(0, moovBoxEnd);
      const codec = extractAvcCodec(bytes, moov.contentOffset, moov.contentLength);
      console.log(
        TAG,
        "init segment parsed, codec:",
        codec,
        "init bytes:",
        initBuf.byteLength,
        "moov at:",
        moov.headerOffset,
        "boxes:",
        dumpMp4Boxes(initBuf),
      );

      // Combine mdat content from this poll with previously-buffered
      // mdat content. Send everything as one big first-frame chunk so
      // MSE has the full IDR + a few P-slices for the first paint.
      const available = Math.max(0, bytes.length - mdat.contentOffset);
      const safeContentLength = Math.max(0, Math.min(mdat.contentLength, available));
      const safePendingTotal = Math.max(0, pendingMdatTotal);
      const totalMdatBytes = safePendingTotal + safeContentLength;
      if (totalMdatBytes <= 0) {
        // Nothing to send — just initialize SourceBuffer and stop.
        pendingMdat = [];
        pendingMdatTotal = 0;
        return;
      }
      const firstMdat = new Uint8Array(totalMdatBytes);
      let pos = 0;
      for (const buf of pendingMdat) {
        firstMdat.set(buf, pos);
        pos += buf.byteLength;
      }
      if (safeContentLength > 0) {
        firstMdat.set(
          bytes.subarray(mdat.contentOffset, mdat.contentOffset + safeContentLength),
          pos,
        );
      }
      pendingMdat = [];
      pendingMdatTotal = 0;

      // Schedule addSourceBuffer + appendBuffer once the source is open.
      sourceOpenPromise.then(() => {
        if (stopRequested) return;
        try {
          const mime = codec ? `video/mp4; codecs="${codec}"` : "video/mp4";
          sourceBuffer = mediaSource.addSourceBuffer(mime);
          console.log(TAG, "addSourceBuffer succeeded, codec:", codec);
          sourceBuffer.addEventListener("error", (ev) => {
            const code =
              (sourceBuffer as unknown as { code?: string })?.code ?? "unknown";
            const bufferedRanges =
              sourceBuffer && sourceBuffer.buffered.length > 0
                ? `${sourceBuffer.buffered.start(0).toFixed(2)} - ${sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1).toFixed(2)}`
                : "(empty)";
            console.error(
              TAG,
              "SourceBuffer error event — code:",
              code,
              "updating:",
              sourceBuffer?.updating,
              "buffered:",
              bufferedRanges,
              "ev:",
              ev,
            );
            opts.onError(
              `SourceBuffer error: code=${code}, updating=${sourceBuffer?.updating}, buffered=${bufferedRanges}`,
            );
          });
          sourceBuffer.addEventListener("updateend", () => {
            drainPending();
            if (sourceBuffer && sourceBuffer.buffered.length > 0) {
              if (!playbackStarted) {
                playbackStarted = true;
                console.log(
                  TAG,
                  "SourceBuffer updateend after init, buffered:",
                  `${sourceBuffer.buffered.start(0).toFixed(2)} - ${sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1).toFixed(2)}`,
                );
                if (videoEl.paused && videoEl.buffered.length > 0) {
                  const targetTime =
                    videoEl.buffered.end(videoEl.buffered.length - 1) - 0.05;
                  if (targetTime > videoEl.currentTime) {
                    try {
                      videoEl.currentTime = Math.max(0, targetTime);
                    } catch {
                      /* ignore */
                    }
                  }
                  videoEl.addEventListener(
                    "playing",
                    () => {
                      console.log(TAG, "video.playing event fired");
                      opts.onProgress?.("playing");
                    },
                    { once: true },
                  );
                  void videoEl.play().catch((e) => {
                    console.warn(TAG, "videoEl.play() rejected:", e);
                  });
                }
              }
            }
          });
          // Send init segment.
          const initCopy = new ArrayBuffer(initBuf.byteLength);
          new Uint8Array(initCopy).set(initBuf);
          appendBuffer(initCopy);
          opts.onProgress?.("init", `${initCopy.byteLength} bytes`);
        } catch (e) {
          console.error(TAG, "addSourceBuffer FAILED", codec, e);
          opts.onError(
            `addSourceBuffer failed (codec ${codec}): ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return;
        }
        // After init, send the first mdat content (could be a lot —
        // every byte we accumulated during the wait-for-moov phase).
        if (firstMdat.byteLength > 0) {
          const m = new ArrayBuffer(firstMdat.byteLength);
          new Uint8Array(m).set(firstMdat);
          appendBuffer(m);
          opts.onProgress?.("first-frame", `${m.byteLength} bytes`);
        }
        initSegmentSent = true;
      });
    } else {
      // init already sent — subsequent polls are pure mdat content.
      const available = Math.max(0, bytes.length - mdat.contentOffset);
      const safeLength = Math.max(0, Math.min(mdat.contentLength, available));
      if (safeLength <= 0) return;
      const m = new ArrayBuffer(safeLength);
      new Uint8Array(m).set(
        bytes.subarray(mdat.contentOffset, mdat.contentOffset + safeLength),
      );
      appendBuffer(m);
    }
  }

  let playbackStarted = false;

  return {
    bitrate,
    encodedWidth,
    encodedHeight,
    stop: () => {
      if (stopRequested) return;
      stopRequested = true;
      try { void proc?.kill(); } catch { /* ignore */ }
      try {
        if (mediaSource.readyState === "open") {
          try {
            mediaSource.endOfStream();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
      try {
        videoEl.removeAttribute("src");
        videoEl.load();
      } catch {
        /* ignore */
      }
      // Clean up device-side file.
      try {
        shell.spawn(["rm", "-f", STREAM_PATH]).wait().catch(() => {});
      } catch { /* ignore */ }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dumpMp4Boxes(bytes: Uint8Array): string {
  const out: string[] = [];
  let off = 0;
  while (off + 8 <= bytes.length) {
    const size =
      (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (size === 0) {
      out.push(`${type}(to-end @${off})`);
      break;
    }
    if (size === 1) {
      if (off + 16 > bytes.length) {
        out.push(`${type}(largeSize-truncated @${off})`);
        break;
      }
      const hi = (bytes[off + 8] << 24) | (bytes[off + 9] << 16) | (bytes[off + 10] << 8) | bytes[off + 11];
      const lo = (bytes[off + 12] << 24) | (bytes[off + 13] << 16) | (bytes[off + 14] << 8) | bytes[off + 15];
      const large = hi * 0x100000000 + lo;
      out.push(`${type}(${large} @${off})`);
      off += large;
      continue;
    }
    if (size < 8 || off + size > bytes.length) {
      out.push(`${type}(bad-size ${size} @${off})`);
      break;
    }
    out.push(`${type}(${size} @${off})`);
    off += size;
  }
  if (off < bytes.length) {
    out.push(`<trailing ${bytes.length - off} bytes>`);
  }
  return out.join(", ");
}

export async function getDeviceScreenSize(
  session: AdbSession,
): Promise<{ width: number; height: number } | null> {
  try {
    const shell = session.adb.subprocess.shellProtocol;
    if (!shell || !shell.isSupported) return null;
    const proc = await shell.spawn(["wm", "size"]);
    const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let out = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      out += decoder.decode();
    } finally {
      reader.releaseLock();
      try { void proc.kill(); } catch { /* ignore */ }
    }
    const match = /Physical size:\s*(\d+)x(\d+)/.exec(out);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return null;
  }
}

export async function injectInput(
  session: AdbSession,
  cmd:
    | { kind: "tap"; x: number; y: number }
    | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs: number }
    | { kind: "keyevent"; code: number },
): Promise<void> {
  let args: string[];
  switch (cmd.kind) {
    case "tap":
      args = ["input", "tap", String(cmd.x | 0), String(cmd.y | 0)];
      break;
    case "swipe":
      args = [
        "input",
        "swipe",
        String(cmd.x1 | 0),
        String(cmd.y1 | 0),
        String(cmd.x2 | 0),
        String(cmd.y2 | 0),
        String(cmd.durationMs | 0),
      ];
      break;
    case "keyevent":
      args = ["input", "keyevent", String(cmd.code | 0)];
      break;
  }
  const shell = session.adb.subprocess.shellProtocol;
  if (!shell || !shell.isSupported) throw new Error("Device doesn't support Shell V2 protocol");
  shell.spawn(args).wait().catch(() => {});
}