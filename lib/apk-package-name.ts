// lib/apk-package-name.ts
//
// Extract the package name from an APK's AndroidManifest.xml without
// needing any tool on the device.
//
// Why this exists: after `pm install` we want to verify the package
// actually landed (the "Success" message has lied before). Verifying
// requires the package name, and the obvious device-side sources are
// unreliable:
//
//   • `aapt2 dump badging` — absent from many OEM ROMs (MIUI/HyperOS,
//     ColorOS, OneUI); on stock AOSP it lives at /system/bin/aapt2 which
//     isn't on the default shell PATH.
//   • `pm list packages -f` — the installed APK is renamed to base.apk
//     under /data/app/<random>/<package>-<hash>/, so the original
//     filename is nowhere in the path. Matching on filename never works.
//
// So we parse the manifest ourselves. AndroidManifest.xml inside an
// APK is Android binary XML (AXML): a small header followed by a string
// pool, then the resource table, then the XML nodes.
//
// The package name is the value of the `package` attribute on the
// manifest element. In AXML, attribute values that look like strings
// are stored as indices into the string pool, so we need to walk the
// attribute list of the root <manifest> node.
//
// Layout we rely on (all little-endian):
//
//   0x0000  u32  magic          = 0x00080003 (RES_XML_TYPE)
//   0x0004  u32  fileSize
//   0x0008  u32  stringPoolType = 0x0001 (RES_STRING_POOL_TYPE)
//   ...
//   string pool header:
//     u32  type        = 0x0001
//     u32  headerSize
//     u32  chunkSize
//     u32  stringCount
//     u32  styleCount
//     u32  flags        (1 = UTF-8, 0 = UTF-16)
//     u32  stringsStart (offset from the start of the string pool chunk)
//     u32  stylesStart
//     u32  stringOffsets[stringCount]  (u32 each)
//     ... string data ...
//
// Attribute values in AXML are encoded as a Res_value:
//   u16 size, u8 res0, u8 dataType, u32 data
// where dataType 0x03 = TYPE_STRING (data is an index into the pool)
// and dataType 0x01 = TYPE_INT (data is a literal int).
//
// The `package` attribute is a plain string, so we only need
// dataType == 0x03 to be interesting — but we still parse the typed
// value structure properly to know the attribute's name and namespace.
//
// We look for the root <manifest> node's attributes and return the one
// whose name is "package". Because we don't resolve namespace URIs
// against the resource table, we match on the raw name string —
// "package" is unique enough in practice, and if the string pool
// lacks it we fall back to scanning every string in the pool for
// something that looks like a package name (dotted, lowercase-ish).

const RES_XML_TYPE = 0x00080003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;

const UTF8_FLAG = 1 << 8;

/** A single string from the AXML string pool. */
interface PoolString {
  value: string;
}

/**
 * Parse the string pool that starts at `offset` in `buf`.
 * Returns the strings and the offset just past the pool chunk.
 */
function parseStringPool(
  buf: Uint8Array,
  offset: number,
): { strings: PoolString[]; next: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = view.getUint16(offset, true);
  if (type !== RES_STRING_POOL_TYPE) return { strings: [], next: offset };

  // ResChunk_header: u16 type, u16 headerSize, u32 size
  // ResStringPool_header: u32 stringCount, u32 styleCount, u32 flags,
  //   u32 stringsStart, u32 stylesStart
  const headerSize = view.getUint16(offset + 2, true);
  const chunkSize = view.getUint32(offset + 4, true);
  const stringCount = view.getUint32(offset + 8, true);
  const flags = view.getUint32(offset + 16, true);
  const stringsStart = view.getUint32(offset + 20, true);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;

  const offsetsBase = offset + headerSize;
  const dataBase = offset + stringsStart;

  const strings: PoolString[] = [];
  for (let i = 0; i < stringCount; i++) {
    const strOffset = view.getUint32(offsetsBase + i * 4, true);
    const abs = dataBase + strOffset;
    if (abs >= offset + chunkSize) {
      strings.push({ value: "" });
      continue;
    }
    let value: string;
    if (isUtf8) {
      // UTF-8: two length prefixes (chars, then bytes), each 1 or 2
      // bytes depending on the high bit.
      let p = abs;
      // character count
      if (buf[p] & 0x80) p += 2;
      else p += 1;
      // byte count
      let byteLen: number;
      if (buf[p] & 0x80) {
        byteLen = ((buf[p] & 0x7f) << 8) | buf[p + 1];
        p += 2;
      } else {
        byteLen = buf[p];
        p += 1;
      }
      value = decodeUtf8(buf.subarray(p, p + byteLen));
    } else {
      // UTF-16: u16 character count (with a possible high-bit
      // extension), then that many UTF-16 code units.
      let p = abs;
      let charCount = view.getUint16(p, true);
      p += 2;
      if (charCount & 0x8000) {
        charCount = ((charCount & 0x7fff) << 16) | view.getUint16(p, true);
        p += 2;
      }
      const slice = buf.subarray(p, p + charCount * 2);
      value = new TextDecoder("utf-16le").decode(slice);
    }
    strings.push({ value });
  }
  return { strings, next: offset + chunkSize };
}

