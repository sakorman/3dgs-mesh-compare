import test from "node:test";
import assert from "node:assert/strict";
import { PairedModelLoader, elapsedModelPhases, hashHex, sha256, type ModelFormat } from "./helpers/paired-model";
import { encodeAlpha16 } from "./helpers/alpha16";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture() {
  const spz = new Uint8Array([1, 2, 3]);
  const ply = new TextEncoder().encode("ply\nmock");
  const alpha = encodeAlpha16(new Uint32Array([0, 0, 0, 0x3800]), 1, await sha256(spz));
  const spec = { count: 1, spzUrl: "spz", alphaUrl: "alpha", plyUrl: "ply",
    spzSha256: hashHex(await sha256(spz)), alphaRawSha256: hashHex(await sha256(alpha)), plySha256: hashHex(await sha256(ply)) };
  type Model = { format: ModelFormat; words: Uint32Array; freed: number; count: number; sh: number };
  const files = new Map<string, Uint8Array>([["spz", spz], ["alpha", alpha], ["ply", ply]]);
  const requests: string[] = [], models: Model[] = [], published: Model[] = [];
  let visible: Model | undefined;
  const driver = {
    async fetch(url: string, _signal: AbortSignal): Promise<Response> {
      requests.push(url); return files.has(url) ? new Response(files.get(url)!) : new Response(null, { status: 404 });
    },
    create(_bytes: Uint8Array, format: ModelFormat) {
      const model = { format, words: new Uint32Array([1, 2, 3, 0xabcd3000]), freed: 0, count: 1, sh: 3 };
      models.push(model); return model;
    },
    async initialized(_model: Model) {},
    attributes: (model: Model) => ({ count: model.count, sh: model.sh, words: model.words }),
    prepare(_model: Model) {},
    publish(model: Model) { visible = model; published.push(model); },
    dispose(model: Model) { model.freed++; if (visible === model) visible = undefined; },
  };
  const loader = new PairedModelLoader(driver);
  return { loader, driver, files, spec, spz, ply, alpha, models, published, requests, visible: () => visible };
}

test("paired load publishes restored opacity and releases the previous model exactly once", async () => {
  const f = await fixture();
  const a = await f.loader.load(f.spec);
  assert.equal(a.format, "spz");
  assert.deepEqual([...a.model.words], [1, 2, 3, 0xabcd3800]);
  const b = await f.loader.load(f.spec);
  assert.equal(a.model.freed, 1); assert.equal(f.visible(), b.model);
  f.loader.dispose(); f.loader.dispose();
  assert.equal(b.model.freed, 1); assert.equal(f.visible(), undefined);
});

test("wrong SPZ, sidecar binding, stale alpha and missing sidecar each fall back once", async () => {
  for (const failure of ["spz", "binding", "stale-alpha", "missing"]) {
    const f = await fixture();
    if (failure === "spz") f.spz[0]++;
    if (failure === "binding") f.alpha[16]++;
    if (failure === "stale-alpha") f.alpha[48]++; // Still a valid half value; header hash is unchanged.
    if (failure === "missing") f.files.delete("alpha");
    const result = await f.loader.load(f.spec);
    assert.equal(result.format, "ply", failure); assert.ok(result.fallbackReason);
    assert.equal(f.requests.filter(x => x === "ply").length, 1);
    assert.equal(f.models.length, 1); assert.equal(f.published.length, 1);
    f.loader.dispose(); assert.equal(result.model.freed, 1);
  }
});

test("failed fallback retains the displayed model and rejects with both failures", async () => {
  const f = await fixture();
  const old = await f.loader.load(f.spec);
  f.files.delete("alpha"); f.ply[4]++;
  await assert.rejects(f.loader.load(f.spec), (error: AggregateError) => error.errors.length === 2);
  assert.equal(f.visible(), old.model); assert.equal(old.model.freed, 0);
  assert.equal(f.published.length, 1);
  f.loader.dispose();
});

test("cancel a pending fetch without starting PLY or publishing", async () => {
  const f = await fixture(), started = deferred();
  let aborted = false;
  f.driver.fetch = async (_url, signal) => new Promise((_yes, no) => {
    signal.addEventListener("abort", () => { aborted = true; no(signal.reason); }, { once: true });
    started.resolve();
  });
  const pending = f.loader.load(f.spec);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await started.promise; f.loader.cancel(); await rejection;
  assert.equal(aborted, true); assert.equal(f.models.length, 0); assert.equal(f.requests.length, 0);
});

