import test from "node:test";
import assert from "node:assert/strict";
import { restoreAttributes, type Attribute } from "./helpers/ext-attributes";

test("color and log-scale split a shared word without changing neighboring fields", () => {
  const base: [Uint32Array, Uint32Array] = [new Uint32Array([1, 2, 3, 0xaaaa1111]), new Uint32Array([4, 0xbbbb2222, 5, 6])];
  const src: [Uint32Array, Uint32Array] = [new Uint32Array([7, 8, 9, 0xcccc3333]), new Uint32Array([10, 0xdddd4444, 11, 12])];
  const color = restoreAttributes(base, src, 1, ["color"]);
  assert.deepEqual([...color[1]], [10, 0xbbbb4444, 5, 6]);
  assert.deepEqual(color[0], base[0]);
  const scale = restoreAttributes(base, src, 1, ["scale"]);
  assert.deepEqual([...scale[1]], [4, 0xdddd2222, 11, 6]);
  assert.deepEqual(scale[0], base[0]);
  assert.equal(restoreAttributes(base, src, 1, ["opacity"])[0][3], 0xaaaa3333);
  assert.equal(base[1][1], 0xbbbb2222);
});

test("all active attributes restore the source while preserving reserved bits and padding", () => {
  const base: [Uint32Array, Uint32Array] = [new Uint32Array(12).fill(0xaaaa1111), new Uint32Array(12).fill(0xbbbb2222)];
  const src: [Uint32Array, Uint32Array] = [new Uint32Array(12).fill(0xcccc3333), new Uint32Array(12).fill(0xdddd4444)];
  const fields: Attribute[] = ["position", "opacity", "color", "scale", "rotation"];
  const out = restoreAttributes(base, src, 2, fields);
  for (let i = 0; i < 8; i++) {
    assert.equal(out[0][i], i % 4 === 3 ? 0xaaaa3333 : src[0][i]);
    assert.equal(out[1][i], src[1][i]);
  }
  assert.deepEqual(out[0].slice(8), base[0].slice(8));
  out[1][0] = 0;
  assert.equal(base[1][0], 0xbbbb2222);
  assert.equal(src[1][0], 0xdddd4444);
});

test("incomplete buffers and invalid counts cannot produce an attribution sample", () => {
  const arrays: [Uint32Array, Uint32Array] = [new Uint32Array(4), new Uint32Array(4)];
  for (const count of [-1, .5, 2]) assert.throws(() => restoreAttributes(arrays, arrays, count, ["position"]));
});
