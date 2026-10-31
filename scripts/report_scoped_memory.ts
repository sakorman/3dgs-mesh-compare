import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const docs = [];
for (const scene of ["pipes", "office"]) {
  for (const mode of ["serial", "overlap"]) {
    const doc = JSON.parse(await readFile(`.qa/scoped-memory/${scene}-${mode}.json`, "utf8"));
    assert.equal(doc.scene, scene); assert.equal(doc.mode, mode); assert.equal(doc.failed, undefined);
    assert.deepEqual(doc.errors, []); assert.deepEqual(doc.environment.visibility, []);
    assert.equal(doc.controls.length, scene === "pipes" ? 6 : 8); assert.equal(doc.attributes.length, 3);
    assert.equal(doc.resources.length, 3); assert.equal(doc.network.length, 2);
    assert.equal(doc.messages.filter((m: {kind: string}) => m.kind === "decode").length, 3);
    for (const resource of doc.resources) {
      assert.equal(resource.before.backingBytes, doc.initialOwned.backingBytes);
      assert.equal(resource.before.buffers, 6);
      assert.equal(resource.disposed, 1); assert.equal(resource.after.model.backingBytes, 0);
      assert.equal(resource.after.ext.backingBytes, 0); assert.deepEqual(resource.after.extraKeys, []);
      assert(resource.after.textureSourcesCleared.every((cleared: boolean) => cleared));
      assert.equal(resource.after.textureSourcesCleared.length, resource.published ? 6 : 2);
    }
    if (mode === "overlap") assert.equal(doc.resources[1].published, 0);
    const decoders = doc.workers.filter((w: {calls: number}) => w.calls);
    assert.equal(decoders.length, mode === "serial" ? 1 : 2);
    assert(decoders.every((w: {terminated: boolean}) => !w.terminated));
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
for (const path of ["tests/browser/scoped-memory.ts", "tests/browser/scoped-memory.html", "tests/helpers/buffer-ownership.ts",
  "tests/helpers/paired-model.ts", "scripts/prepare_scoped_memory.ts", "scripts/report_scoped_memory.ts"]) {
  sourceHashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
}
const summary = docs.map(doc => ({scene: doc.scene, mode: doc.mode,
  mainModelBackingBytes: doc.finalOwned.backingBytes,
  decodeWorkers: doc.workers.filter((w: {calls: number}) => w.calls).length,
  idleDecodeCapacity: doc.snapshots.at(-1).decodeCapacity,
  clearedModels: doc.resources.length, pixels: doc.controls.length, attributeChecks: doc.attributes.length}));
const report = {createdAt: new Date().toISOString(), baseline: "da5ddf2", sourceHashes, summary, documents: docs,
  limitations: ["Controlled worker-result overlap, not observed natural latency or peak-memory distribution.",
    "WASM linear-memory capacity and selected distinct backing buffers only; no GC/RSS/VRAM/whole-process peak measurement.",
    "HTTP pair reused from browser cache after first load. Module and Worker probe loaded before checks; no cold-start timing.",
    "All render submissions serial; unchanged point counts, SH3, resolution, camera controls and assets; no new PSNR/SSIM claim.",
    "One preflight incorrectly assumed unpublished results already owned all SH textures; probe corrected to count only actual owned textures. Not a production disposal defect."]};
await writeFile("docs/benchmarks/scoped-memory-2026-11-01.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
