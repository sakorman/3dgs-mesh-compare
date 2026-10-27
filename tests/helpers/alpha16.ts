// Experimental sidecar for Spark 2.4.0 ExtSplats; this is not an SPZ extension.
// The SHA-256 binds values to the exact compressed model and its splat order.
const HEADER = 48;
function checkTarget(words: Uint32Array, count: number, modelHash: Uint8Array) {
  if (!Number.isInteger(count) || count < 1 || count > 0xffffffff || words.length < count * 4 || modelHash.length !== 32)
    throw new Error("Invalid alpha16 target");
}
function validAlpha(bits: number) {
  // Positive finite IEEE binary16 in [0, 1], including +0; reject negative zero.
  return bits <= 0x3c00;
}
export function encodeAlpha16(words: Uint32Array, count: number, modelHash: Uint8Array) {
  checkTarget(words, count, modelHash);
  const bytes = new Uint8Array(HEADER + count * 2);
  bytes.set([65, 80, 49, 54]); // AP16
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, count, true);
  bytes.set(modelHash, 16);
  for (let i = 0; i < count; i++) {
    const bits = words[i * 4 + 3] & 0xffff;
    if (!validAlpha(bits)) throw new Error("Invalid alpha16 opacity");
    view.setUint16(HEADER + i * 2, bits, true);
  }
  return bytes;
}
export function validateAlpha16Header(bytes: Uint8Array, count: number, modelHash: Uint8Array) {
  if (!Number.isInteger(count) || count < 1 || count > 0xffffffff || modelHash.length !== 32 || bytes.length < HEADER)
    throw new Error("Invalid alpha16 target or header length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x36315041 || view.getUint32(4, true) !== 1 ||
      view.getUint32(8, true) !== count || view.getUint32(12, true) !== 0)
    throw new Error("Invalid alpha16 header");
  for (let i = 0; i < 32; i++) if (bytes[16 + i] !== modelHash[i]) throw new Error("Alpha16 model hash mismatch");
}
export function validateAlpha16(bytes: Uint8Array, count: number, modelHash: Uint8Array) {
  if (bytes.byteLength !== HEADER + count * 2) throw new Error("Invalid alpha16 length");
  validateAlpha16Header(bytes, count, modelHash);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) if (!validAlpha(view.getUint16(HEADER + i * 2, true)))
    throw new Error("Invalid alpha16 opacity");
}
export function applyAlpha16(bytes: Uint8Array, words: Uint32Array, count: number, modelHash: Uint8Array) {
  checkTarget(words, count, modelHash);
  // Validate the entire payload before changing any target word.
  validateAlpha16(bytes, count, modelHash);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) words[i * 4 + 3] =
    (words[i * 4 + 3] & 0xffff0000) | view.getUint16(HEADER + i * 2, true);
}
