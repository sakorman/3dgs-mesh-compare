import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { validateAlpha16 } from "../tests/helpers/alpha16";
import { packSpzV4, spzV3Sections, validateSpzV4 } from "../tests/helpers/spz-v4";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();
const hex = (b: Uint8Array) => sha(b).toString("hex");
const prior = JSON.parse(await readFile("docs/benchmarks/spz-alpha16-2026-10-27.json", "utf8"));
const output = ".qa/spz-v4", assets = [];
await mkdir(output, {recursive: true});
const zstdVersion = execFileSync("zstd", ["--version"], {encoding: "utf8"}).trim();
const args = ["-12", "-q", "-c", "--no-check", "--single-thread"];
for (const scene of ["pipes", "office"]) {
  const expected = prior.assets.find((a: {scene: string}) => a.scene === scene);
  const v3 = await readFile(`.qa/spz-sh8/${scene}-sh8.spz`);
  const alpha = gunzipSync(await readFile(`.qa/spz-alpha16/${scene}.ap16.bin`), {maxOutputLength: 48 + expected.count * 2});
  assert.equal(hex(v3), expected.spzSha256); assert.equal(hex(alpha), expected.alphaRawSha256);
  validateAlpha16(alpha, expected.count, sha(v3));
  const raw = gunzipSync(v3, {maxOutputLength: 16 + expected.count * 65});
  const sections = spzV3Sections(raw, expected.count);
  const start = performance.now();
  const compressed = sections.map(input => execFileSync("zstd", [...args, `--stream-size=${input.length}`], {input, maxBuffer: 64 * 1024 ** 2}));
  const compressMs = performance.now() - start;
  const v4 = packSpzV4(raw, expected.count, compressed);
  const streams = validateSpzV4(v4, expected.count).map((entry, i) => {
    const input = v4.subarray(entry.offset, entry.offset + entry.bytes);
    const decoded = execFileSync("zstd", ["-d", "-q", "-c"], {input, maxBuffer: entry.decodedBytes + 1});
    assert.ok(decoded.equals(sections[i]), `Decoded ${entry.name} bytes changed`);
    return {...entry, decodedSha256: hex(decoded), byteIdenticalToV3: true};
  });
  const rebound = Uint8Array.from(alpha); rebound.set(sha(v4), 16);
  validateAlpha16(rebound, expected.count, sha(v4));
  assert.deepEqual(rebound.subarray(48), new Uint8Array(alpha.subarray(48)));
  const variants = [];
  for (const [name, bytes, sidecar] of [["v3", v3, alpha], ["v4", v4, rebound]] as const) {
    const modelUrl = `/${output}/${scene}-${name}.spz`, alphaUrl = `/${output}/${scene}-${name}.ap16`;
    await writeFile(modelUrl.slice(1), bytes, {flag: "wx"});
    await writeFile(alphaUrl.slice(1), sidecar, {flag: "wx"});
    variants.push({name, modelUrl, alphaUrl, modelBytes: bytes.length, modelSha256: hex(bytes), alphaSha256: hex(sidecar)});
  }
  assets.push({scene, count: expected.count, rawV3Bytes: raw.length, attributeBytes: raw.length - 16,
    rawV3Sha256: hex(raw), attributeSha256: hex(raw.subarray(16)), alphaPayloadSha256: hex(alpha.subarray(48)),
    compressMs, streams, variants});
}
const manifest = {createdAt: new Date().toISOString(), node: process.version, zstdVersion, zstdArgs: args,
  sourceReport: "docs/benchmarks/spz-alpha16-2026-10-27.json", method: "Six independent ZSTD frames; unchanged v3 attribute bytes, no extensions or re-quantization. Compression timing includes six serial CLI process launches, excludes reads and validation.", assets};
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify(manifest, null, 2));
