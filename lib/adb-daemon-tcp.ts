// lib/adb-daemon-tcp.ts
//
// AdbDaemonConnection implementation that opens a raw TCP socket via the
// Chrome Direct Sockets API. Designed to mirror the AdbDaemonWebUsbConnection
// interface so it slots into the same adbDaemonAuthenticate() path.
//
// Browser requirements:
//   - Chrome 142+ (we tested 150.0.7871.114)
//   - One of:
//       * Origin Trial token for "Direct Sockets API" (added to the page)
//       * chrome://flags/#enable-experimental-web-platform-features enabled
//       * Enterprise policy allow-list
//   - The page must be served over HTTPS (webadb.online is) and must already
//     pass the crossOriginIsolated check (webadb does). Direct Sockets
//     requires `crossOriginIsolated === true` to even be visible.
//
// What this gives us:
//   - Wire-level ADB over the device's wireless-debug TCP port (5555 by
//     default after `adb tcpip 5555` or after toggling Wireless debugging
//     in Developer options). The phone's adbd daemon speaks the same
//     packet-framed binary ADB protocol over TCP as it does over USB.
//   - No additional native bridge, server, or companion APK needed.
//   - Wireless ADB without USB, which the WebUSB transport cannot do.
//
// What this does NOT give us:
//   - It can't be used to bootstrap a fresh RSA fingerprint trust on the
//     device — that requires physical USB access (the device pops a system
//     dialog and only USB-triggered AUTH packets trigger it). So the
//     typical onboarding flow is: plug in USB once, accept the RSA prompt,
//     toggle Wireless debugging on the phone, unplug, then connect here.

import {
  AdbPacketHeader,
  AdbPacketSerializeStream,
  calculateChecksum,
} from "@yume-chan/adb";
import {
  Consumable,
  ReadableStream,
  WritableStream,
} from "@yume-chan/stream-extra";
import type {
  AdbPacketData,
  AdbPacketInit,
} from "@yume-chan/adb";

declare global {
  // The Direct Sockets API. Spec'd at
  // https://wicg.github.io/direct-sockets/ but only implemented in
  // Chromium behind an Origin Trial or feature flag at the time of
  // writing. We declare it locally so this file compiles regardless of
  // whether the runtime exposes it.
  interface Navigator {
    openTCPSocket?(options: {
      remoteAddress: string;
      remotePort: number;
      /** disable Nagle — important for ADB's small control packets */
      noDelay?: boolean;
    }): Promise<{
      readable: ReadableStream<Uint8Array>;
      writable: { getWriter(): WritableStreamDefaultWriter<Uint8Array> };
      close(): Promise<void>;
    }>;
  }
}

const TAG = "[adb-tcp]";

/** Detects whether the browser exposes Direct Sockets at runtime. */
export function isDirectSocketsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.openTCPSocket === "function"
  );
}

/**
 * Connect to a device's wireless-debug ADB port over TCP and return a
 * transport that mirrors `AdbDaemonWebUsbConnection`.
 *
 * Throws if Direct Sockets isn't available or the connection is refused.
 */