/** Minimal UTF-8 decoder (the platform TextDecoder handles it, but we
 *  keep it explicit so the module has no environment assumptions). */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Extract the package name from an APK's bytes.
 *
 * Returns `null` if the manifest can't be located or parsed.
 */
export function extractPackageNameFromApk(apk: Uint8Array): string | null {
  // The manifest isn't necessarily at the start of the ZIP, so we have
  // to find it. We look for the AXML magic in a plausible place: the
  // local file header signature "PK\x03\x04" followed by the entry
  // name. Rather than implementing a full ZIP reader, we scan the
  // central directory for the "AndroidManifest.xml" entry and read its
  // local header. That's the robust approach; the naive "find the AXML
  // magic anywhere" shortcut produces false positives from compressed
  // data.
  const entry = findZipEntry(apk, "AndroidManifest.xml");
  if (!entry) return null;

  const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  const localOffset = entry.localHeaderOffset;
  // Local file header: signature(4) version(2) flags(2) method(2)
  // time(2) date(2) crc(4) compSize(4) uncompSize(4) nameLen(2)
  // extraLen(2) then name then extra then data.
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const method = view.getUint16(localOffset + 8, true);
  const compSize = view.getUint32(localOffset + 18, true);

  let manifestBytes: Uint8Array;
  if (method === 0) {
    // stored
    manifestBytes = apk.subarray(dataStart, dataStart + compSize);
  } else if (method === 8) {
    // deflate — we need to inflate. The browser has DecompressionStream
    // ("deflate-raw"), which covers raw deflate without the zlib header.
    // DecompressionStream is async, so this path can't be used inside
    // the synchronous extractor. Callers that need the package name
    // should use the async variant below.
    return null;
  } else {
    return null;
  }

  return extractPackageNameFromManifest(manifestBytes);
}

/**
 * Async variant that handles deflate-compressed manifests via
 * DecompressionStream.
 */
export async function extractPackageNameFromApkAsync(
  apk: Uint8Array,
): Promise<string | null> {
  const entry = findZipEntry(apk, "AndroidManifest.xml");
  if (!entry) return null;

  const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  const localOffset = entry.localHeaderOffset;
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const method = view.getUint16(localOffset + 8, true);
  const compSize = view.getUint32(localOffset + 18, true);

  if (method === 0) {
    return extractPackageNameFromManifest(
      apk.subarray(dataStart, dataStart + compSize),
    );
  }
  if (method !== 8) return null;

  const raw = apk.subarray(dataStart, dataStart + compSize);
  let inflated: Uint8Array;
  try {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    void writer.write(raw as unknown as BufferSource);
    void writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    inflated = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      inflated.set(c, off);
      off += c.byteLength;
    }
  } catch {
    return null;
  }
  return extractPackageNameFromManifest(inflated);
}

interface ZipEntry {
  localHeaderOffset: number;
}

/**
 * Locate an entry in the ZIP central directory.
 */
