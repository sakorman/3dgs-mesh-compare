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

for (const gzip of [false, true])
  test(
    `invalid ${gzip ? "gzip" : "plain"} header rejects before consuming the remaining body`,
    { timeout: 3000 },
    async () => {
      const invalid = new Uint8Array(1024 * 1024);
      let seed = 42;
      for (let i = 0; i < invalid.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        invalid[i] = seed & 255;
      }
      invalid.set(new TextEncoder().encode("<html>"));
      const bytes = gzip ? gzipSync(invalid) : invalid;
      let offset = 0;
      let cancelled = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // The rest of the response has not arrived; rejection must not need EOF.
            if (offset >= 4096) return new Promise<void>(() => {});
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 1024, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      await assert.rejects(readPlyResponse(response), /无效/);
      assert.equal(cancelled, true, "must cancel the remaining upstream body");
      assert.ok(
        offset < bytes.length / 4,
        `unexpected read-ahead: ${offset}/${bytes.length}`,
      );
      assert.equal(response.body!.locked, false);
      assert.deepEqual(
        new Uint8Array(await decodePly(fixture.buffer)),
        fixture,
      );
    },
  );

test("short or mismatched PLY signatures reject across byte boundaries", async () => {
  for (const text of ["p", "pl", "ply", "plx\n", "ply\r\n"]) {
    const raw = new TextEncoder().encode(text);
    for (const bytes of [raw, gzipSync(raw)]) {
      const response = chunked(bytes, 1);
      await assert.rejects(readPlyResponse(response), /无效/);
      assert.equal(response.body!.locked, false);
    }
  }
});

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

for (const gzip of [false, true]) {
  test(`decoded length accepts exact ${gzip ? "gzip" : "plain"} data independently of HTTP Content-Length`, async () => {
    const bytes = gzip ? gzipSync(fixture) : fixture;
    const response = chunked(bytes, 1, { "Content-Length": String(gzipSync(fixture).length), "Content-Encoding": "gzip" });
    assert.deepEqual(new Uint8Array(await readPlyResponse(response, undefined, fixture.length)), fixture);
    assert.equal(response.body!.locked, false);
  });
  test(`decoded length rejects short and oversized ${gzip ? "gzip" : "plain"} payloads`, async () => {
    for (const difference of [-1, 1]) {
      const response = chunked(gzip ? gzipSync(fixture) : fixture, 5);
      await assert.rejects(readPlyResponse(response, undefined, fixture.length + difference),
        difference < 0 ? /超出场景记录/ : /与场景记录不符/);
      assert.equal(response.body!.locked, false);
    }
  });
  test(`oversized ${gzip ? "gzip" : "plain"} PLY cancels an unfinished source without waiting for EOF`, { timeout: 3000 }, async () => {
    const raw = new Uint8Array(1024 * 1024);
    let seed = 42;
    for (let i = 0; i < raw.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i] = seed & 255; }
    raw.set(new TextEncoder().encode("ply\n"));
    const bytes = gzip ? gzipSync(raw) : raw;
    let supplied = 0, cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (supplied >= 65536) return new Promise<void>(() => {});
        controller.enqueue(bytes.subarray(supplied, supplied + 1024)); supplied += 1024;
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    await assert.rejects(readPlyResponse(response, undefined, 64), /超出场景记录/);
    assert.ok(cancelled); assert.ok(supplied <= 65536 && supplied < bytes.length); assert.equal(response.body!.locked, false);
  });
}

test("invalid decoded length cancels the body before its first pull", async () => {
  for (const expected of [0, 3, -1, 5.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    let pulls = 0, cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { pulls++; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    await assert.rejects(readPlyResponse(response, undefined, expected), /长度配置无效/);
    assert.equal(pulls, 0); assert.ok(cancelled); assert.equal(response.body!.locked, false);
  }
});
