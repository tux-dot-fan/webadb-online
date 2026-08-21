// ── Minimal fMP4 muxer (custom, ~200 lines, no deps) ────────────────────────
//
// We stopped using mp4-muxer because its StreamTarget writer only
// emits onData when it finalizes a fragment, and fragment finali-
// zation only triggers after ≥1 second of keyframe samples have
// accumulated (line 1730 of mp4-muxer.mjs). For live streaming
// that's unacceptable latency.
//
// Our own writer just emits one ftyp+moov init segment followed by
// (moof+mdat) fragments, one per H.264 chunk. Each fragment carries
// a single sample with a duration flag in trun, which is enough for
// MSE to decode.
//
// References:
//   ISO/IEC 14496-12 (ISO Base Media File Format)
//   ISO/IEC 14496-15 (AVC file format)

const TAG = "[fmp4-muxer]";

export interface Fmp4MuxerOptions {
  width: number;
  height: number;
  timescale: number;
  onInit: (initBuf: ArrayBuffer) => void;
  onMedia: (mediaBuf: ArrayBuffer) => void;
}

export class Fmp4Muxer {
  private readonly opts: Fmp4MuxerOptions;
  private initSent = false;
  private sequenceNumber = 1;
  private readonly timescale: number;

  constructor(opts: Fmp4MuxerOptions) {
    this.opts = opts;
    this.timescale = opts.timescale;
  }

  /** Build + emit the ftyp + moov init segment from avcC bytes. */
  setCodec(avcC: Uint8Array): void {
    if (this.initSent) return;
    console.log(TAG, "setCodec: avcC.length =", avcC.length);
    let ftyp: Uint8Array;
    let moov: Uint8Array;
    try {
      ftyp = buildFtyp();
      console.log(TAG, "ftyp built:", ftyp.length);
      moov = buildMoov(
        this.opts.width,
        this.opts.height,
        avcC,
        this.timescale,
      );
      console.log(TAG, "moov built:", moov.length);
    } catch (e) {
      console.error(TAG, "buildMoov FAILED:", e);
      throw e;
    }
    const init = concatBytes(ftyp, moov);
    this.initSent = true;
    console.log(
      TAG,
      "init segment built:",
      init.byteLength,
      "bytes (ftyp",
      ftyp.length,
      "+ moov",
      moov.length,
      ")",
    );
    const initBuffer = init.buffer;
    const sliced = initBuffer instanceof ArrayBuffer
      ? initBuffer.slice(0)
      : new ArrayBuffer(init.byteLength);
    if (!(initBuffer instanceof ArrayBuffer)) {
      new Uint8Array(sliced).set(init);
    }
    this.opts.onInit(sliced);
  }

  /** Add a single H.264 chunk (annex-B). Emits one (moof+mdat). */
  addChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
  ): void {
    if (!this.initSent) return;
    const seq = this.sequenceNumber++;
    const baseDecodeTime = Math.round(
      (timestampUs / 1_000_000) * this.timescale,
    );
    const fragment = buildFragment(
      data,
      type === "key",
      seq,
      baseDecodeTime,
      this.timescale,
    );
    const fragBuffer = fragment.buffer;
    const slicedFrag = fragBuffer instanceof ArrayBuffer
      ? fragBuffer.slice(0)
      : new ArrayBuffer(fragment.byteLength);
    if (!(fragBuffer instanceof ArrayBuffer)) {
      new Uint8Array(slicedFrag).set(fragment);
    }
    this.opts.onMedia(slicedFrag);
  }
}

// ── ftyp ─────────────────────────────────────────────────────────────────────
function buildFtyp(): Uint8Array {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 32, false);
  ascii(buf, 4, "ftyp");
  ascii(buf, 8, "isom");
  view.setUint32(12, 512, false);
  ascii(buf, 16, "isom");
  ascii(buf, 20, "iso2");
  ascii(buf, 24, "avc1");
  ascii(buf, 28, "mp41");
  return buf;
}

