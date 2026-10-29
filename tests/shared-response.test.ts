import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter, once } from "node:events";
import { sharedResponsePacer, type SharedPacingRecord } from "./helpers/shared-response";

test("concurrent HTTP bodies share one byte budget and retain exact bytes", async () => {
  const settings = { bytesPerSecond: 16384, delayMs: 20, chunkBytes: 512 };
  const pace = sharedResponsePacer(settings), rows: SharedPacingRecord[] = [];
  const a = new Uint8Array(3072).map((_, i) => i % 251), b = a.slice(0, 2500);
  const server = createServer((req, res) => {
    const data = req.url === "/a" ? a : b;
    res.writeHead(200, { "Content-Length": data.length });
    rows.push(pace(res, data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outputs = await Promise.all(["a", "b"].map(async name => new Uint8Array(await (await fetch(base + "/" + name)).arrayBuffer())));
    assert.deepEqual(outputs, [a, b]);
    const writes = rows.flatMap((row, id) => row.writes.map(([ms, bytes]) => ({ ms, bytes, id }))).sort((a,b) => a.ms-b.ms);
    assert.equal(writes.reduce((n, x) => n+x.bytes, 0), a.length+b.length);
    assert.ok(writes.at(-1)!.ms >= Math.min(...rows.map(row=>row.readyMs)) + (a.length+b.length)/settings.bytesPerSecond*1000);
    for (let i=1;i<writes.length;i++) assert.ok(writes[i].ms-writes[i-1].ms >= writes[i].bytes/settings.bytesPerSecond*1000);
    assert.notEqual(writes[0].id, writes[1].id, "ready responses take turns");
    for (const row of rows) assert.ok(row.writes[0][0] >= row.readyMs + row.writes[0][1]/settings.bytesPerSecond*1000);
  } finally { await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}); }
});

class Sink extends EventEmitter {
  destroyed = false;
  chunks: Uint8Array[] = [];
  constructor(private blocked = false) { super(); }
  write(bytes: Uint8Array) { this.chunks.push(bytes); return !this.blocked; }
  end() { this.emit("finish"); this.close(); }
  close() { this.destroyed=true; this.emit("close"); }
  response() { return this as unknown as ServerResponse; }
}
test("a backpressured or cancelled response does not block another transfer", async () => {
  const pace=sharedResponsePacer({bytesPerSecond:65536,delayMs:0,chunkBytes:512});
  const blocked=new Sink(true), healthy=new Sink();
  const a=pace(blocked.response(),new Uint8Array(4096)), done=once(healthy,"finish");
  const b=pace(healthy.response(),new Uint8Array(1536));
  await done;
  assert.equal(a.bytesOffered,512); assert.equal(b.bytesOffered,1536);
  blocked.close(); blocked.emit("drain");
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(a.bytesOffered,512); assert.equal(blocked.listenerCount("drain"),0);
});
test("cancelling a selected or queued response removes scheduled writes", async () => {
  const pace=sharedResponsePacer({bytesPerSecond:65536,delayMs:0,chunkBytes:512});
  const selected=new Sink(), queued=new Sink(), survivor=new Sink();
  const a=pace(selected.response(),new Uint8Array(512));
  const b=pace(queued.response(),new Uint8Array(512));
  const done=once(survivor,"finish"), c=pace(survivor.response(),new Uint8Array(512));
  selected.close(); queued.close(); await done;
  assert.equal(a.bytesOffered,0); assert.equal(b.bytesOffered,0); assert.equal(c.bytesOffered,512);
  assert.deepEqual(a.writes,[]); assert.deepEqual(b.writes,[]);
});
test("idle time earns no burst credit and invalid shared budgets are rejected", async () => {
  for(const bytesPerSecond of [0,-1,NaN,Infinity]) assert.throws(()=>sharedResponsePacer({bytesPerSecond,delayMs:0,chunkBytes:512}));
  const pace=sharedResponsePacer({bytesPerSecond:65536,delayMs:0,chunkBytes:512});
  await new Promise(resolve=>setTimeout(resolve,20));
  const sink=new Sink(), done=once(sink,"finish"), row=pace(sink.response(),new Uint8Array(1024));
  await done;
  assert.ok(row.writes[0][0]-row.requestedMs>=512/65536*1000);
  assert.ok(row.writes[1][0]-row.writes[0][0]>=512/65536*1000);
});
