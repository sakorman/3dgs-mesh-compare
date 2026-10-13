import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { decodePly } from "../src/model-bytes";
test("accepts both HTTP-inflated PLY and raw gzip assets", async () => {
  const raw = new TextEncoder().encode(
    "ply\nformat binary_little_endian 1.0\nend_header\n",
  ).buffer;
  const gz = gzipSync(new Uint8Array(raw));
  assert.deepEqual(new Uint8Array(await decodePly(raw)), new Uint8Array(raw));
  assert.deepEqual(
    new Uint8Array(await decodePly(Uint8Array.from(gz).buffer)),
    new Uint8Array(raw),
  );
});
test("invalid data fails instead of loading a black model", async () => {
  await assert.rejects(() => decodePly(new ArrayBuffer(0)), /无效/);
});