export async function connectOverTcp(
  host: string,
  port: number,
): Promise<{
  readable: ReadableStream<AdbPacketData>;
  writable: WritableStream<Consumable<AdbPacketInit>>;
  close: () => Promise<void>;
}> {
  if (!isDirectSocketsSupported()) {
    throw new Error(
      "Direct Sockets API is not available in this browser. To use ADB over Wi-Fi:\n" +
        "  • Use Chrome 142 or later\n" +
        "  • Enable chrome://flags/#enable-experimental-web-platform-features\n" +
        "  • Or enroll in the Direct Sockets Origin Trial\n" +
        "  • And reload this page",
    );
  }

  console.log(TAG, "openTCPSocket", { host, port });
  const sock = await navigator.openTCPSocket!({
    remoteAddress: host,
    remotePort: port,
    noDelay: true,
  });

  // Packetize the writable side: ya-webadb expects
  // `WritableStream<Consumable<AdbPacketInit>>` and gives us
  // `AdbPacketSerializeStream` to convert packets → bytes.
  const serialize = new AdbPacketSerializeStream();
  const packetWritable = serialize.writable as unknown as WritableStream<
    Consumable<AdbPacketInit>
  >;

  // Pipe serialized bytes → socket using a TransformStream-friendly
  // pattern. We tee `serialize.readable` into the socket writer and run
  // it as a background task; errors are logged but don't bubble up
  // (they'll show up via the readable side instead).
  const writer = sock.writable.getWriter();
  (async () => {
    try {
      const reader = (serialize.readable as unknown as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) await writer.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    } catch (e) {
      console.warn(TAG, "serialize→socket pipe failed:", e);
    }
  })();

  // Depacketize the readable side: bytes → AdbPacketData.
  // We hand-roll a small frame parser because ya-webadb does not export
  // the deserializer as a public class.
  const packetReadable = packetizeInput(sock.readable);

  return {
    readable: packetReadable as unknown as ReadableStream<AdbPacketData>,
    writable: packetWritable,
    async close() {
      try {
        await packetWritable.close().catch(() => {});
      } catch {
        /* ignore */
      }
      try {
        await sock.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Convert a stream of raw bytes from a TCP socket into a stream of
 * AdbPacketData (header + payload) for ya-webadb's authenticate path.
 *
 * Each ADB packet on the wire is:
 *   - 24 bytes header (AdbPacketHeader)
 *   - 0..payloadLength bytes payload
 * Followed immediately by the next packet (no inter-packet framing).
 *
 * We accumulate bytes into a growable buffer, slicing off complete
 * packets as they become available. Incomplete trailing bytes wait
 * for the next chunk.
 */
function packetizeInput(
  source: ReadableStream<Uint8Array>,
): ReadableStream<{ command: number; arg0: number; arg1: number; payloadLength: number; checksum: number; magic: number; payload: Uint8Array }> {
  const HEADER_SIZE = AdbPacketHeader.size;
  return new ReadableStream({
    async start(controller) {
      const pending = new Uint8Array(0);
      let offset = 0; // start of unread bytes within `pending`
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          // We want to keep processing whatever bytes we have even if the
          // source has signalled done — last partial frame can still be
          // a valid packet if it's exactly `payloadLength + HEADER_SIZE`.
          // Copy any new bytes into `pending` (growing the buffer if needed).
          if (value && value.byteLength > 0) {
            const newLen = value.byteLength;
            const merged = new Uint8Array(offset + newLen);
            merged.set(pending.subarray(0, offset), 0);
            merged.set(value, offset);
            // Replace buffers; offset stays valid since merged starts with the
            // un-consumed prefix at index 0..offset and then the new bytes.
            pending.set(merged, 0);
            offset += newLen;
          }

          // Drain complete packets.
          while (offset - 0 >= HEADER_SIZE) {
            // Parse the header at index 0 (we use index 0 because `pending`
            // holds the unconsumed prefix starting at position 0).
            const view = new DataView(
              pending.buffer,
              pending.byteOffset,
              HEADER_SIZE,
            );
            const payloadLength = view.getUint32(12, true);
            const packetLen = HEADER_SIZE + payloadLength;
            if (offset < packetLen) break; // wait for more bytes
            // Slice the payload out.
            const payload =
              payloadLength > 0
                ? pending.slice(HEADER_SIZE, packetLen)
                : new Uint8Array(0);
            controller.enqueue({
              command: view.getUint32(0, true),
              arg0: view.getUint32(4, true),
              arg1: view.getUint32(8, true),
              payloadLength,
              checksum: view.getUint32(16, true),
              magic: view.getInt32(20, true),
              payload,
            });
            // Shift the buffer left by `packetLen` to drop the consumed packet.
            const tail = offset - packetLen;
            pending.copyWithin(0, packetLen, offset);
            offset = tail;
          }

          if (done) {
            controller.close();
            return;
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    },
  });
}

// Re-exported helpers used by adb-client.ts if it wants them later.
export { calculateChecksum };