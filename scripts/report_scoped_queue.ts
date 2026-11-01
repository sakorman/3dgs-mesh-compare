import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const docs = [];
const prior = JSON.parse(await readFile("docs/benchmarks/spz-alpha16-2026-10-27.json", "utf8"));
const priorAttrs = JSON.parse(await readFile("docs/benchmarks/sh-scoped-2026-10-31.json", "utf8"));
for (const scene of ["pipes", "office"]) {
  for (const [index, mode] of ["overlap", "serial", "serial", "overlap"].entries()) {
    const doc = JSON.parse(await readFile(`.qa/scoped-queue/${scene}-${mode}-${index}.json`, "utf8"));
    assert.equal(doc.scene, scene); assert.equal(doc.mode, mode); assert.equal(doc.documentIndex, index);
    assert.equal(doc.failed, undefined); assert.deepEqual(doc.errors, []); assert.deepEqual(doc.environment.visibility, []);
    assert.deepEqual(doc.asset, prior.assets.find((a: {scene: string}) => a.scene === scene));
    assert.equal(doc.controls.length, scene === "pipes" ? 10 : 12); assert.equal(doc.attributes.length, 7);
    for (const control of doc.controls) {
      const expected = prior.comparisons.find((c: {scene: string; variant: string; view: string; yaw: number}) =>
        c.scene === scene && c.variant === "alpha16" && c.view === control.view && c.yaw === control.yaw);
      assert.equal(control.hash, expected.hash);
    }
    const expected = priorAttrs.experiments.find((e: {prefix: string}) => e.prefix === "scoped-spz")
      .documents.find((d: {scene: string}) => d.scene === scene).attributeControls[0].attributes;
    for (const attr of doc.attributes) assert.deepEqual(attr.buffers, expected);
    assert.equal(doc.samples.length, 5); assert.equal(doc.samples.filter((s: {warmup: boolean}) => s.warmup).length, 1);
    for (const [i, sample] of doc.samples.entries()) {
      assert.equal(sample.index, i); assert.equal(sample.warmup, i === 0);
      for (const key of ["cancelReturnedMs", "loadMs", "settleMs", "totalMs", "queueMs"]) {
        assert(Number.isFinite(sample[key]) && sample[key] >= 0);
      }
      assert(Math.abs(sample.totalMs - sample.loadMs - sample.settleMs) < .001);
      assert.equal(sample.phases.some((p: {name: string}) => p.name === "spz-queue"), mode === "serial");
      assert.equal(sample.phases.some((p: {name: string}) => p.name.startsWith("ply")), false);
    }
    assert.equal(doc.checks.length, 1); assert.equal(doc.checks[0].kind, "controlled-release");
    assert.equal(doc.checks[0].intendedHoldMs, 200); assert.equal(doc.checks[0].lateDisposed, 1);
    assert.equal(doc.resources.length, 13); assert.equal(doc.network.length, 2);
    assert.equal(doc.messages.filter((m: {kind: string}) => m.kind === "decode").length, 13);
    assert.equal(doc.messages.filter((m: {kind: string}) => m.kind === "held").length, 1);
    for (const [i, resource] of doc.resources.entries()) {
      assert.equal(resource.published, i % 2 === 0 ? 1 : 0);
      assert.equal(resource.before.backingBytes, doc.initialOwned.backingBytes);
      assert.equal(resource.before.buffers, 6);
      assert.equal(resource.disposed, 1); assert.equal(resource.after.model.backingBytes, 0);
      assert.equal(resource.after.ext.backingBytes, 0); assert.deepEqual(resource.after.extraKeys, []);
      assert(resource.after.textureSourcesCleared.every((cleared: boolean) => cleared));
      assert.equal(resource.after.textureSourcesCleared.length, resource.published ? 6 : 2);
    }
    const decoders = doc.workers.filter((w: {calls: number}) => w.calls);
    assert.equal(decoders.length, mode === "serial" ? 1 : 2);
    assert(decoders.every((w: {terminated: boolean}) => !w.terminated));
    assert(doc.workers.filter((w: {calls: number}) => !w.calls).every((w: {terminated: boolean}) => w.terminated));
    const at = (label: string) => doc.snapshots.find((s: {label: string}) => s.label === label).decodeCapacity;
    assert.equal(at("before-dispose"), at("after-dispose"));
    assert.equal(at("after-dispose"), at("after-one-second-idle"));
    assert.equal(at("initial") * decoders.length, at("after-one-second-idle"));
    docs.push(doc);
  }
}
for (const doc of docs) assert.deepEqual(doc.manifest, docs[0].manifest);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(await readFile(".qa/scoped-memory/memory.worker")), docs[0].manifest.workerSha256);
assert.equal(digest(await readFile(".qa/wasm-build/sh-scoped/pkg/spark_rs_bg.wasm")), docs[0].manifest.wasmSha256);
const sourceHashes: Record<string, string> = {};
for (const path of ["tests/browser/scoped-queue.ts", "tests/browser/scoped-queue.html", "tests/helpers/buffer-ownership.ts",
  "tests/helpers/paired-model.ts", "tests/helpers/initialization-queue.ts", "scripts/prepare_scoped_memory.ts", "scripts/report_scoped_queue.ts"]) {
  sourceHashes[path] = digest(await readFile(path));
}
const stats = (values: number[]) => {
  const sorted = values.toSorted((a,b) => a-b), n = sorted.length;
  return {n, median: (sorted[Math.floor((n-1)/2)] + sorted[Math.floor(n/2)]) / 2, min: sorted[0], max: sorted[n-1]};
};
const metrics = (samples: Record<string, number>[]) => Object.fromEntries(
  ["cancelReturnedMs", "queueMs", "loadMs", "settleMs", "totalMs"].map(key => [key, stats(samples.map(s => s[key]))]));
