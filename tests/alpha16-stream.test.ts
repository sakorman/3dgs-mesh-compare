import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { encodeAlpha16 } from "./helpers/alpha16";
import { MAX_ALPHA16_BYTES, readAlpha16Response, restoreAlpha16Response } from "./helpers/alpha16-stream";
const hash = new Uint8Array(32).fill(7);
const words = new Uint32Array([1, 2, 3, 0x3800, 4, 5, 6, 0x3c00]);
const raw = encodeAlpha16(words, 2, hash);
const zipped = new Uint8Array(gzipSync(raw));
function chunks(bytes: Uint8Array, size = 1, headers?: HeadersInit) {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === bytes.length) { c.close(); return; }
      const end = Math.min(offset + size, bytes.length);
      c.enqueue(bytes.subarray(offset, end)); offset = end;
    },
  }), { headers });
}

test("raw, gzip and already HTTP-inflated bodies restore identical opacity across split headers", async () => {
  for (const [bytes, headers] of [[raw, {}], [zipped, {}], [raw, { "Content-Encoding": "gzip", "Content-Length": "1" }]] as const) {
    const response = chunks(bytes, 1, headers);
    response.arrayBuffer = async () => { throw new Error("whole response buffering is forbidden"); };
    const target = new Uint32Array(12).fill(0xaaaa1111);
    assert.deepEqual(await restoreAlpha16Response(response, target, 2, hash), raw);
    assert.equal(target[3], 0xaaaa3800); assert.equal(target[7], 0xaaaa3c00);
    for (let i = 0; i < target.length; i++) if (i !== 3 && i !== 7) assert.equal(target[i], 0xaaaa1111);
    assert.equal(response.body!.locked, false);
  }
});

test("wrong model and header reject without waiting for the rest of a response", { timeout: 2000 }, async () => {
  for (const offset of [0, 4, 8, 12, 16, 47]) {
    const bytes = raw.slice(); bytes[offset] ^= 1;
    let pulls = 0, cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (++pulls === 1) c.enqueue(bytes.subarray(0, 48)); else return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    await assert.rejects(readAlpha16Response(response, 2, hash), /header|hash/);
    assert.equal(cancelled, true); assert.equal(pulls, 1); assert.equal(response.body!.locked, false);
  }
});

test("oversized or concatenated decoded payloads reject without publishing any target writes", async () => {
  const expanded = new Uint8Array(2 * 1024 * 1024); expanded.set(raw);
  const concatenated = new Uint8Array(zipped.length * 2); concatenated.set(zipped); concatenated.set(zipped, zipped.length);
  for (const bytes of [expanded, new Uint8Array(gzipSync(expanded)), concatenated]) {
    const target = new Uint32Array(8).fill(77), before = target.slice();
    const response = chunks(bytes, 1024);
    await assert.rejects(restoreAlpha16Response(response, target, 2, hash));
    assert.deepEqual(target, before); assert.equal(response.body!.locked, false);
  }
});

test("truncation, corrupt gzip CRC and invalid final opacity do not change the target", async () => {
  const crc = zipped.slice(); crc[crc.length - 8] ^= 1;
  const alpha = raw.slice(); alpha[50] = 0xff; alpha[51] = 0x7f;
  for (const bytes of [new Uint8Array(), raw.subarray(0, 1), raw.subarray(0, 51), zipped.subarray(0, zipped.length - 1), crc, alpha]) {
    const target = new Uint32Array(8).fill(77), response = chunks(bytes, 3);
    await assert.rejects(restoreAlpha16Response(response, target, 2, hash));
    assert.ok(target.every(x => x === 77)); assert.equal(response.body!.locked, false);
  }
});

test("invalid count, HTTP status and pre-aborted requests cancel without reading", async () => {
  for (const kind of ["count", "digest", "status", "aborted"]) {
    let pulls = 0, cancelled = false;
    const abort = new AbortController(), reason = new Error("superseded");
    if (kind === "aborted") abort.abort(reason);
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { pulls++; return new Promise(() => {}); }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: kind === "status" ? 503 : 200 });
    await assert.rejects(readAlpha16Response(response, kind === "count" ? MAX_ALPHA16_BYTES : 2,
      kind === "digest" ? new Uint8Array(31) : hash, abort.signal), (e: unknown) => kind !== "aborted" || e === reason);
    assert.equal(pulls, 0); assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
  }
});

for (const prefix of [raw.subarray(0, 1), raw.subarray(0, 48), zipped.subarray(0, 12), raw])
  test(`abort stops a pending ${prefix.length}-byte prefix and leaves target unchanged`, { timeout: 2000 }, async () => {
    const abort = new AbortController(), reason = new Error("scene switched");
    let pulls = 0, cancelled = false, waiting!: () => void;
    const blocked = new Promise<void>(resolve => { waiting = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (++pulls === 1) c.enqueue(prefix); else { waiting(); return new Promise(() => {}); } },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    const target = new Uint32Array(8).fill(77);
    const rejected = assert.rejects(restoreAlpha16Response(response, target, 2, hash, abort.signal), e => e === reason);
    await blocked; abort.abort(reason); await rejected;
    assert.equal(cancelled, true); assert.equal(response.body!.locked, false); assert.ok(target.every(x => x === 77));
  });

test("source failure releases its reader and a subsequent valid request succeeds", async () => {
  const failure = new Error("connection reset"); let reads = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(c) { if (++reads === 1) c.enqueue(raw.subarray(0, 48)); else c.error(failure); },
  }));
  await assert.rejects(readAlpha16Response(response, 2, hash), e => e === failure);
  assert.equal(response.body!.locked, false);
  assert.deepEqual(await readAlpha16Response(chunks(zipped, 2), 2, hash), raw);
});

test("aborting after compressed EOF still prevents publishing decoded data", { timeout: 2000 }, async () => {
  const abort = new AbortController(), reason = new Error("disposed"); let sent = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(c) { if (!sent) { sent = true; c.enqueue(zipped); } else { c.close(); abort.abort(reason); } },
  }, { highWaterMark: 0 }));
  const target = new Uint32Array(8).fill(77);
  await assert.rejects(restoreAlpha16Response(response, target, 2, hash, abort.signal), e => e === reason);
  assert.ok(target.every(x => x === 77)); assert.equal(response.body!.locked, false);
});
