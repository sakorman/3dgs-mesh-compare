import test from "node:test";
import assert from "node:assert/strict";
import { encodeAlpha16, applyAlpha16 } from "./helpers/alpha16";
const hash = new Uint8Array(32).fill(7);
const source = new Uint32Array([1, 2, 3, 0xaaaa0001, 4, 5, 6, 0xbbbb3c00]);
const payload = () => encodeAlpha16(source, 2, hash);

test("sidecar round-trip preserves neighboring fields, reserved bits and padding", () => {
  const target = new Uint32Array(12).fill(0xcccc1234);
  const before = target.slice();
  const buffer = new Uint8Array(60);
  buffer.set(payload(), 5); // Unaligned subarray is accepted.
  applyAlpha16(buffer.subarray(5, 57), target, 2, hash);
  assert.equal(target[3], 0xcccc0001);
  assert.equal(target[7], 0xcccc3c00);
  for (let i = 0; i < target.length; i++) if (i !== 3 && i !== 7) assert.equal(target[i], before[i]);
  assert.equal(source[3], 0xaaaa0001);
});

test("mismatched models, headers, counts and lengths leave target untouched", () => {
  const invalid = [payload().subarray(0, 51), new Uint8Array(53)];
  for (const offset of [0, 4, 8, 12, 16, 47]) {
    const bytes = payload(); bytes[offset] ^= 1; invalid.push(bytes);
  }
  for (const bytes of invalid) {
    const target = source.slice();
    assert.throws(() => applyAlpha16(bytes, target, 2, hash));
    assert.deepEqual(target, source);
  }
});

test("invalid final opacity cannot partially patch preceding splats", () => {
  for (const bits of [0x3c01, 0x7c00, 0x7e00, 0x8000, 0xbc00]) {
    const bytes = payload(); new DataView(bytes.buffer).setUint16(50, bits, true);
    const target = new Uint32Array(8).fill(0xeeee2222), before = target.slice();
    assert.throws(() => applyAlpha16(bytes, target, 2, hash));
    assert.deepEqual(target, before);
    const badSource = source.slice(); badSource[7] = bits;
    assert.throws(() => encodeAlpha16(badSource, 2, hash));
  }
});

test("invalid target dimensions and digest lengths are rejected", () => {
  for (const count of [0, -1, .5, 3, 0x100000000]) {
    assert.throws(() => encodeAlpha16(source, count, hash));
    assert.throws(() => applyAlpha16(payload(), source, count, hash));
  }
  assert.throws(() => applyAlpha16(payload(), source, 2, hash.subarray(1)));
});