const summary = [];
for (const scene of ["pipes", "office"]) for (const mode of ["overlap", "serial"]) {
  const rows = docs.filter(d => d.scene === scene && d.mode === mode);
  summary.push({scene, mode, formal: metrics(rows.flatMap(d => d.samples.filter((s: {warmup: boolean}) => !s.warmup))),
    documentMedians: rows.map(d => ({documentIndex: d.documentIndex, metrics: metrics(d.samples.filter((s: {warmup: boolean}) => !s.warmup))})),
    warmups: metrics(rows.flatMap(d => d.samples.filter((s: {warmup: boolean}) => s.warmup))),
    idleDecodeCapacity: rows[0].snapshots.at(-1).decodeCapacity,
    decodeWorkers: rows[0].workers.filter((w: {calls: number}) => w.calls).length,
    controlledHold: rows.map(d => d.checks[0])});
}
const report = {createdAt: new Date().toISOString(), baseline: "65112b7", sourceHashes, summary, documents: docs,
  limitations: ["Eight ABBA fresh documents; one warmup and four natural cancellation/retry samples per document. Same instrumented Worker and scoped WASM.",
    "Natural cancellation occurs at loadExtSplats submission; old decode is not interrupted. Cached URL bytes are re-read/hashed before retry admission.",
    "Separate 200ms held-result capacity controls excluded from natural latency statistics.",
    "WASM capacity and selected backing buffers are not RSS/heap/VRAM peaks or guaranteed physical memory savings.",
    "Queue is per loader, does not shrink an existing shared pool and can wait indefinitely for a decoder that never settles; queued callers can cancel.",
    "No cold-runtime, screen-presentation, GPU-time or continuous-motion claim. Same point count, SH3, dimensions, cameras and assets.",
    "Pixel and complete attribute equality against the existing alpha16 candidate, not lossless equality to original PLY; no new PSNR/SSIM claim.",
    "Serial admission remains opt-in for experiments due to retry latency cost; production loader/assets unchanged."]};
await writeFile("docs/benchmarks/scoped-queue-2026-11-01.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