// ── moov ────────────────────────────────────────────────────────────────────
function buildMoov(
  width: number,
  height: number,
  avcC: Uint8Array,
  timescale: number,
): Uint8Array {
  const log = (s: string) => { console.log(TAG, "[buildMoov]", s); };
  log(`width=${width} height=${height} avcC=${avcC.length} timescale=${timescale}`);
  // mvhd 108 bytes
  const mvhd = new Uint8Array(108);
  const mvhdView = new DataView(mvhd.buffer);
  mvhdView.setUint32(0, 108, false);
  ascii(mvhd, 4, "mvhd");
  mvhdView.setUint32(8, 0, false); // version + flags
  mvhdView.setUint32(12, 0, false); // creation_time
  mvhdView.setUint32(16, 0, false); // modification_time
  mvhdView.setUint32(20, timescale, false);
  mvhdView.setUint32(24, 0, false); // duration = 0 for live
  mvhdView.setUint32(28, 0x00010000, false); // rate 1.0
  mvhdView.setUint16(32, 0x0100, false); // volume 1.0
  // reserved 10 bytes zeroed (offset 34..43)
  // unity matrix (9 x 4 bytes = 36 bytes) at offset 44..79
  mvhdView.setUint32(44, 0x00010000, false);
  mvhdView.setUint32(60, 0x00010000, false);
  mvhdView.setUint32(76, 0x40000000, false);
  // pre_defined 24 bytes zeroed (offset 80..103)
  mvhdView.setUint32(104, 2, false); // next_track_id

  // tkhd 92 bytes
  const tkhd = new Uint8Array(92);
  const tkhdView = new DataView(tkhd.buffer);
  tkhdView.setUint32(0, 92, false);
  ascii(tkhd, 4, "tkhd");
  tkhdView.setUint32(8, 0x000007, false); // enabled | in_movie | in_preview
  tkhdView.setUint32(12, 0, false); // creation_time
  tkhdView.setUint32(16, 0, false); // modification_time
  tkhdView.setUint32(20, 1, false); // track_id
  tkhdView.setUint32(24, 0, false); // reserved
  tkhdView.setUint32(28, 0, false); // duration
  tkhdView.setUint16(40, 0, false); // layer
  tkhdView.setUint16(42, 0, false); // alternate_group
  tkhdView.setUint16(44, 0, false); // volume
  tkhdView.setUint16(46, 0, false); // reserved
  tkhdView.setUint32(48, 0x00010000, false); // matrix
  tkhdView.setUint32(64, 0x00010000, false);
  tkhdView.setUint32(80, 0x40000000, false);
  tkhdView.setUint32(84, width << 16, false); // width 16.16
  tkhdView.setUint32(88, height << 16, false); // height 16.16

  // mdhd 32 bytes
  const mdhd = new Uint8Array(32);
  const mdhdView = new DataView(mdhd.buffer);
  mdhdView.setUint32(0, 32, false);
  ascii(mdhd, 4, "mdhd");
  mdhdView.setUint32(8, 0, false);
  mdhdView.setUint32(12, 0, false);
  mdhdView.setUint32(16, 0, false);
  mdhdView.setUint32(20, timescale, false);
  mdhdView.setUint32(24, 0, false); // duration
  mdhdView.setUint16(28, 0x55c4, false); // language (und)
  mdhdView.setUint16(30, 0, false);

  // hdlr 33 bytes
  const hdlr = new Uint8Array(33);
  const hdlrView = new DataView(hdlr.buffer);
  hdlrView.setUint32(0, 33, false);
  ascii(hdlr, 4, "hdlr");
  hdlrView.setUint32(8, 0, false);
  hdlrView.setUint32(12, 0, false);
  ascii(hdlr, 16, "vide");
  hdlr[32] = 0; // name (empty)

  // vmhd 20 bytes
  const vmhd = new Uint8Array(20);
  const vmhdView = new DataView(vmhd.buffer);
  vmhdView.setUint32(0, 20, false);
  ascii(vmhd, 4, "vmhd");
  vmhdView.setUint32(8, 1, false); // flags: no_lean_ahead
  // graphicsmode (2) + opcolor (2+2+2) zeroed at 12..19

  // url 12 bytes
  const url = new Uint8Array(12);
  const urlView = new DataView(url.buffer);
  urlView.setUint32(0, 12, false);
  ascii(url, 4, "url ");
  urlView.setUint32(8, 1, false); // self-contained

  // dref 28 bytes (12 header + 1 entry_count + 12 url + 4 entry_count? no)
  //   full box header: 4 size + 4 type + 4 version+flags = 12
  //   + 4 entry_count
  //   + url (12) = 28
  const dref = new Uint8Array(28);
  const drefView = new DataView(dref.buffer);
  drefView.setUint32(0, 28, false);
  ascii(dref, 4, "dref");
  drefView.setUint32(8, 0, false); // version
  drefView.setUint32(12, 1, false); // entry_count
  dref.set(url, 16);

  // dinf 12 + 28 = 40 bytes
  const dinf = new Uint8Array(40);
  const dinfView = new DataView(dinf.buffer);
  dinfView.setUint32(0, 40, false);
  ascii(dinf, 4, "dinf");
  dinf.set(dref, 12);

  // avc1 sample entry: 8 header + 6 reserved + 2 data_ref_idx
  //   + 2+2+12 pre-defined/reserved + 2+2 width/height
  //   + 4+4 horiz/vert dpi + 4 reserved + 2 frame_count
  //   + 32 compressor name + 2 depth + 2 pre_defined
  //   + avcC.length
  log(`about to allocate avc1 (avcC.length=${avcC.length})`);
  const avc1Size = 86 + avcC.length;
  const avc1 = new Uint8Array(avc1Size);
  const avc1View = new DataView(avc1.buffer);
  avc1View.setUint32(0, avc1Size, false);
  ascii(avc1, 4, "avc1");
  // reserved 6 bytes zeroed at offset 8..13
  avc1View.setUint16(14, 1, false); // data_reference_index
  // pre_defined/reserved 16 bytes zeroed at offset 16..31
  avc1View.setUint16(32, width, false);
  avc1View.setUint16(34, height, false);
  avc1View.setUint32(36, 0x00480000, false); // horiz 72dpi
  avc1View.setUint32(40, 0x00480000, false); // vert 72dpi
  avc1View.setUint32(44, 0, false); // reserved
  avc1View.setUint16(48, 1, false); // frame_count
  // compressor_name 32 bytes at offset 50..81 (all zero)
  avc1View.setUint16(82, 0x0018, false); // depth 24
  avc1View.setUint16(84, 0xffff, false); // pre_defined (-1)
  log(`about to avc1.set(avcC, 86); avcC.length=${avcC.length} avc1.length=${avc1.length}`);
  avc1.set(avcC, 86);

  // stsd: 16 + avc1.length
  const stsd = new Uint8Array(16 + avc1.length);
  const stsdView = new DataView(stsd.buffer);
  stsdView.setUint32(0, stsd.length, false);
  ascii(stsd, 4, "stsd");
  stsdView.setUint32(8, 0, false); // version
  stsdView.setUint32(12, 1, false); // entry_count
  log(`about to stsd.set(avc1, 16); avc1.length=${avc1.length} stsd.length=${stsd.length}`);
  stsd.set(avc1, 16);

  // stts 16 bytes (empty time-to-sample)
  const stts = new Uint8Array(16);
  const sttsView = new DataView(stts.buffer);
  sttsView.setUint32(0, 16, false);
  ascii(stts, 4, "stts");
  sttsView.setUint32(8, 0, false); // version
  sttsView.setUint32(12, 0, false); // entry_count

  // stsc 16 bytes (empty)
  const stsc = new Uint8Array(16);
  const stscView = new DataView(stsc.buffer);
  stscView.setUint32(0, 16, false);
  ascii(stsc, 4, "stsc");
  stscView.setUint32(8, 0, false);
  stscView.setUint32(12, 0, false);

  // stsz 20 bytes (empty)
  const stsz = new Uint8Array(20);
  const stszView = new DataView(stsz.buffer);
  stszView.setUint32(0, 20, false);
  ascii(stsz, 4, "stsz");
  stszView.setUint32(8, 0, false);
  stszView.setUint32(12, 0, false);
  stszView.setUint32(16, 0, false);

  // stco 16 bytes (empty)
  const stco = new Uint8Array(16);
  const stcoView = new DataView(stco.buffer);
  stcoView.setUint32(0, 16, false);
  ascii(stco, 4, "stco");
  stcoView.setUint32(8, 0, false);
  stcoView.setUint32(12, 0, false);

  // stbl = stsd + stts + stsc + stsz + stco
  log(`about to concatBytes for stbl; stsd=${stsd.length} stts=${stts.length} stsc=${stsc.length} stsz=${stsz.length} stco=${stco.length}`);
  const stblContents = concatBytes(stsd, stts, stsc, stsz, stco);
  log(`stblContents.length=${stblContents.length}`);
  const stblBox = box("stbl", stblContents);
  log(`stblBox.length=${stblBox.length}`);

  // minf = vmhd + dinf + stbl
  const minf = box(
    "minf",
    concatBytes(vmhd, dinf, stblBox),
  );

  // mdia = mdhd + hdlr + minf
  const mdia = box(
    "mdia",
    concatBytes(mdhd, hdlr, minf),
  );

  // trak = tkhd + mdia
  const trak = box(
    "trak",
    concatBytes(tkhd, mdia),
  );

  // moov = mvhd + trak
  const moov = box(
    "moov",
    concatBytes(mvhd, trak),
  );

  return moov;
}

