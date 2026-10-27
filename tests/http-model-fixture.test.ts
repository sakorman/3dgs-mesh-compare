import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { modelHttpFixture, type HttpRecord } from "./helpers/http-model-fixture";

async function fixture() {
  const current = { bytes: new Uint8Array(4096).fill(7), digest: "current" };
  const old = { bytes: new Uint8Array(4096).fill(3), digest: "old" };
  const middleware = modelHttpFixture({ pipes: { spz: current, alpha: current, ply: current, oldAlpha: old },
    office: { spz: current, alpha: current, ply: current, oldAlpha: old } });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__model_http/run`;
  return { url, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
    logs: async (): Promise<HttpRecord[]> => (await fetch(`${url}/records`)).json() };
}

test("HTTP fixture emits validators and 304 without a body", async () => {
  const f = await fixture();
  try {
    const first = await fetch(`${f.url}/validate/pipes/spz`);
    assert.equal(first.status, 200); assert.equal(first.headers.get("Cache-Control"), "no-cache");
    assert.equal((await first.arrayBuffer()).byteLength, 4096);
    const validated = await fetch(`${f.url}/validate/pipes/spz`, { headers: { "If-None-Match": first.headers.get("ETag")! } });
    assert.equal(validated.status, 304); assert.equal((await validated.arrayBuffer()).byteLength, 0);
    const changed = await fetch(`${f.url}/validate/pipes/spz`, { headers: { "If-None-Match": '"different"' } });
    assert.equal(changed.status, 200); await changed.arrayBuffer();
    const rows = await f.logs();
    assert.deepEqual(rows.map(x => [x.status, x.bodyBytesOffered, x.finished]), [[200, 4096, true], [304, 0, true], [200, 4096, true]]);
    assert.equal(rows[1].ifNoneMatch, rows[0].etag);
  } finally { await f.close(); }
});

test("HTTP fixture binds versioned URLs and updates mutable aliases per scene", async () => {
  const f = await fixture();
  try {
    const bytes = async (path: string) => new Uint8Array(await (await fetch(f.url + path)).arrayBuffer());
    assert.equal((await bytes("/mutable/pipes/alpha"))[0], 3);
    assert.equal((await fetch(`${f.url}/update/pipes`, { method: "POST" })).status, 204);
    assert.equal((await bytes("/mutable/pipes/alpha"))[0], 7);
    assert.equal((await bytes("/mutable/office/alpha"))[0], 3);
    assert.equal((await bytes("/versioned/pipes/alpha?sha256=old"))[0], 3);
    assert.equal((await bytes("/versioned/pipes/alpha?sha256=current"))[0], 7);
    assert.equal((await fetch(`${f.url}/versioned/pipes/alpha?sha256=unknown`)).status, 404);
  } finally { await f.close(); }
});

test("HTTP fixture cuts or cancels an incomplete response and records the close", async () => {
  const f = await fixture();
  try {
    const cut = await fetch(`${f.url}/cut/pipes/alpha`);
    await assert.rejects(cut.arrayBuffer());
    const controller = new AbortController();
    const slow = await fetch(`${f.url}/slow/pipes/alpha`, { signal: controller.signal });
    const reading = assert.rejects(slow.arrayBuffer()); controller.abort(); await reading;
    let rows = await f.logs();
    for (let attempt = 0; rows.some(x => !x.closed) && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10)); rows = await f.logs();
    }
    assert.deepEqual(rows.map(x => [x.status, x.bodyBytesOffered, x.finished, x.closed]), [[200, 1024, false, true], [200, 1024, false, true]]);
  } finally { await f.close(); }
});
