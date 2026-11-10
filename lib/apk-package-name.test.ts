// Test the AXML package-name extractor against a synthetic manifest.
//
// We hand-build an AndroidManifest.xml (AXML) with a known package
// name and check that extractPackageNameFromManifest finds it.
//
// Run: npx tsx lib/apk-package-name.test.ts   (or node --experimental-strip-types)

import { extractPackageNameFromManifest } from "./apk-package-name";

/** Build a UTF-16 string pool chunk. */
function buildStringPool(strings: string[]): Uint8Array {
  const encoded = strings.map((s) => {
    const utf16 = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      utf16[i * 2] = c & 0xff;
      utf16[i * 2 + 1] = (c >> 8) & 0xff;
    }
    return utf16;
  });
  // Each string is preceded by a u16 length (in UTF-16 code units).
  // If the high bit is set, an extra u16 holds the high bits.
  const dataParts: Uint8Array[] = [];
  const offsets: number[] = [];
  let dataLen = 0;
  for (const s of strings) {
    offsets.push(dataLen);
    const lenBytes = new Uint8Array(2);
    const c = s.length;
    lenBytes[0] = c & 0xff;
    lenBytes[1] = (c >> 8) & 0xff;
    dataParts.push(lenBytes);
    dataParts.push(encoded[strings.indexOf(s)]);
    dataLen += 2 + s.length * 2;
  }
  const dataSize = dataLen;
  // ResChunk_header (8 bytes): type u16, headerSize u16, size u32
  // ResStringPool_header (20 bytes): stringCount, styleCount, flags,
  //   stringsStart, stylesStart  =>  headerSize = 28
  const headerSize = 28;
  const chunkSize = headerSize + offsets.length * 4 + dataSize;

  const out = new Uint8Array(chunkSize);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x0001, true); // type = string pool
  view.setUint16(2, headerSize, true);
  view.setUint32(4, chunkSize, true);
  view.setUint32(8, strings.length, true); // stringCount
  view.setUint32(12, 0, true); // styleCount
  view.setUint32(16, 0, true); // flags: UTF-16
  view.setUint32(20, headerSize + offsets.length * 4, true); // stringsStart
  view.setUint32(24, 0, true); // stylesStart
  offsets.forEach((o, i) => view.setUint32(headerSize + i * 4, o, true));

  let p = headerSize + offsets.length * 4;
  let idx = 0;
  for (const s of strings) {
    const lenBytes = new Uint8Array(2);
    lenBytes[0] = s.length & 0xff;
    lenBytes[1] = (s.length >> 8) & 0xff;
    out.set(lenBytes, p);
    p += 2;
    const utf16 = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      utf16[i * 2] = c & 0xff;
      utf16[i * 2 + 1] = (c >> 8) & 0xff;
    }
    out.set(utf16, p);
    p += s.length * 2;
    idx++;
  }
  return out;
}

/** Build a ResXMLTree start-element chunk carrying one string attribute. */
function buildStartElement(
  nameIdx: number,
  attrNameIdx: number,
  attrValueIdx: number,
): Uint8Array {
  const headerSize = 16; // chunk header
  const extSize = 20; // ResXMLTree_attrExt
  const attrSize = 20; // ResXMLTree_attribute
  const chunkSize = headerSize + extSize + attrSize;
  const out = new Uint8Array(chunkSize);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0x0102, true); // RES_XML_START_ELEMENT_TYPE
  view.setUint16(2, headerSize, true);
  view.setUint32(4, chunkSize, true);

  const ext = headerSize;
  view.setUint32(ext + 0, 0xffffffff, true); // ns
  view.setUint32(ext + 4, nameIdx, true); // name
  view.setUint16(ext + 8, extSize, true); // attributeStart
  view.setUint16(ext + 10, attrSize, true); // attributeSize
  view.setUint16(ext + 12, 1, true); // attributeCount
  view.setUint16(ext + 14, 0, true); // idIndex
  view.setUint16(ext + 16, 0, true); // classIndex
  view.setUint16(ext + 18, 0, true); // styleIndex

  const a = ext + extSize;
  view.setUint32(a + 0, 0xffffffff, true); // ns
  view.setUint32(a + 4, attrNameIdx, true); // name
  view.setUint32(a + 8, attrValueIdx, true); // rawValue
  view.setUint16(a + 12, 8, true); // Res_value size
  out[a + 14] = 0; // res0
  out[a + 15] = 0x03; // dataType = TYPE_STRING
  view.setUint32(a + 16, attrValueIdx, true); // data
  return out;
}

/** Build the whole AXML file. */
function buildManifestXml(packageName: string): Uint8Array {
  const strings = ["manifest", "package", packageName];
  const pool = buildStringPool(strings);
  const start = buildStartElement(0, 1, 2);

  const fileHeader = new Uint8Array(8);
  const fhView = new DataView(fileHeader.buffer);
  fhView.setUint32(0, 0x00080003, true); // RES_XML_TYPE
  fhView.setUint32(4, 8 + pool.length + start.length, true); // fileSize

  const out = new Uint8Array(fileHeader.length + pool.length + start.length);
  out.set(fileHeader, 0);
  out.set(pool, fileHeader.length);
  out.set(start, fileHeader.length + pool.length);
  return out;
}

// ── Run the test ───────────────────────────────────────────────────────────
const PKG = "com.xiuxin.glassoptimizer";
const manifest = buildManifestXml(PKG);
const got = extractPackageNameFromManifest(manifest);

if (got === PKG) {
  console.log(`PASS — extracted "${got}"`);
  process.exit(0);
} else {
  console.error(`FAIL — expected "${PKG}", got ${JSON.stringify(got)}`);
  console.error("manifest hex:", Buffer.from(manifest).toString("hex"));
  process.exit(1);
}