test("late initialization after replacement never publishes or disposes the newer model", async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  f.driver.initialized = async model => { if (model === f.models[0]) { entered.resolve(); await gate.promise; } };
  const old = f.loader.load(f.spec);
  const rejected = assert.rejects(old, { name: "AbortError" });
  await entered.promise;
  const current = await f.loader.load(f.spec);
  assert.equal(f.models[0].freed, 0); // Still initializing; premature disposal is unsafe.
  gate.resolve(); await rejected;
  assert.equal(f.models[0].freed, 1); assert.equal(current.model.freed, 0);
  assert.deepEqual(f.published, [current.model]); assert.equal(f.visible(), current.model);
  assert.equal(f.requests.includes("ply"), false);
  f.loader.dispose();
});

test("dispose during initialization cleans late success and rejects subsequent loads", async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  f.driver.initialized = async () => { entered.resolve(); await gate.promise; };
  const pending = f.loader.load(f.spec), rejection = assert.rejects(pending, { name: "AbortError" });
  await entered.promise; f.loader.dispose(); f.loader.dispose(); gate.resolve(); await rejection;
  assert.equal(f.models[0].freed, 1); assert.equal(f.published.length, 0);
  await assert.rejects(f.loader.load(f.spec), /disposed/);
});

test("initialization rejection, count, SH and preparation failures release candidates before fallback", async () => {
  for (const failure of ["initialize", "count", "sh", "prepare"]) {
    const f = await fixture();
    f.driver.initialized = async model => {
      if (model.format === "spz") {
        if (failure === "initialize") throw new Error("Decoder failure");
        if (failure === "count") model.count = 2;
        if (failure === "sh") model.sh = 2;
      }
    };
    f.driver.prepare = model => { if (failure === "prepare" && model.format === "spz") throw new Error("Prepare failure"); };
    const result = await f.loader.load(f.spec);
    assert.equal(result.format, "ply"); assert.equal(f.models[0].freed, 1);
    assert.deepEqual(f.published, [result.model]); f.loader.dispose();
    assert.deepEqual(f.models.map(x => x.freed), [1, 1]);
  }
});

test("manifest identity is snapshotted; invalid manifests do not cancel an active load", async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  f.driver.initialized = async () => { entered.resolve(); await gate.promise; };
  const pending = f.loader.load(f.spec);
  await entered.promise;
  f.spec.count = 2;
  await assert.rejects(f.loader.load({ ...f.spec, spzSha256: "invalid" }), /manifest/);
  gate.resolve(); assert.equal((await pending).format, "spz");
  f.loader.dispose();
});

test("late initialization rejection after cancellation releases once and never falls back", async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  f.driver.initialized = async () => { entered.resolve(); await gate.promise; };
  const pending = f.loader.load(f.spec), rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise; f.loader.cancel(); gate.reject(new Error("Late decode error")); await rejected;
  assert.equal(f.models[0].freed, 1); assert.equal(f.published.length, 0);
  assert.equal(f.requests.includes("ply"), false); f.loader.dispose();
});

test("cancel during a sidecar body or PLY fallback preserves the existing display", async () => {
  for (const target of ["alpha", "ply"]) {
    const f = await fixture(), entered = deferred();
    const current = await f.loader.load(f.spec);
    const fetchFile = f.driver.fetch;
    let cancelled = false;
    f.driver.fetch = async (url, signal) => {
      if (url !== target) return fetchFile(url, signal);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue((target === "alpha" ? f.alpha : f.ply).slice(0, 1)); entered.resolve(); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }));
    };
    if (target === "ply") f.files.delete("alpha");
    const pending = f.loader.load(f.spec), rejected = assert.rejects(pending, { name: "AbortError" });
    await entered.promise; f.loader.cancel(); await rejected;
    assert.equal(cancelled, true); assert.equal(f.visible(), current.model);
    assert.equal(current.model.freed, 0); assert.equal(f.models.length, 1);
    f.loader.dispose();
  }
});


