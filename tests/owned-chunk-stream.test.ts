import test from "node:test";
import assert from "node:assert/strict";
import { ownedChunkStream } from "./helpers/owned-chunk-stream";
test("transferring every owned chunk preserves the original subarray and exact bytes", async () => {
  const parent = new Uint8Array([99, 1, 2, 3, 4, 5, 88]), source = parent.subarray(1, 6);
  const reader = ownedChunkStream(source, 2).getReader(), result: number[] = [], sizes: number[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    assert.equal(value.byteLength, value.buffer.byteLength); sizes.push(value.length);
    const moved = structuredClone(value, { transfer: [value.buffer] });
    assert.equal(value.byteLength, 0); result.push(...moved);
  }
  reader.releaseLock();
  assert.deepEqual(sizes, [2, 2, 1]); assert.deepEqual(result, [1, 2, 3, 4, 5]);
  assert.deepEqual([...parent], [99, 1, 2, 3, 4, 5, 88]);
});
test("cancel closes the source without another chunk and an empty input yields only EOF", async () => {
  const reader = ownedChunkStream(new Uint8Array(100), 2).getReader();
  assert.equal((await reader.read()).value!.length, 2);
  await reader.cancel(); assert.equal((await reader.read()).done, true); reader.releaseLock();
  const empty = ownedChunkStream(new Uint8Array()).getReader(); assert.equal((await empty.read()).done, true); empty.releaseLock();
});
test("invalid chunk sizes fail before starting a stream", () => {
  for (const size of [0, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => ownedChunkStream(new Uint8Array(4), size), /Invalid chunk size/);
});
