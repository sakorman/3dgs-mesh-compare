import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { storedSpzControl } from "../tests/helpers/spz-container";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const prior = JSON.parse(await readFile("docs/benchmarks/spz-alpha16-2026-10-27.json", "utf8"));
const output = ".qa/spz-container";
await mkdir(output, { recursive: true });
const assets = [];
for (const scene of ["pipes", "office"]) {
  const expected = prior.assets.find((a: {scene: string}) => a.scene === scene);
  const model = await readFile(`.qa/spz-sh8/${scene}-sh8.spz`);
  const alpha = gunzipSync(await readFile(`.qa/spz-alpha16/${scene}.ap16.bin`), { maxOutputLength: 48 + 2 * expected.count });
  assert.equal(sha(model), expected.spzSha256); assert.equal(sha(alpha), expected.alphaRawSha256);
  const stored = storedSpzControl(model, alpha, expected.count);
  assert.deepEqual(stored.alpha.subarray(48), new Uint8Array(alpha.subarray(48)));
  const variants = [];
  for (const [name, bytes, sidecar] of [["original", model, alpha], ["stored", stored.model, stored.alpha]] as const) {
    const modelUrl = `/${output}/${scene}-${name}.spz`, alphaUrl = `/${output}/${scene}-${name}.ap16`;
    await writeFile(modelUrl.slice(1), bytes, { flag: "wx" });
    await writeFile(alphaUrl.slice(1), sidecar, { flag: "wx" });
    variants.push({name, modelUrl, alphaUrl, modelBytes: bytes.length, modelSha256: sha(bytes), alphaSha256: sha(sidecar)});
  }
  assets.push({scene, count: expected.count, rawBytes: stored.rawBytes, rawSha256: stored.rawSha256,
    alphaPayloadSha256: sha(alpha.subarray(48)), variants});
}
const manifest = {createdAt: new Date().toISOString(), node: process.version, zlib: process.versions.zlib,
  sourceReport: "docs/benchmarks/spz-alpha16-2026-10-27.json", gzipLevel: 0, assets};
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(manifest, null, 2));