test("direct PLY control skips candidate requests and shares integrity and ownership checks", async () => {
  const f = await fixture();
  const result = await f.loader.load(f.spec, "ply");
  assert.deepEqual(f.requests, ["ply"]); assert.equal(result.format, "ply");
  assert.equal(result.fallbackReason, undefined);
  assert.deepEqual(result.phases.map(p => p.name), ["ply-read", "ply-hash", "ply-initialize", "ply-prepare-publish"]);
  assert.ok(result.phases.every(p => Number.isFinite(p.ms) && p.ms >= 0));
  f.ply[4]++;
  await assert.rejects(f.loader.load(f.spec, "ply"), /digest mismatch/);
  assert.equal(f.visible(), result.model); assert.equal(f.models.length, 1);
  f.loader.dispose(); assert.equal(result.model.freed, 1);
});

test("candidate requests overlap but cannot initialize before both files are verified", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  const original = f.driver.fetch;
  f.driver.fetch = async (url, signal) => {
    if (url === "spz") { entered.resolve(); await gate.promise; }
    return original(url, signal);
  };
  const pending = f.loader.load(f.spec);
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.ok(f.requests.includes("alpha"), "sidecar should start while SPZ is pending");
    assert.equal(f.models.length, 0);
  } finally { gate.resolve(); await pending; f.loader.dispose(); }
});

test("sidecar failure aborts an outstanding SPZ request before PLY fallback", async () => {
  const f = await fixture(), started = deferred();
  const original = f.driver.fetch;
  let aborted = false, fallbackAfterAbort = false;
  f.driver.fetch = async (url, signal) => {
    if (url === "spz") return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      started.resolve();
    });
    if (url === "alpha") { await started.promise; return new Response(null, {status:404}); }
    fallbackAfterAbort = aborted;
    return original(url, signal);
  };
  const result = await f.loader.load(f.spec);
  assert.equal(result.format, "ply"); assert.equal(fallbackAfterAbort, true);
  assert.equal(f.models.length, 1); f.loader.dispose();
});

test("SPZ digest failure cancels the sidecar body and never publishes partial data", async () => {
  const f = await fixture(), original = f.driver.fetch;
  let cancelled = false;
  f.spz[0]++;
  f.driver.fetch = async (url, signal) => url !== "alpha" ? original(url, signal) :
    new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(f.alpha.slice(0, 1)); },
      cancel() { cancelled = true; },
    }, {highWaterMark:0}));
  const result = await f.loader.load(f.spec);
  assert.equal(result.format, "ply"); assert.equal(cancelled, true);
  assert.equal(f.published.length, 1); f.loader.dispose();
});

test("late ignored sibling cannot mutate a completed fallback report", async () => {
  const f = await fixture(), gate = deferred(), original = f.driver.fetch;
  let cancelled = false;
  f.driver.fetch = async (url, signal) => {
    if (url === "alpha") return new Response(null, {status:404});
    if (url === "spz") {
      await gate.promise;
      return new Response(new ReadableStream({cancel() { cancelled = true; }}));
    }
    return original(url, signal);
  };
  const result = await f.loader.load(f.spec);
  assert.equal(result.format, "ply");
  const snapshot = JSON.stringify(result.phases);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(JSON.stringify(result.phases), snapshot);
  assert.deepEqual(f.published, [result.model]); f.loader.dispose();
});

test("cancellation aborts both concurrent requests and never fetches fallback", async () => {
  const f = await fixture(), started = deferred();
  const aborted: string[] = [], requests: string[] = [];
  f.driver.fetch = async (url, signal) => {
    requests.push(url);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted.push(url); reject(signal.reason); }, {once:true});
      if (requests.length === 2) started.resolve();
    });
  };
  const pending = f.loader.load(f.spec), rejection = assert.rejects(pending, {name:"AbortError"});
  await started.promise; f.loader.cancel(); await rejection;
  assert.deepEqual(requests.sort(), ["alpha","spz"]);
  assert.deepEqual(aborted.sort(), ["alpha","spz"]); assert.equal(f.models.length, 0);
});

test("parallel phase accounting uses interval union without mutating samples", () => {
  const phases = [
    {name:"hash",startMs:4,endMs:5,ms:1},
    {name:"read",startMs:0,endMs:4,ms:4},
    {name:"sidecar",startMs:1,endMs:3,ms:2},
    {name:"initialize",startMs:7,endMs:9,ms:2},
  ];
  const copy = structuredClone(phases);
  assert.equal(elapsedModelPhases(phases),7);
  assert.equal(elapsedModelPhases([]),0);
  assert.deepEqual(phases,copy);
});
