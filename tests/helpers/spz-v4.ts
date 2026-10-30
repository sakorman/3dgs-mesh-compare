// Isolated no-extension SH3 control; layout reference: nianticlabs/spz, load-spz.cc.
export const SPZ_ATTRIBUTE_WIDTHS = [9, 1, 3, 3, 4, 45] as const;
export const SPZ_ATTRIBUTE_NAMES = ["positions", "alphas", "colors", "scales", "rotations", "sh"] as const;
function validCount(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error("Invalid SPZ control count");
}
function common(bytes: Uint8Array, count: number, version: number) {
  validCount(count);
  if (bytes.length < 16) throw new Error("Truncated SPZ control header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x5053474e || view.getUint32(4, true) !== version ||
      view.getUint32(8, true) !== count || bytes[12] !== 3 || bytes[13] !== 12 || bytes[14] !== 1)
    throw new Error("Expected SH3 / 12 fractional bits / antialiased SPZ control without extensions");
  return view;
}
export function spzV3Sections(raw: Uint8Array, count: number) {
  common(raw, count, 3);
  if (raw[15] !== 0 || raw.length !== 16 + count * 65) throw new Error("Invalid SPZ v3 length/reserved byte");
  let cursor = 16;
  return SPZ_ATTRIBUTE_WIDTHS.map(width => {
    const result = raw.subarray(cursor, cursor + count * width);
    cursor += result.length;
    return result;
  });
}
export function validateSpzV4(bytes: Uint8Array, count: number) {
  const view = common(bytes, count, 4);
  if (bytes.length < 128 || bytes[15] !== 6 || view.getUint32(16, true) !== 32 ||
      bytes.subarray(20, 32).some(value => value !== 0)) throw new Error("Invalid SPZ v4 header/TOC");
  let cursor = 128;
  const streams = SPZ_ATTRIBUTE_WIDTHS.map((width, i) => {
    const compressed = view.getBigUint64(32 + i * 16, true);
    const decoded = view.getBigUint64(40 + i * 16, true);
    if (compressed === 0n || compressed > BigInt(bytes.length - cursor) || decoded !== BigInt(count * width))
      throw new Error("Invalid SPZ v4 stream bounds/decoded length");
    const stream = {name: SPZ_ATTRIBUTE_NAMES[i], offset: cursor, bytes: Number(compressed), decodedBytes: Number(decoded)};
    cursor += stream.bytes;
    return stream;
  });
  if (cursor !== bytes.length) throw new Error("Trailing SPZ v4 bytes");
  return streams;
}
export function packSpzV4(rawV3: Uint8Array, count: number, compressed: Uint8Array[]) {
  const sections = spzV3Sections(rawV3, count);
  if (compressed.length !== 6 || compressed.some(bytes => !bytes.length)) throw new Error("Expected six ZSTD streams");
  const bytes = new Uint8Array(128 + compressed.reduce((n, stream) => n + stream.length, 0));
  bytes.set(rawV3.subarray(0, 16));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 4, true); bytes[15] = 6; view.setUint32(16, 32, true);
  let cursor = 128;
  for (let i = 0; i < 6; i++) {
    view.setBigUint64(32 + i * 16, BigInt(compressed[i].length), true);
    view.setBigUint64(40 + i * 16, BigInt(sections[i].length), true);
    bytes.set(compressed[i], cursor); cursor += compressed[i].length;
  }
  validateSpzV4(bytes, count);
  return bytes;
}
