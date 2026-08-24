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

  // No muxer — we'll feed MSE the device's own init segment +
  // mdat chunks. We defer codec string extraction until we've
  // parsed moov/avc1.
  let initSegmentSent = false;
  let mdatOffset = 0;
  let lastReadOffset = 0;

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
  let killFn: (() => void) | null = null;

  // Clean up any leftover file from a previous run.
  try {
    const clean = shell.spawn(["rm", "-f", STREAM_PATH]);
    await clean.wait();
  } catch {
    /* ignore — rm is best-effort */
  }

  const timeLimit = 180;
  const proc = await shell.spawn([
    "screenrecord",
    "--size", `${encodedWidth}x${encodedHeight}`,
    "--bit-rate", String(Math.max(200_000, bitrate | 0)),
    "--time-limit", String(timeLimit),
    STREAM_PATH,
  ]);
  console.log(TAG, "screenrecord spawned, waiting for first file write");
  opts.onProgress?.("screenrecord-started");
  killFn = () => {
    try { void proc.kill(); } catch { /* ignore */ }
  };

  opts.onReady?.();

  // ── 3. Poll the device file and feed MSE ─────────────────────────────────
  // We use tail -c +N to read bytes from offset N to EOF. tail is
  // a one-shot (not -f) so it terminates after EOF — which is what
  // we want, because the file is constantly growing and we want
  // each poll to return just the new bytes.
  const pollOnce = async (): Promise<Uint8Array | null> => {
    try {
      const tail = await shell.spawn([
        "tail",
        "-c",
        `+${lastReadOffset + 1}`,
        STREAM_PATH,
      ]);
      const reader = (tail.stdout as unknown as ReadableStream<Uint8Array>).getReader();
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
        try { void tail.kill(); } catch { /* ignore */ }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      return merged;
    } catch (e) {
      console.warn(TAG, "poll failed:", e);
      return null;
    }
  };

  // Walk top-level boxes in an mp4 buffer. Returns the first byte
  // offset past ftyp + moov (i.e. start of mdat), or null if we
  // haven't seen mdat yet.
  const findMdatOffset = (bytes: Uint8Array): number | null => {
    let off = 0;
    while (off + 8 <= bytes.length) {
      const size =
        (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (type === "mdat") return off;
      if (size < 8 || off + size > bytes.length) break;
      off += size;
    }
    return null;
  };

  // Extract avcC bytes from moov/stsd/avc1/avcC. Used to derive
  // the codec string for addSourceBuffer.
  const extractAvcCodec = (bytes: Uint8Array, mdatStart: number): string | null => {
    // Walk boxes until we hit avcC, then read its parent avc1's
    // width/height to build the codec string. avc1 has the
    // structure: size(4)+'avc1'(4)+...+width(2)+height(2).
    let off = 0;
    let avc1Width = 0;
    let avc1Height = 0;
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
            avc1Width = (bytes[o + 32] << 8) | bytes[o + 33];
            avc1Height = (bytes[o + 34] << 8) | bytes[o + 35];
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
    const avcC = findAvcC(off, mdatStart);
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

  (async () => {
    // Wait until screenrecord has produced something.
    while (!stopRequested && lastReadOffset === 0) {
      await sleep(100);
      const bytes = await pollOnce();
      if (bytes && bytes.byteLength > 0) {
        lastReadOffset = bytes.byteLength;
        pollCount++;
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
        break;
      }
    }

    // Continue polling for new bytes.
    while (!stopRequested) {
      await sleep(POLL_INTERVAL_MS);
      const bytes = await pollOnce();
      if (!bytes || bytes.byteLength === 0) continue;
      pollCount++;
      lastReadOffset += bytes.byteLength;
      if (pollCount % 4 === 0) {
        console.log(
          TAG,
          "poll",
          pollCount,
          "+",
          bytes.byteLength,
          "bytes",
          "total:",
          lastReadOffset,
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

  // Each chunk we read is either:
  //   - the very first read (contains ftyp + moov + start of mdat):
  //     send ftyp+moov as init segment, queue mdat content as media
  //   - subsequent reads: pure mdat content, append to SourceBuffer
  // We assume screenrecord writes the boxes once and never rewrites
  // them (true for vanilla AOSP screenrecord 1.4 — it fsyncs the
  // moov after recording finishes; during recording it only writes
  // mdat). Once we've identified the mdat offset, all later reads
  // are pure media bytes.
  function processBytes(bytes: Uint8Array): void {
    if (!initSegmentSent) {
      // First read: must contain at least ftyp + moov + mdat header.
      const mdatStart = findMdatOffset(bytes);
      if (mdatStart === null) {
        // Not enough yet — wait for next poll.
        // But lastReadOffset was already incremented, so rewind.
        lastReadOffset -= bytes.byteLength;
        return;
      }
      // Build the init segment: ftyp + moov.
      const initBuf = bytes.subarray(0, mdatStart);
      const codec = extractAvcCodec(bytes, mdatStart);
      console.log(
        TAG,
        "init segment parsed, codec:",
        codec,
        "init bytes:",
        initBuf.byteLength,
        "mdat starts at:",
        mdatStart,
        "boxes:",
        dumpMp4Boxes(initBuf),
      );
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
        // After init, send any mdat content already read.
        if (mdatStart + 8 < bytes.byteLength) {
          const firstMedia = bytes.subarray(mdatStart + 8);
          if (firstMedia.byteLength > 0) {
            const m = new ArrayBuffer(firstMedia.byteLength);
            new Uint8Array(m).set(firstMedia);
            appendBuffer(m);
            opts.onProgress?.("first-frame", `${m.byteLength} bytes`);
          }
        }
        mdatOffset = mdatStart;
        initSegmentSent = true;
      });
    } else {
      // Subsequent reads: pure mdat content (8-byte header was
      // already consumed with the first chunk's mdat).
      if (bytes.byteLength === 0) return;
      const m = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(m).set(bytes);
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
      try { killFn?.(); } catch { /* ignore */ }
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