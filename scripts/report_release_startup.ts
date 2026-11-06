import {readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import * as ts from "typescript";

const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const prior = await read("docs/benchmarks/spz-alpha16-2026-10-27.json");
const priorAttrs = await read("docs/benchmarks/sh-scoped-2026-10-31.json");
const manifest = await read(".qa/release-startup/site/manifest.json");
const measuredManifest = (await read(".qa/release-startup/samples/pipes-rebuilt-0.json")).manifest;
for (const key of ["source", "toolchain", "files", "variants", "method"]) assert.deepEqual(measuredManifest[key], manifest[key]);
const builderPath = "scripts/build_release_startup.ts";
for (const [path, hash] of Object.entries(measuredManifest.sourceHashes)) {
  if (path !== builderPath) assert.equal(hash, manifest.sourceHashes[path]);
}
// Preserve original sample provenance when only an erased build-script type changes.
if (measuredManifest.sourceHashes[builderPath] !== manifest.sourceHashes[builderPath]) {
  const original = await readFile(".qa/release-startup/measured-builder.ts", "utf8");
  const current = await readFile(builderPath, "utf8");
  assert.equal(digest(Buffer.from(original)), measuredManifest.sourceHashes[builderPath]);
  const emit = (source: string) => ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }}).outputText;
  assert.equal(emit(original), emit(current));
}
const source = manifest.source;
assert.equal(digest(await readFile("src/viewer.ts")), source.viewerSha256);
assert.equal(digest(await readFile(".qa/wasm-build/spark.tar.gz")), source.archiveSha256);
for (const [path, hash] of Object.entries(manifest.sourceHashes)) assert.equal(digest(await readFile(path)), hash);
for (const build of manifest.variants) {
  const dir = build.variant === "rebuilt" ? "rebuild" : "sh-scoped";
  assert.equal(digest(await readFile(`.qa/scoped-startup/build/${build.variant}.mjs`)), build.sha256);
  const wasm = await readFile(`.qa/wasm-build/${dir}/pkg/spark_rs_bg.wasm`);
  assert.equal(wasm.length, build.wasmBytes); assert.equal(digest(wasm), build.wasmSha256);
  assert.equal(digest(await readFile(`.qa/wasm-build/${dir}/${build.variant}.worker`)), build.workerSha256);
}
for (const file of manifest.files) {
  for (const gzip of [false,true]) {
    const b=await readFile(`.qa/release-startup/site${file.url}${gzip?".gz":""}`);
    assert.equal(b.length, gzip?file.gzipBytes:file.bytes); assert.equal(digest(b), gzip?file.gzipSha256:file.sha256);
  }
}
const documents = [];
const order = ["rebuilt", "scoped", "scoped", "rebuilt", "rebuilt", "scoped", "scoped", "rebuilt"];
for (const scene of ["pipes", "office"]) for (const [index, variant] of order.entries()) {
  const doc = await read(`.qa/release-startup/samples/${scene}-${variant}-${index}.json`);
  assert.equal(doc.scene, scene); assert.equal(doc.variant, variant); assert.equal(doc.documentIndex, index);
  assert.equal(doc.failed, undefined); assert.deepEqual(doc.errors, []); assert.deepEqual(doc.environment.visibility, []);
  assert.deepEqual(doc.manifest, measuredManifest); assert.equal(doc.baseline, "2cc5134");
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
  const entry=manifest.files.find((f:{entry:string})=>f.entry===variant);
  const required=[entry.url,...entry.imports];
  for(const url of required) {
    const file=manifest.files.find((f:{url:string})=>f.url===url);
    const rows=doc.timings.filter((t:{name:string})=>new URL(t.name).pathname===url);
    assert.equal(rows.length,1);
    assert.equal(rows[0].responseStatus,200);assert(rows[0].transferSize>0);
    assert.equal(rows[0].encodedBodySize,file.gzipBytes);assert.equal(rows[0].decodedBodySize,file.bytes);
    assert(rows[0].name.includes("/assets/"));assert.equal(rows[0].deliveryType,"");
  }
  assert(!doc.timings.some((t:{name:string})=>/node_modules|@vite|\.mjs/.test(t.name)));
  documents.push(doc);
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
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
    servedRuntimeBodyBytes: [...new Set(docs.flatMap(d => d.timings.filter((t: {name: string}) => new URL(t.name).pathname === manifest.variants.find((b:{variant:string})=>b.variant===variant).url)
      .map((t: {encodedBodySize: number}) => t.encodedBodySize)))],
    modelBodySupplyMiBPerSec: stats(docs.map(d => {
      const writes = d.network.flatMap((n: {shared: {writes: number[][]}}) => n.shared.writes);
      const ready = Math.min(...d.network.map((n: {shared: {readyMs: number}}) => n.shared.readyMs));
      return d.asset.combinedBytes / (Math.max(...writes.map((w: number[]) => w[0])) - ready) * 1000 / 1024 ** 2;
    })),
  });
}
const sourceHashes: Record<string, string> = {};
for (const path of ["scripts/build_release_startup.ts", "scripts/serve_release_startup.ts", "scripts/report_release_startup.ts", "tests/browser/release-startup.ts",
  "tests/browser/release-startup.html",
  "tests/helpers/http-model-fixture.ts", "tests/helpers/shared-response.ts", "tests/helpers/paired-model.ts", "src/viewer.ts"]) {
  sourceHashes[path] = digest(await readFile(path));
}
const report = {createdAt: new Date().toISOString(), baseline: "2cc5134", manifest, measuredManifest, sourceHashes, summary, documents,
  checks: {documents: documents.length, samples: documents.length * 2,
    pixels: documents.reduce((n, d) => n + d.controls.length, 0), attributes: documents.length * 2,
    disposedModels: documents.reduce((n, d) => n + d.disposedModels, 0)},
  limitations: [
    "Two ABBA sequences per scene, four first-runtime and four warm-cache samples per variant/scene. No timed sample discarded as warmup.",
    "New document/runtime objects, one selected main WASM compile invocation and matching Worker bindings. Browser process/JIT/WASM/shader/HTTP code caches not reset.",
    "First interval starts at dynamic runtime import after fixture/manifest/camera loading; excludes navigation and earlier page setup. No input preloading.",
    "Static ES2022/minified Vite multi-entry build, no source maps or dev transformation. Code gzip level 6 with no-store; decoded and encoded body lengths checked against build files. Loopback delivery is unthrottled for code, not public CDN.",
    "SPZ/AP16 alone share a 5MiB/s body supply ceiling and 40ms per-response server hold. Runtime JavaScript is unthrottled. Not RTT, loss or public network simulation.",
    "Second sample reuses the document, renderer, WASM, Worker and exact HTTP URLs; bytes are still read, validated and decoded. One repeat per document.",
    "Compile Promise elapsed and Worker RPC round trips are wall-clock diagnostics; compile overlaps module import. Settled draw submission is not GPU execution or screen presentation.",
    "Same complete six attribute buffers and pixel controls as existing alpha16 candidate. Original PLY quantization loss remains; no new PSNR/SSIM, continuous-motion or memory-peak claim.",
    "An initial build was archived before collecting samples to fix an omitted oldAlpha fixture field. No completed timing sample discarded. Static served files match manifest and source hashes.",
    "A build-script array type was added after sampling. Original sample manifests remain intact; erased script output and rebuilt raw/gzip assets are byte-identical. No timing rerun or sample replacement.",
    "Default production entry points, dependencies and assets unchanged. This validates a static experimental release bundle; process-cold startup, peak memory, actual Pages compression and real CDN remain unverified.",
  ]};
await writeFile("docs/benchmarks/release-startup-2026-11-06.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({checks: report.checks, summary}, null, 2));