function findZipEntry(zip: Uint8Array, entryName: string): ZipEntry | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const nameBytes = new TextEncoder().encode(entryName);

  // Find the End Of Central Directory record by scanning backwards.
  const maxBack = Math.min(zip.length, 66000);
  let eocd = -1;
  for (let i = zip.length - 22; i >= zip.length - maxBack && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdCount = view.getUint32(eocd + 10, true);

  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > zip.length) return null;
    if (view.getUint32(p, true) !== 0x02014b50) return null;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const nameStart = p + 46;
    let match = nameLen === nameBytes.length;
    if (match) {
      for (let k = 0; k < nameLen; k++) {
        if (zip[nameStart + k] !== nameBytes[k]) {
          match = false;
          break;
        }
      }
    }
    if (match) {
      void method;
      void compSize;
      return { localHeaderOffset };
    }
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * Parse AXML bytes and return the `package` attribute of the root
 * <manifest> element.
 */
export function extractPackageNameFromManifest(
  manifest: Uint8Array,
): string | null {
  if (manifest.length < 16) return null;
  const view = new DataView(
    manifest.buffer,
    manifest.byteOffset,
    manifest.byteLength,
  );
  if (view.getUint32(0, true) !== RES_XML_TYPE) return null;

  let offset = 8; // skip the file header (magic u32 + size u32)
  let strings: PoolString[] = [];

  while (offset + 8 <= manifest.length) {
    // ResChunk_header: u16 type, u16 headerSize, u32 size
    const chunkType = view.getUint16(offset, true);
    const headerSize = view.getUint16(offset + 2, true);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkSize <= 0) break;

    if (chunkType === RES_STRING_POOL_TYPE) {
      const parsed = parseStringPool(manifest, offset);
      strings = parsed.strings;
      offset += chunkSize;
      continue;
    }

    if (chunkType === RES_XML_START_ELEMENT_TYPE) {
      // ResXMLTree_attrExt:
      //   u32 ns, u32 name, u16 attributeStart, u16 attributeSize,
      //   u16 attributeCount, u16 idIndex, u16 classIndex, u16 styleIndex
      // then attributeCount * attributeSize bytes of attributes.
      const extStart = offset + headerSize;
      const attributeStart = view.getUint16(extStart + 8, true);
      const attributeSize = view.getUint16(extStart + 10, true);
      const attributeCount = view.getUint16(extStart + 12, true);
      const attrBase = extStart + attributeStart;

      for (let i = 0; i < attributeCount; i++) {
        const a = attrBase + i * attributeSize;
        if (a + 20 > manifest.length) break;
        // ResXMLTree_attribute:
        //   u32 ns, u32 name, u32 rawValue, Res_value {u16 size, u8 res0,
        //   u8 dataType, u32 data}
        const nameIdx = view.getUint32(a + 4, true);
        const dataType = view.getUint8(a + 15);
        const data = view.getUint32(a + 16, true);
        if (dataType !== 0x03) continue; // TYPE_STRING
        const nameStr = strings[nameIdx]?.value;
        if (nameStr !== "package") continue;
        const pkg = strings[data]?.value;
        if (pkg) return pkg;
      }
      // The root element is the first <manifest>; if we got here the
      // package attribute wasn't a string (unlikely), so keep scanning
      // in case a nested element carries it.
    }

    if (
      chunkType === RES_XML_RESOURCE_MAP_TYPE ||
      chunkType === RES_XML_END_ELEMENT_TYPE
    ) {
      offset += chunkSize;
      continue;
    }

    offset += chunkSize;
  }

  // Fallback: the string pool almost always contains the package name
  // even if we failed to locate the attribute. Pick the first entry
  // that looks like a Java package name.
  for (const s of strings) {
    const v = s.value;
    if (!v || v.length < 3) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(v)) continue;
    // Exclude obvious non-package strings: URLs, file paths, class
    // names with uppercase segments are still plausible, so we only
    // reject things with obvious punctuation.
    if (v.includes("/") || v.includes(":") || v.includes(" ")) continue;
    return v;
  }
  return null;
}
