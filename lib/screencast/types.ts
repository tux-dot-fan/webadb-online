// ── Screencast protocol types ────────────────────────────────────────────────
//
// Message types passed between the main-thread panel and the Web Worker.
// Keep this file dependency-free so it can be imported from both
// threads without bundler headaches.

/** Sent from the panel to the worker to (re)start a screencast session. */
export interface StartMsg {
  type: "start";
  /** Encoded frame width in pixels (even). */
  width: number;
  /** Encoded frame height in pixels (even). */
  height: number;
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
}

/** Sent from the worker to the panel when the worker is initialized. */
export interface ReadyMsg {
  type: "ready";
  streamId: number;
}

/**
 * Sent from the worker to the panel once the SPS/PPS have been parsed
 * out of the stream. The init segment is the ftyp+moov box that
 * `SourceBuffer.appendBuffer()` needs before any media segments.
 *
 * `codec` is the codec string for MSE's `addSourceBuffer()` call,
 * e.g. `avc1.640028`.
 */
export interface InitMsg {
  type: "init";
  streamId: number;
  /** Codec string for the MSE SourceBuffer, e.g. `avc1.640028`. */
  codec: string;
  /** ftyp+moov box bytes. Transferable. */
  init: ArrayBuffer;
}

/**
 * Sent from the worker to the panel for each new moof+mdat fragment.
 * The main thread feeds it to `SourceBuffer.appendBuffer()`.
 */
export interface MediaMsg {
  type: "media";
  streamId: number;
  /** fMP4 moof+mdat box bytes. Transferable. */
  buffer: ArrayBuffer;
}

/** Sent from the worker to the panel when something goes wrong. */
export interface ErrorMsg {
  type: "error";
  streamId: number;
  message: string;
}

/**
** Pipeline progress event. Emitted by the pipeline at each
** transition: spawn → first chunk → first IDR → first frame → first
** frame rendered. Lets the panel show a step-by-step overlay
** instead of a single "Starting…" spinner.
*/
export type ProgressKind =
  | "spawning"        // about to call shell.spawn(screenrecord)
  | "screenrecord-started"  // spawn returned, stdout is open
  | "first-chunk"     // first H.264 chunk landed in the worker
  | "config-parsed"   // SPS/PPS extracted, codec known
  | "init-sent"       // ftyp+moov appended to SourceBuffer
  | "first-frame"     // first moof+mdat appended
  | "playing";        // video.play() resolved (first frame on screen)

export interface ProgressMsg {
  type: "progress";
  streamId: number;
  kind: ProgressKind;
  /** Optional human-readable detail (e.g. "avc1.640028, 360x800"). */
  detail?: string;
}

/** All messages that flow through the worker port. */
export type WorkerInbound = StartMsg | StopMsg | ChunkMsg;
export type WorkerOutbound =
  | ReadyMsg
  | InitMsg
  | MediaMsg
  | ErrorMsg
  | ProgressMsg;