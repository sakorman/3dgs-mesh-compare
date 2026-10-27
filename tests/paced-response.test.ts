import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { paceResponse, type PacingRecord } from "./helpers/paced-response";

test("paced HTTP delivers exact bytes no earlier than its byte budget", async () => {
  const bytes = new Uint8Array(4096).map((_, i) => i % 251);
  let row: PacingRecord | undefined;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": bytes.length });
    row = paceResponse(res, bytes, { bytesPerSecond: 32768, delayMs: 20, chunkBytes: 512 });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
    assert.equal(row!.bytesOffered, bytes.length); assert.equal(row!.chunks, 8);
    assert.ok(row!.lastChunkMs! >= row!.idealMs);
    assert.ok(row!.firstChunkMs! >= 20 + 512 / 32768 * 1000);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});

test("closing a paced HTTP response cancels further scheduled writes", async () => {
  let row: PacingRecord | undefined;
  let closed!: () => void;
  const onClose = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer((_req, res) => {
    res.once("close", closed);
    res.writeHead(200, { "Content-Length": 1048576 });
    row = paceResponse(res, new Uint8Array(1048576), { bytesPerSecond: 2048, delayMs: 0, chunkBytes: 512 });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { signal: controller.signal });
    const reading = assert.rejects(result.arrayBuffer()); controller.abort(); await reading;
    await onClose;
    const before = row!.bytesOffered;
    assert.ok(before > 0 && before < 1048576);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(row!.bytesOffered, before);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