// ── (moof + mdat) fragment ──────────────────────────────────────────────────
function buildFragment(
  sample: Uint8Array,
  isKey: boolean,
  sequenceNumber: number,
  baseDecodeTime: number,
  timescale: number,
): Uint8Array {
  // trun flags we set:
  //   data_offset_present        0x000001
  //   sample_duration_present    0x000200
  //   sample_size_present        0x000400
  //   sample_flags_present       0x000800
  // We omit cts_offset so we don't need the extra 4 bytes.
  const trunFlags = 0x000001 | 0x000200 | 0x000400 | 0x000800;
  // trun = 8 (box header) + 4 (version+flags) + 4 (sample_count)
  //   + 4 (data_offset) + 4 (sample_duration) + 4 (sample_size)
  //   + 4 (sample_flags) = 32 bytes
  const trunSize = 32;
  const trun = new Uint8Array(trunSize);
  const trunView = new DataView(trun.buffer);
  trunView.setUint32(0, trunSize, false);
  ascii(trun, 4, "trun");
  trunView.setUint32(8, trunFlags, false);
  trunView.setUint32(12, 1, false); // sample_count
  trunView.setUint32(16, 0, false); // data_offset (patched below)
  trunView.setUint32(20, Math.max(1, Math.round(timescale / 30)), false); // sample_duration (1 frame)
  trunView.setUint32(24, sample.byteLength, false);
  // sample_flags: is_leading=0, depends_on=1, is_depended_on=0,
  // has_redundancy=0, padding=0, is_non_sync_sample=!isKey,
  // degradation_priority=0
  // Layout (bits): reserved(4) | is_leading(2) | depends_on(2) |
  //                is_depended_on(2) | has_redundancy(2) |
  //                padding(3) | is_non_sync_sample(1) |
  //                degradation_priority(16)
  const sampleFlags =
    (0 << 30) | // reserved
    (0 << 28) | // is_leading
    (1 << 26) | // sample_depends_on
    (0 << 24) | // sample_is_depended_on
    (0 << 22) | // sample_has_redundancy
    (0 << 19) | // sample_padding_value
    ((isKey ? 0 : 1) << 18) | // is_non_sync_sample
    (0 << 2); // degradation_priority
  trunView.setUint32(28, sampleFlags >>> 0, false);

  // tfhd 32 bytes (with default_sample_flags_present = 0x020000)
  const tfhd = new Uint8Array(32);
  const tfhdView = new DataView(tfhd.buffer);
  tfhdView.setUint32(0, 32, false);
  ascii(tfhd, 4, "tfhd");
  tfhdView.setUint32(8, 0x020000, false); // default_sample_flags_present
  tfhdView.setUint32(12, 1, false); // track_id
  // default_sample_flags same encoding as above
  tfhdView.setUint32(16, sampleFlags >>> 0, false);
  tfhdView.setUint32(20, 0, false); // default_sample_duration
  tfhdView.setUint32(24, 0, false); // default_sample_size
  tfhdView.setUint32(28, 0, false); // default_sample_flags_2

  // tfdt 20 bytes (version 0)
  const tfdt = new Uint8Array(20);
  const tfdtView = new DataView(tfdt.buffer);
  tfdtView.setUint32(0, 20, false);
  ascii(tfdt, 4, "tfdt");
  tfdtView.setUint32(8, 0, false); // version
  tfdtView.setUint32(12, baseDecodeTime, false);
  tfdtView.setUint32(16, 0, false); // high 32 bits (unused in v0)

  // mfhd 16 bytes
  const mfhd = new Uint8Array(16);
  const mfhdView = new DataView(mfhd.buffer);
  mfhdView.setUint32(0, 16, false);
  ascii(mfhd, 4, "mfhd");
  mfhdView.setUint32(8, 0, false); // version
  mfhdView.setUint32(12, sequenceNumber, false);

  // traf = tfhd + tfdt + trun
  const traf = box(
    "traf",
    concatBytes(tfhd, tfdt, trun),
  );

  // moof = mfhd + traf
  const moof = box(
    "moof",
    concatBytes(mfhd, traf),
  );

  // Patch trun's data_offset: from start of moof to first sample
  // byte in mdat = moof.length + mdat_header (8).
  // trun starts at: 8 (moof header) + 16 (mfhd) + 8 (traf header)
  //   + 32 (tfhd) + 20 (tfdt) = 84
  // data_offset field is at trun byte 16, so absolute offset = 84 + 16 = 100.
  const moofView = new DataView(moof.buffer);
  moofView.setUint32(100, moof.length + 8, false);

  // mdat = 8-byte header + sample data
  const mdat = new Uint8Array(sample.byteLength + 8);
  const mdatView = new DataView(mdat.buffer);
  mdatView.setUint32(0, sample.byteLength + 8, false);
  ascii(mdat, 4, "mdat");
  mdat.set(sample, 8);

  return concatBytes(moof, mdat);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function ascii(bytes: Uint8Array, off: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    bytes[off + i] = text.charCodeAt(i);
  }
}

