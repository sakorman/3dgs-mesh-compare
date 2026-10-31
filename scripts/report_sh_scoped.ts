import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const base = JSON.parse(await readFile(".qa/wasm-build/rebuild/manifest.json", "utf8"));
const grid = JSON.parse(await readFile("docs/benchmarks/sh-grid-2026-10-31.json", "utf8"));
const original = JSON.parse(await readFile("docs/benchmarks/spz-alpha16-2026-10-27.json", "utf8"));
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const stats = (values: number[]) => {
  assert(values.length > 0 && values.every(x => Number.isFinite(x) && x >= 0));
  const a = values.toSorted((x, y) => x - y), mid = a.length / 2;
  return {count: a.length, median: (a[Math.floor(mid)] + a[Math.ceil(mid) - 1]) / 2, min: a[0], max: a.at(-1)};
};
const experiments = [];
for (const [prefix, format, candidate] of [["browser", "ply", "candidate"], ["scoped-ply", "ply", "scoped"], ["scoped-spz", "spz", "scoped"]]) {
  const documents = [], summary = [];
  const metrics = [...(format === "ply" ? ["readMs"] : []), "initializeMs", "roundTripMs", "prepareMs", "settleMs", "totalMs"];
  for (const scene of ["pipes", "office"]) {
    const expected = format === "ply"
      ? await load(`.qa/sh-ply/browser-${scene}-0.json`)
      : grid.documents.find((d: {scene: string}) => d.scene === scene);
    for (let index = 0; index < 4; index++) {
      const doc = await load(`.qa/sh-ply/${prefix}-${scene}-${index}.json`);
      assert.equal(doc.scene, scene); assert.equal(doc.documentIndex, index);
      assert.equal(doc.variant, ["rebuilt", candidate, candidate, "rebuilt"][index]);
      assert.deepEqual(doc.errors, []); assert.deepEqual(doc.environment.visibility, []);
      assert.deepEqual(doc.variant === "rebuilt" ? doc.probeManifest : doc.probeManifest.baseline, base);
      assert.deepEqual(doc.asset, expected.asset); assert.deepEqual(doc.resolution, expected.resolution);
      assert.equal(doc.disposedModels, 5); assert.equal(doc.moduleReplacements, 2);
      assert.equal(doc.workers.length, 2); assert.equal(doc.samples.length, 5);
      assert.equal(doc.samples.filter((s: {warmup: boolean}) => s.warmup).length, 1);
      assert.equal(doc.controls.length, scene === "pipes" ? 8 : 10);
      assert.equal(doc.attributeControls.length, 5);
      for (const row of doc.attributeControls) assert.deepEqual(row.attributes, expected.attributeControls[0].attributes);
      for (const row of doc.controls) {
        const prior = original.comparisons.find((x: {scene: string; variant: string; view: string; yaw: number}) =>
          x.scene === scene && x.variant === (format === "ply" ? "original" : "alpha16") && x.view === row.view && x.yaw === row.yaw);
        assert.equal(row.hash, prior.hash);
      }
      documents.push(doc);
    }
    for (const variant of ["rebuilt", candidate]) {
      const docs = documents.filter(d => d.scene === scene && d.variant === variant);
      const samples = docs.flatMap(d => d.samples).filter(s => !s.warmup);
      summary.push({scene, variant, metrics: Object.fromEntries(metrics.map(k => [k, stats(samples.map(s => s[k]))])),
        perDocument: docs.map(d => ({index: d.documentIndex,
          metrics: Object.fromEntries(metrics.map(k => [k, stats(d.samples.filter((s: {warmup: boolean}) => !s.warmup).map((s: Record<string, number>) => s[k]))]))}))});
    }
  }
  experiments.push({prefix, format, candidate, documents, summary, validation: {formalSamples: 32, warmupSamples: 8, attributeControls: 40, pixelControls: 72}});
}
const report = {date: "2026-10-31", baseline: "700f8c3", experiments,
  validation: {formalSamples: 96, warmupSamples: 24, attributeControls: 120, pixelControls: 216, failures: []},
  limits: ["Global grid branch regresses default PLY initialization; retained as a negative experiment, not recommended for integration.",
    "Scoped build routes only SPZ through specialized SH methods. Original general encoder and methods stay unchanged.",
    "Preloaded input; PLY read includes gzip decoding and length validation, SPZ inflation remains inside initialization. Network and module compilation excluded.",
    "Read/settle fluctuations must not be attributed to SH encoding; compare within each serial ABBA experiment, not across matrices.",
    "No production integration, cold process/HTTP/cache, memory peak, other models/formats/backends or continuous roaming validation.",
    "Grid arithmetic is reused verbatim from the previously exhaustively checked source, not a newly repeated exhaustive test."]};
await writeFile("docs/benchmarks/sh-scoped-2026-10-31.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(experiments.map(({prefix, summary}) => ({prefix, summary})), null, 2));
