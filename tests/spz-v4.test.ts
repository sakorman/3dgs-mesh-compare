import { test } from "node:test";
import assert from "node:assert/strict";
import { packSpzV4, spzV3Sections, validateSpzV4 } from "./helpers/spz-v4";

function fixture() {
  const raw = new Uint8Array(16 + 65 * 2), view = new DataView(raw.buffer);
  view.setUint32(0, 0x5053474e, true); view.setUint32(4, 3, true); view.setUint32(8, 2, true);
  raw.set([3, 12, 1, 0], 12);
  for (let i = 16; i < raw.length; i++) raw[i] = i;
  // Opaque stream bytes exercise TOC boundaries; actual codec round trips run in the preparation script.
  const streams = Array.from({length: 6}, (_, i) => new Uint8Array(i + 1).fill(i));
  return {raw, streams, bytes: packSpzV4(raw, 2, streams)};
}
test("SPZ v4 control preserves attribute order and validates stream boundaries", () => {
  const {raw, streams, bytes} = fixture();
  assert.deepEqual(new Uint8Array(spzV3Sections(raw, 2).flatMap(s => [...s])), raw.subarray(16));
  for (const [i, entry] of validateSpzV4(bytes, 2).entries())
    assert.deepEqual(bytes.subarray(entry.offset, entry.offset + entry.bytes), streams[i]);
  assert.equal(new DataView(raw.buffer).getUint32(4, true), 3);
});
test("SPZ v4 control rejects overflowing, zero and incorrect decoded stream sizes", () => {
  for (const [offset, value] of [[32, 2n ** 63n], [32, 0n], [40, 17n]] as const) {
    const {bytes} = fixture(); new DataView(bytes.buffer).setBigUint64(offset, value, true);
    assert.throws(() => validateSpzV4(bytes, 2), /stream bounds/);
  }
});
test("SPZ v4 control rejects unsupported metadata, truncation and trailing bytes", () => {
  for (const [offset, value] of [[4, 5], [8, 3], [12, 2], [14, 3], [15, 5], [16, 31], [20, 1]]) {
    const {bytes} = fixture(); bytes[offset] = value;
    assert.throws(() => validateSpzV4(bytes, 2));
  }
  const {bytes} = fixture();
  assert.throws(() => validateSpzV4(bytes.subarray(0, 127), 2));
  assert.throws(() => validateSpzV4(bytes.subarray(0, bytes.length - 1), 2));
  assert.throws(() => validateSpzV4(new Uint8Array([...bytes, 0]), 2), /Trailing/);
});
test("SPZ v3 source must have the fixed schema and exact length before repacking", () => {
  const {raw, streams} = fixture();
  assert.throws(() => packSpzV4(raw.subarray(0, raw.length - 1), 2, streams));
  raw[14] = 3; assert.throws(() => packSpzV4(raw, 2, streams));
});
