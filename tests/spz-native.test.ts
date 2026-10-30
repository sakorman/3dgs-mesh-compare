import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { nativeStoredSpz } from "./helpers/spz-native";

function raw(count: number) {
  const bytes = new Uint8Array(16 + count * 65);
  // Nonuniform payload catches incorrect source/destination block offsets.
  for (let i = 16; i < bytes.length; i++) bytes[i] = (i * 37 + (i >>> 8)) & 255;
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x5053474e, true); view.setUint32(4, 3, true);
  view.setUint32(8, count, true); view.setUint32(12, 0x00010c03, true);
  return bytes;
}

test("native adapter preserves all bytes across partial and multiple stored blocks", async () => {
  for (const count of [1, 1007, 1008, 1009, 4000]) {
    const source = raw(count), gzip = gzipSync(source);
    const converted = await nativeStoredSpz(gzip, count);
    assert.deepEqual(new Uint8Array(gunzipSync(converted)), source);
    assert.equal(converted.length, 18 + source.length + Math.ceil(source.length / 65535) * 5);
  }
});
test("native adapter rejects damaged CRC, truncated streams and trailing data", async () => {
  const gzip = new Uint8Array(gzipSync(raw(1009)));
  const crc = gzip.slice(); crc[crc.length - 8] ^= 1;
  await assert.rejects(nativeStoredSpz(crc, 1009));
  // Keep the expected ISIZE to exercise decoder failure rather than preflight only.
  const truncated = new Uint8Array(gzip.length - 9);
  truncated.set(gzip.subarray(0, truncated.length - 8)); truncated.set(gzip.subarray(-8), truncated.length - 8);
  await assert.rejects(nativeStoredSpz(truncated, 1009));
  const extra = new Uint8Array(gzip.length + 8); extra.set(gzip); extra.set(gzip.subarray(-8), gzip.length);
  await assert.rejects(nativeStoredSpz(extra, 1009));
});
test("native adapter bounds size, rejects concatenation and unsupported control headers", async () => {
  const gzip = gzipSync(raw(1009));
  for (const count of [0, 1.5, 1000001, 1008]) await assert.rejects(nativeStoredSpz(gzip, count));
  const both = new Uint8Array(gzip.length * 2); both.set(gzip); both.set(gzip, gzip.length);
  await assert.rejects(nativeStoredSpz(both, 1009));
  for (const offset of [0, 4, 8, 12, 13, 14, 15]) {
    const bytes = raw(1009); bytes[offset] ^= 1;
    await assert.rejects(nativeStoredSpz(gzipSync(bytes), 1009));
  }
  const flags = new Uint8Array(gzip); flags[3] = 8;
  await assert.rejects(nativeStoredSpz(flags, 1009));
});
