// ── Screencast protocol types ────────────────────────────────────────────────
//
// Message types passed between the main-thread panel and the Web Worker
// that hosts the VideoDecoder. Keep this file dependency-free so it
// can be imported from both threads without bundler headaches.

/** Sent from the panel to the worker to (re)start a screencast session. */
export interface StartMsg {
  type: "start";
  /** Encoded frame width in pixels (even). */
  width: number;
  /** Encoded frame height in pixels (even). */
  height: number;
  /** Encoded bitrate in bits/second. */
  bitRate: number;
  /** Stream ID echoed back in worker messages so the panel can route. */
  streamId: number;
}

/** Sent from the panel to the worker to stop the current session. */
export interface StopMsg {
  type: "stop";
  streamId: number;
}

/** Sent from the panel to the worker to push another H.264 chunk. */
export interface ChunkMsg {
  type: "chunk";
  streamId: number;
  /** H.264 annex-B byte chunk, as-is from screenrecord stdout. */
  data: ArrayBuffer;
  /** True if this is the last chunk the panel will send (process exited). */
  eos?: boolean;
}

/** Sent from the worker to the panel when a new VideoFrame is decoded. */
export interface FrameMsg {
  type: "frame";
  streamId: number;
  /** The frame's presentation timestamp in microseconds. */
  timestamp: number;
  /** Pixel width of the decoded frame. */
  width: number;
  /** Pixel height of the decoded frame. */
  height: number;
  /** The frame's image data, transferred (zero-copy). */
  bitmap: ImageBitmap;
}

/** Sent from the worker to the panel when something goes wrong. */
export interface ErrorMsg {
  type: "error";
  streamId: number;
  message: string;
}

/** Sent from the worker to the panel when the decoder is ready. */
export interface ReadyMsg {
  type: "ready";
  streamId: number;
}

/** All messages that flow through the worker port. */
export type WorkerInbound = StartMsg | StopMsg | ChunkMsg;
export type WorkerOutbound = FrameMsg | ErrorMsg | ReadyMsg;
