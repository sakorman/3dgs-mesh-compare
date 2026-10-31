import test from "node:test";
import assert from "node:assert/strict";
import { bufferOwnership } from "./helpers/buffer-ownership";

test("memory accounting deduplicates shared backing stores and includes unused capacity", () => {
  const buffer = new ArrayBuffer(64);
  assert.deepEqual(bufferOwnership([new Uint8Array(buffer, 0, 8), new Uint32Array(buffer, 0, 4), new Uint8Array(10)]),
    {views: 3, viewBytes: 34, buffers: 2, backingBytes: 74});
});
test("transferred backing stores have zero remaining capacity", () => {
  const view = new Uint8Array(64);
  const moved = structuredClone(view, {transfer: [view.buffer]});
  assert.deepEqual(bufferOwnership([view]), {views: 1, viewBytes: 0, buffers: 1, backingBytes: 0});
  assert.equal(bufferOwnership([moved]).backingBytes, 64);
});
