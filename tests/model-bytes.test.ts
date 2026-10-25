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

import { readPlyResponse } from "../src/model-bytes";

function chunked(bytes: Uint8Array, size: number, headers?: HeadersInit) {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, offset + size);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
    { headers },
  );
}
const fixture = new TextEncoder().encode(
  "ply\nformat binary_little_endian 1.0\nend_header\n123456789",
);

test("gzip and PLY headers split into single-byte chunks decode exactly", async () => {
  for (const bytes of [fixture, gzipSync(fixture)]) {
    assert.deepEqual(
      new Uint8Array(await readPlyResponse(chunked(bytes, 1))),
      fixture,
    );
  }
});

test("HTTP gzip headers do not trigger double decompression of an already decoded body", async () => {
  assert.deepEqual(
    new Uint8Array(
      await readPlyResponse(
        chunked(fixture, 3, { "Content-Encoding": "gzip" }),
      ),
    ),
    fixture,
  );
});

test("compressed input is streamed without buffering the original response", async () => {
  const response = chunked(gzipSync(fixture), 5);
  response.arrayBuffer = async () => {
    throw new Error("compressed response must not be buffered");
  };
  assert.deepEqual(new Uint8Array(await readPlyResponse(response)), fixture);
});

test("empty chunks are ignored and invalid or truncated bodies reject", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(fixture);
        controller.close();
      },
    }),
  );
  assert.deepEqual(new Uint8Array(await readPlyResponse(response)), fixture);
  await assert.rejects(readPlyResponse(new Response(null)), /无效/);
  await assert.rejects(
    readPlyResponse(chunked(new Uint8Array([0x1f]), 1)),
    /无效/,
  );
  await assert.rejects(
    readPlyResponse(chunked(gzipSync(fixture).subarray(0, 15), 2)),
  );
  await assert.rejects(
    readPlyResponse(
      chunked(gzipSync(new TextEncoder().encode("not a PLY")), 3),
    ),
    /无效/,
  );
});

test("an already cancelled read does not consume the response and releases its lock", async () => {
  const abort = new AbortController();
  abort.abort();
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(readPlyResponse(response, abort.signal), {
    name: "AbortError",
  });
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

for (const gzip of [false, true])
  test(
    `cancel while ${gzip ? "decompressing gzip" : "reading plain PLY"} stops the source`,
    { timeout: 3000 },
    async () => {
      const abort = new AbortController();
      let cancelled = false,
        pulls = 0;
      let waiting!: () => void;
      const blocked = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const bytes = gzip ? gzipSync(fixture) : fixture;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (++pulls === 1) {
              controller.enqueue(bytes.subarray(0, gzip ? 12 : 4));
              return;
            }
            waiting();
            return new Promise<void>(() => {});
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      const rejected = assert.rejects(readPlyResponse(response, abort.signal), {
        name: "AbortError",
      });
      await blocked;
      abort.abort();
      await rejected;
      assert.equal(cancelled, true);
      assert.equal(response.body!.locked, false);
      assert.equal(pulls, 2);
    },
  );

test("source read failures reach the caller and release the reader lock", async () => {
  const failure = new Error("network interrupted");
  let count = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++count === 1) controller.enqueue(fixture.subarray(0, 4));
        else controller.error(failure);
      },
    }),
  );
  await assert.rejects(readPlyResponse(response), (error) => error === failure);
  assert.equal(response.body!.locked, false);
});

test("cancel after the compressed source closes still rejects the decoded result", async () => {
  const abort = new AbortController();
  const raw = new Uint8Array(1024 * 1024);
  raw.set(new TextEncoder().encode("ply\n"));
  const encoded = gzipSync(raw);
  let sent = false,
    closed = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoded);
            return;
          }
          closed = true;
          controller.close();
          queueMicrotask(() => abort.abort());
        },
      },
      { highWaterMark: 0 },
    ),
  );
  await assert.rejects(readPlyResponse(response, abort.signal), {
    name: "AbortError",
  });
  assert.equal(sent, true);
  assert.equal(closed, true);
  assert.equal(response.body!.locked, false);
});
