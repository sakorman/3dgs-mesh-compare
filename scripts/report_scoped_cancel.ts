import {readFile, writeFile} from "node:fs/promises";
import assert from "node:assert/strict";

const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const previous = await load("docs/benchmarks/sh-scoped-2026-10-31.json");
const pixels = await load("docs/benchmarks/spz-alpha16-2026-10-27.json");
const documents = [];
for (const scene of ["pipes", "office"]) {
  for (const variant of ["baseline", "fixed"]) {
    const doc = await load(`.qa/scoped-cancel/${scene}-${variant}.json`);
    assert.equal(doc.failed, undefined);
    assert.equal(doc.scene, scene); assert.equal(doc.variant, variant);
    assert.deepEqual(doc.errors, []); assert.deepEqual(doc.environment.visibility, []);
    assert.deepEqual(doc.manifest, previous.experiments.find((e: {prefix: string}) => e.prefix === "scoped-spz")
      .documents.find((d: {variant: string}) => d.variant === "scoped").probeManifest);
    assert.equal(doc.checks.length, 7); assert.equal(doc.controls.length, scene === "pipes" ? 13 : 17);
    assert.equal(doc.attributes.length, 7); assert.equal(doc.resources.length, 12);
    assert(doc.resources.every((r: {disposed: number}) => r.disposed === 1));
    assert.equal(doc.moduleReplacements, doc.workers.length); assert.equal(doc.workers.length, 3);
    for (const check of doc.checks.filter((c: {kind: string}) => c.kind === "initialize-cancel")) {
      assert.equal(check.returnedBeforeRelease, variant === "fixed");
      assert.equal(check.lateDisposed, 1); assert.equal(check.latePublished, 0);
      assert.equal(check.retryReportUnchanged, true);
    }
    for (const control of doc.controls) {
      const prior = pixels.comparisons.find((c: {scene: string; variant: string; view: string; yaw: number}) =>
        c.scene === scene && c.variant === (control.format === "ply" ? "original" : "alpha16") && c.view === control.view && c.yaw === control.yaw);
      assert.equal(control.hash, prior.hash);
    }
    for (const row of doc.attributes) {
      const prior = previous.experiments.find((e: {prefix: string}) => e.prefix === "scoped-" + row.format)
        .documents.find((d: {scene: string}) => d.scene === scene).attributeControls[0].attributes;
      assert.deepEqual(row.buffers, prior);
    }
    documents.push(doc);
  }
}
const baseline = await readFile(".qa/scoped-cancel/baseline-loader.ts", "utf8");
const {execFileSync} = await import("node:child_process");
const frozen = execFileSync("git", ["show", "777a1a3:tests/helpers/paired-model.ts"], {encoding:"utf8"})
  .replace('from "./alpha16"', 'from "../../tests/helpers/alpha16"')
  .replace('from "./alpha16-stream"', 'from "../../tests/helpers/alpha16-stream"');
assert.equal(baseline, frozen);
const report = {date:"2026-11-01", baseline:"777a1a3f11530f9359ff7db92c0341b4c3b1328d", documents,
  validation:{initializationCasesPerVariant:8, baselineBlocked:8, fixedReturnedBeforeRelease:8,
    pixelControls:60, attributeControls:28, modelsDisposedOnce:48, httpMissHitCases:4, httpBodyCancelCases:4, plyFallbackCases:4},
  preflight:{issue:"Fixed two-worker assumption failed during overlap; one sorting worker plus two parser workers observed. Fixture now validates every worker uses the pinned module and counts the overlap.",
    retainedLocalRecord:".qa/scoped-cancel/preflight-worker-count.json"},
  limits:["Decoder result delivery is gated; reported cancellation latency is not decoder speed or a speedup ratio.",
    "Cancellation returns before non-interruptible initialization ends; cleanup occurs only after late success/failure. No immediate CPU/GPU reclamation claim.",
    "Local HTTP cache miss/hit, real body cancellation, 404 fallback only. No CDN, process cold start, memory peak, malformed-WASM trap, continuous orbit, new PSNR or FPS result.",
    "SPZ-scoped build and production assets unchanged; experimental loader only."]};
await writeFile("docs/benchmarks/scoped-cancel-2026-11-01.json", JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report.validation));
