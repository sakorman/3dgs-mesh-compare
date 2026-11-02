import {readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";

const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const prior = await read("docs/benchmarks/spz-alpha16-2026-10-27.json");
const priorAttrs = await read("docs/benchmarks/sh-scoped-2026-10-31.json");
const manifest = await read(".qa/scoped-startup/build/manifest.json");
assert.equal(digest(await readFile("src/viewer.ts")), manifest.viewerSha256);
assert.equal(digest(await readFile(".qa/wasm-build/spark.tar.gz")), manifest.archiveSha256);
for (const build of manifest.variants) {
  const dir = build.variant === "rebuilt" ? "rebuild" : "sh-scoped";
  const bytes = await readFile(`.qa/scoped-startup/build/${build.variant}.mjs`);
  assert.equal(bytes.length, build.bytes); assert.equal(digest(bytes), build.sha256);
  const wasm = await readFile(`.qa/wasm-build/${dir}/pkg/spark_rs_bg.wasm`);
  assert.equal(wasm.length, build.wasmBytes); assert.equal(digest(wasm), build.wasmSha256);
  assert.equal(digest(await readFile(`.qa/wasm-build/${dir}/${build.variant}.worker`)), build.workerSha256);
}
const documents = [];
const order = ["rebuilt", "scoped", "scoped", "rebuilt", "rebuilt", "scoped", "scoped", "rebuilt"];
for (const scene of ["pipes", "office"]) for (const [index, variant] of order.entries()) {
  const doc = await read(`.qa/scoped-startup/${scene}-${variant}-${index}.json`);
  assert.equal(doc.scene, scene); assert.equal(doc.variant, variant); assert.equal(doc.documentIndex, index);
  assert.equal(doc.failed, undefined); assert.deepEqual(doc.errors, []); assert.deepEqual(doc.environment.visibility, []);
  assert.deepEqual(doc.manifest, manifest); assert.equal(doc.baseline, "374146f");
  assert.deepEqual(doc.resolution, [768, scene === "pipes" ? 505 : 500]);
  assert.deepEqual(doc.asset, prior.assets.find((a: {scene: string}) => a.scene === scene));
  assert.equal(doc.controls.length, scene === "pipes" ? 5 : 7); assert.equal(doc.attributes.length, 2);
  for (const control of doc.controls) {
    const expected = prior.comparisons.find((c: {scene: string; variant: string; view: string; yaw: number}) =>
      c.scene === scene && c.variant === "alpha16" && c.view === control.view && c.yaw === control.yaw);
    assert.equal(control.hash, expected.hash);
  }
  const expected = priorAttrs.experiments.find((e: {prefix: string}) => e.prefix === "scoped-spz")
    .documents.find((d: {scene: string}) => d.scene === scene).attributeControls[0].attributes;
  for (const attrs of doc.attributes) assert.deepEqual(attrs.buffers, expected);
  assert.equal(doc.samples.length, 2); assert.equal(doc.disposedModels, 2);
  for (const [i, sample] of doc.samples.entries()) {
    assert.equal(sample.index, i);
    assert.equal(sample.state, i ? "warm-runtime-cache-hit" : "first-runtime-cache-miss");
    assert.equal(sample.newWorkers, i ? 0 : 2);
    for (const key of ["loadMs", "settleMs", "totalMs", "modelWaitMs", "runtimeImportMs", "wasmReadyWaitMs", "constructMs"]) {
      assert(Number.isFinite(sample[key]) && sample[key] >= 0);
    }
    assert(Math.abs(sample.modelWaitMs - sample.loadMs - sample.settleMs) < .001);
    // Includes small scheduling/bookkeeping gaps between measured boundaries.
    assert(Math.abs(sample.totalMs - sample.modelWaitMs - sample.runtimeImportMs - sample.wasmReadyWaitMs - sample.constructMs) < 2);
    assert.equal(sample.phases.length, 6);
    assert(sample.phases.every((p: {ms: number; name: string}) => Number.isFinite(p.ms) && p.ms >= 0 && !p.name.startsWith("ply")));
  }
  const build = manifest.variants.find((v: {variant: string}) => v.variant === variant);
  assert.equal(doc.compiles.length, 1); assert.equal(doc.compiles[0].bytes, build.wasmBytes);
  assert(doc.compiles[0].end >= doc.compiles[0].start);
  assert.equal(doc.workers.length, 2);
  const decoder = doc.workers.find((w: {calls: {name: string}[]}) => w.calls.some(c => c.name === "loadExtSplats"));
  const sorter = doc.workers.find((w: {calls: {name: string}[]}) => w.calls.some(c => c.name === "sortSplats32"));
  assert(decoder && sorter && decoder !== sorter); assert.equal(decoder.terminated, undefined);
  assert(Number.isFinite(sorter.terminated));
  const decodes = decoder.calls.filter((c: {name: string}) => c.name === "loadExtSplats");
  assert.equal(decodes.length, 2);
  for (const worker of doc.workers) for (const call of worker.calls) if (call.id !== undefined) {
    assert.equal(call.error, false); assert(call.end >= call.start);
  }
  assert.equal(doc.network.length, 2);
  assert.deepEqual(doc.network.map((n: {kind: string}) => n.kind).sort(), ["alpha", "spz"]);
  for (const net of doc.network) {
    const bytes = net.kind === "spz" ? doc.asset.spzBytes : doc.asset.alphaGzipBytes;
    assert.equal(net.status, 200); assert.equal(net.ifNoneMatch, null);
    assert(net.finished && net.closed); assert.equal(net.bodyBytesOffered, bytes);
    assert.equal(net.shared.bytesOffered, bytes); assert.equal(net.shared.bytesPerSecond, 5 * 1024 ** 2);
    assert.equal(net.shared.delayMs, 40); assert.equal(net.shared.chunkBytes, 65536);
    assert.equal(net.shared.writes.reduce((sum: number, w: number[]) => sum + w[1], 0), bytes);
    const timings = doc.timings.filter((t: {name: string}) => t.name.includes(`/shared/${scene}/${net.kind}?`));
    assert.equal(timings.length, 2); assert.equal(timings[0].responseStatus, 200);
    assert(timings[0].transferSize > 0); assert.equal(timings[0].encodedBodySize, bytes);
    assert.equal(timings[1].transferSize, 0); assert.equal(timings[1].deliveryType, "cache");
    assert.equal(timings[1].encodedBodySize, bytes); assert.equal(timings[1].responseStatus, 200);
  }
  const runtime = doc.timings.filter((t: {name: string}) => t.name.includes(`/build/${variant}.mjs?`));
  assert.equal(runtime.length, 1); assert(runtime[0].transferSize > 0);
  assert.equal(runtime[0].responseStatus, 200);
  documents.push(doc);
}
const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b), n = sorted.length;
  return {n, median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    min: sorted[0], max: sorted[n - 1]};
};
const summary = [];
for (const scene of ["pipes", "office"]) for (const variant of ["rebuilt", "scoped"]) {
  const docs = documents.filter(d => d.scene === scene && d.variant === variant);
  const metrics = [0, 1].map(index => {
    const samples = docs.map(d => d.samples[index]);
    return {state: samples[0].state,
      ...Object.fromEntries(["totalMs", "loadMs", "modelWaitMs", "runtimeImportMs", "wasmReadyWaitMs", "constructMs", "settleMs"]
        .map(k => [k, stats(samples.map(s => s[k]))])),
      phases: Object.fromEntries(samples[0].phases.map((p: {name: string}) => [p.name,
        stats(samples.map(s => s.phases.find((r: {name: string}) => r.name === p.name).ms))])),
      decodeRoundTripMs: stats(docs.map(d => {
        const calls = d.workers.flatMap((w: {calls: {name: string; start: number; end: number}[]}) => w.calls)
          .filter((c: {name: string}) => c.name === "loadExtSplats");
        return calls[index].end - calls[index].start;
      })),
    };
  });
  summary.push({scene, variant, metrics, compilePromiseMs: stats(docs.map(d => d.compiles[0].end - d.compiles[0].start)),
    servedRuntimeBodyBytes: [...new Set(docs.flatMap(d => d.timings.filter((t: {name: string}) => t.name.includes(".mjs?"))
      .map((t: {encodedBodySize: number}) => t.encodedBodySize)))],
    modelBodySupplyMiBPerSec: stats(docs.map(d => {
      const writes = d.network.flatMap((n: {shared: {writes: number[][]}}) => n.shared.writes);
      const ready = Math.min(...d.network.map((n: {shared: {readyMs: number}}) => n.shared.readyMs));
      return d.asset.combinedBytes / (Math.max(...writes.map((w: number[]) => w[0])) - ready) * 1000 / 1024 ** 2;
    })),
  });
}
const sourceHashes: Record<string, string> = {};
for (const path of ["scripts/prepare_scoped_startup.ts", "scripts/report_scoped_startup.ts", "tests/browser/scoped-startup.ts",
  "tests/browser/scoped-startup.html", "tests/browser/vite-scoped-startup.config.ts", "tests/browser/vite-http-model.config.ts",
  "tests/helpers/http-model-fixture.ts", "tests/helpers/shared-response.ts", "tests/helpers/paired-model.ts", "src/viewer.ts"]) {
  sourceHashes[path] = digest(await readFile(path));
}
const report = {createdAt: new Date().toISOString(), baseline: "374146f", manifest, sourceHashes, summary, documents,
  checks: {documents: documents.length, samples: documents.length * 2,
    pixels: documents.reduce((n, d) => n + d.controls.length, 0), attributes: documents.length * 2,
    disposedModels: documents.reduce((n, d) => n + d.disposedModels, 0)},
  limitations: [
    "Two ABBA sequences per scene, four first-runtime and four warm-cache samples per variant/scene. No timed sample discarded as warmup.",
    "New document/runtime objects, one selected main WASM compile invocation and matching Worker bindings. Browser process/JIT/WASM/shader/HTTP code caches not reset.",
    "First interval starts at dynamic runtime import after fixture/manifest/camera loading; excludes navigation and earlier page setup. No input preloading.",
    "Vite development module transformation and inline source maps are included in runtime import; standalone bundle bytes differ from served bytes. Not a production startup or CDN result.",
    "SPZ/AP16 alone share a 5MiB/s body supply ceiling and 40ms per-response server hold. Runtime JavaScript is unthrottled. Not RTT, loss or public network simulation.",
    "Second sample reuses the document, renderer, WASM, Worker and exact HTTP URLs; bytes are still read, validated and decoded. One repeat per document.",
    "Compile Promise elapsed and Worker RPC round trips are wall-clock diagnostics; compile overlaps module import. Settled draw submission is not GPU execution or screen presentation.",
    "Same complete six attribute buffers and pixel controls as existing alpha16 candidate. Original PLY quantization loss remains; no new PSNR/SSIM, continuous-motion or memory-peak claim.",
    "Initial preflight with the general HTTP Vite config was reloaded by dependency discovery and produced no completed sample. Formal samples use isolated pre-optimized dependencies.",
    "Default production entry points, dependencies and assets unchanged. Production integration requires release-build startup, peak memory and real network validation.",
  ]};
await writeFile("docs/benchmarks/scoped-startup-2026-11-02.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({checks: report.checks, summary}, null, 2));
