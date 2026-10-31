import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const previous = JSON.parse(await readFile("docs/benchmarks/wasm-internal-2026-10-31.json", "utf8"));
const documents = [];
const summary = [];
const metrics = ["initializeMs", "roundTripMs", "prepareMs", "settleMs", "totalMs"];
const stats = (values: number[]) => {
  assert(values.every(x => Number.isFinite(x) && x >= 0));
  const a = values.toSorted((x, y) => x - y), mid = a.length / 2;
  return {count: a.length, median: (a[Math.floor(mid)] + a[Math.ceil(mid) - 1]) / 2, min: a[0], max: a.at(-1)};
};
for (const scene of ["pipes", "office"]) {
  const expected = previous.rebuild.documents.find((d: {scene: string}) => d.scene === scene);
  for (let index = 0; index < 4; index++) {
    const doc = JSON.parse(await readFile(`.qa/wasm-build/sh-grid/browser-${scene}-${index}.json`, "utf8"));
    assert.equal(doc.scene, scene); assert.equal(doc.documentIndex, index);
    assert.equal(doc.variant, ["rebuilt", "candidate", "candidate", "rebuilt"][index]);
    assert.deepEqual(doc.errors, []); assert.deepEqual(doc.environment.visibility, []);
    assert.deepEqual(doc.variant === "rebuilt" ? doc.probeManifest : doc.probeManifest.baseline, expected.probeManifest);
    assert.deepEqual(doc.asset, expected.asset); assert.deepEqual(doc.resolution, expected.resolution);
    assert.equal(doc.disposedModels, 5); assert.equal(doc.moduleReplacements, 2);
    assert.equal(doc.workers.length, 2); assert.equal(doc.samples.length, 5);
    assert.equal(doc.samples.filter((s: {warmup: boolean}) => s.warmup).length, 1);
    assert.equal(doc.controls.length, scene === "pipes" ? 8 : 10);
    assert.equal(doc.attributeControls.length, 5);
    for (const row of doc.attributeControls) assert.deepEqual(row.attributes, expected.attributeControls[0].attributes);
    for (const row of doc.controls) {
      assert.equal(row.hash, expected.controls.find((x: {view: string; yaw: number}) => x.view === row.view && x.yaw === row.yaw).hash);
    }
    documents.push(doc);
  }
  for (const variant of ["rebuilt", "candidate"]) {
    const docs = documents.filter(d => d.scene === scene && d.variant === variant);
    const samples = docs.flatMap(d => d.samples).filter(s => !s.warmup);
    summary.push({scene, variant, metrics: Object.fromEntries(metrics.map(k => [k, stats(samples.map(s => s[k]))])),
      perDocument: docs.map(d => ({index: d.documentIndex,
        metrics: Object.fromEntries(metrics.map(k => [k, stats(d.samples.filter((s: {warmup: boolean}) => !s.warmup).map((s: Record<string, number>) => s[k]))]))}))});
  }
}
const report = {date: "2026-10-31", baseline: "9f8f886", documents, summary,
  validation: {formalSamples: 32, warmupSamples: 8, attributeControls: 40, pixelControls: 72,
    matchesPrevious: true, failures: [], verification: JSON.parse(await readFile(".qa/wasm-build/sh-grid/verification.json", "utf8"))},
  limits: ["Independent candidate build, not production integration or a dependency upgrade.",
    "Preloaded inputs and compiled WASM; not HTTP or process cold loading.",
    "Total ends at settled draw submission, not GPU completion or screen presentation.",
    "Unchanged candidate pixels do not remove the existing SH8/AP16 versus PLY quantization cost.",
    "No change to SH order, count, resolution, LoD, shaders, photos, cameras or split.",
    "General-value encoding correctness sampled, not exhaustive for all floating-point triples; other-format performance pending.",
    "Peak memory, WebGPU/CUDA/other devices, continuous roaming and candidate HTTP/cancel/fallback integration unverified."]};
await writeFile("docs/benchmarks/sh-grid-2026-10-31.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({summary, validation: report.validation}, null, 2));