function box(type: string, contents: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + contents.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  ascii(out, 4, type);
  out.set(contents, 8);
  return out;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function boxWrap(_type: string, contents: Uint8Array): Uint8Array {
  // convenience wrapper — same as box()
  return box(_type, contents);
}

/**
 * Parse annex-B H.264 bytes for SPS (NAL type 7) and PPS (NAL type
 * 8). Returns the AVCDecoderConfigurationRecord bytes and the
 * avc1.PPCCLL codec string suitable for MSE.
 */
export function parseSpsPps(
  bytes: Uint8Array,
): { codec: string; description: Uint8Array } | null {
  const positions: number[] = [];
  for (let i = 0; i < bytes.length - 3; i++) {
    if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1
    ) {
      positions.push(i + 4);
    }
  }
  if (positions.length === 0) return null;

  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let profileIdc = 0;
  let profileCompat = 0;
  let levelIdc = 0;

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] - 4 : bytes.length;
    const nal = bytes.subarray(start, end);
    const nalType = nal[0] & 0x1f;
    if (nalType === 7) {
      sps = nal;
      profileIdc = nal[1];
      profileCompat = nal[2];
      levelIdc = nal[3];
    } else if (nalType === 8) {
      pps = nal;
    }
  }
  if (!sps || !pps) return null;

  // AVCDecoderConfigurationRecord
  // 1 (configVersion) + 1 + 1 + 1 + 1 (lengthSizeMinusOne) = 5 bytes
  // + 1 (numSPS) + 2 (SPS length) + sps.length = 3 + sps.length
  // + 1 (numPPS) + 2 (PPS length) + pps.length = 3 + pps.length
  // Total = 11 + sps.length + pps.length
  const desc = new Uint8Array(
    1 + 1 + 1 + 1 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length,
  );
  let off = 0;
  desc[off++] = 1; // configurationVersion
  desc[off++] = profileIdc;
  desc[off++] = profileCompat;
  desc[off++] = levelIdc;
  desc[off++] = 0xff; // reserved 6 bits + lengthSizeMinusOne (3) 2 bits
  desc[off++] = 1; // numOfSequenceParameterSets
  desc[off++] = (sps.length >> 8) & 0xff;
  desc[off++] = sps.length & 0xff;
  desc.set(sps, off);
  off += sps.length;
  desc[off++] = 1; // numOfPictureParameterSets
  desc[off++] = (pps.length >> 8) & 0xff;
  desc[off++] = pps.length & 0xff;
  desc.set(pps, off);

  const codec =
    `avc1.${profileIdc.toString(16).padStart(2, "0").toUpperCase()}` +
    `${profileCompat.toString(16).padStart(2, "0").toUpperCase()}` +
    `${levelIdc.toString(16).padStart(2, "0").toUpperCase()}`;

  return { codec, description: desc };
}