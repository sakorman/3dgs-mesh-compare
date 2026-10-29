// Score frozen model pixels against the independently captured JPEG/PNG references.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { quality } from "../src/metrics";

const root = resolve(import.meta.dirname, "..");
const controls = resolve(root, process.argv[2] ?? ".qa/reference-decode");
const captures = resolve(root, process.argv[3] ?? ".qa/reference-pixels");
const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const matrix = load(resolve(controls, "browser.json"));
if (matrix.failed || matrix.errors.length) throw new Error("Incomplete browser capture");
interface Capture {scene: string; view: string; format: string; repeat: number; readFrequently: boolean; scaledHash: string}
function bytes(directory: string, hash: string) {
  const value = readFileSync(resolve(directory, `${hash}.rgba`));
  if (createHash("sha256").update(value).digest("hex") !== hash) throw new Error("RGBA digest mismatch");
  return new Uint8ClampedArray(value);
}
const records = [];
for (const scene of ["pipes", "office"]) {
  const frozen = load(resolve(root, `docs/benchmarks/reference-pixels-quality-${scene}-2026-10-29.json`));
  for (const row of frozen.records.filter((r: {repeat: number}) => r.repeat === 0)) {
    const refs = matrix.records.filter((r: Capture) => r.scene === scene && r.view === row.view && r.repeat === 0 && !r.readFrequently) as Capture[];
    if (refs.length !== 2) throw new Error("Missing JPEG/PNG pair");
    const jpeg = refs.find(r => r.format === "jpeg")!, png = refs.find(r => r.format === "png")!;
    const targetJpeg = bytes(controls, jpeg.scaledHash), targetPng = bytes(controls, png.scaledHash);
    for (const render of row.results) {
      const pixels = bytes(captures, render.hash);
      const a = quality(pixels, targetJpeg, row.width, row.height);
      const b = quality(pixels, targetPng, row.width, row.height);
      records.push({scene, view: row.view, backend: render.kind, resolution: [row.width, row.height],
        renderHash: render.hash, jpegHash: jpeg.scaledHash, pngHash: png.scaledHash, jpeg: a, png: b,
        delta: {psnr: a.psnr === null || b.psnr === null ? null : b.psnr - a.psnr, ssim: b.ssim - a.ssim, mae: b.mae - a.mae}});
    }
  }
}
writeFileSync(resolve(controls, "scores.json"), JSON.stringify({createdAt: new Date().toISOString(),
  metricSource: "src/metrics.ts at 08e1507", renderSource: "reference-pixels-quality-{scene}-2026-10-29.json; frozen RGBA captured at 0344969",
  method: "Same frozen model bytes; newly captured JPEG/PNG references at identical dimensions with default Canvas2D. This is a reference-input comparison, not a new render or speed benchmark.", records}, null, 2) + "\n");
console.log(JSON.stringify({pairs: records.length, maxAbsPsnr: Math.max(...records.map(r => Math.abs(r.delta.psnr ?? 0))),
  maxAbsSsim: Math.max(...records.map(r => Math.abs(r.delta.ssim)))}, null, 2));
