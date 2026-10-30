import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeAlpha16, validateAlpha16 } from "./helpers/alpha16";
import { storedSpzControl } from "./helpers/spz-container";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
function fixture() {
  const raw = Buffer.alloc(16 + 65 * 2);
  raw.writeUInt32LE(0x5053474e, 0); raw.writeUInt32LE(3, 4); raw.writeUInt32LE(2, 8); raw[12] = 3;
  raw.fill(127, 16);
  const source = gzipSync(raw), words = new Uint32Array(8); words[3] = 0x3800; words[7] = 0x3c00;
  return { raw, source, alpha: encodeAlpha16(words, 2, hash(source)) };
}
test("stored SPZ preserves decoded bytes and alpha order while binding the new envelope", () => {
  const { raw, source, alpha } = fixture(), before = alpha.slice();
  const result = storedSpzControl(source, alpha, 2);
  assert.deepEqual(gunzipSync(result.model), raw);
  assert.deepEqual(result.alpha.subarray(48), alpha.subarray(48));
  assert.deepEqual(alpha, before);
  validateAlpha16(result.alpha, 2, hash(result.model));
  assert.throws(() => validateAlpha16(result.alpha, 2, hash(source)), /hash mismatch/);
});
test("stored SPZ refuses a sidecar bound to another compressed source", () => {
  const { source, alpha } = fixture(); alpha[16] ^= 1;
  assert.throws(() => storedSpzControl(source, alpha, 2), /hash mismatch/);
});
test("stored SPZ refuses count mismatch, unsupported payload and truncation before rebinding", () => {
  for (const mutate of [(b: Buffer) => b.writeUInt32LE(1, 8), (b: Buffer) => b.writeUInt32LE(4, 4),
    (b: Buffer) => { b[14] = 2; }]) {
    const { raw } = fixture(); mutate(raw);
    const source = gzipSync(raw), alpha = encodeAlpha16(new Uint32Array(8), 2, hash(source));
    assert.throws(() => storedSpzControl(source, alpha, 2), /plain v3 SH3/);
  }
  const { source, alpha } = fixture();
  const truncated = source.subarray(0, source.length - 8);
  alpha.set(hash(truncated), 16);
  assert.throws(() => storedSpzControl(truncated, alpha, 2));
});
