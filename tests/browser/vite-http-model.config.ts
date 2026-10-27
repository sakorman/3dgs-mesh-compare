import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { modelHttpFixture, type HttpSceneAssets } from "../helpers/http-model-fixture";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const previous = JSON.parse(readFileSync("docs/benchmarks/spz-alpha16-2026-10-27.json", "utf8"));
const assets: Record<string, HttpSceneAssets> = {};
for (const scene of ["pipes", "office"]) {
  const expected = previous.assets.find((x: { scene: string }) => x.scene === scene);
  const spz = readFileSync(`.qa/spz-sh8/${scene}-sh8.spz`);
  const alpha = readFileSync(`.qa/spz-alpha16/${scene}.ap16.bin`);
  const ply = readFileSync(`.qa/${scene}-gaussians.bin`);
  const raw = gunzipSync(alpha);
  if (hash(spz) !== expected.spzSha256 || hash(raw) !== expected.alphaRawSha256 || hash(gunzipSync(ply)) !== expected.plySha256)
    throw new Error(`Unexpected ${scene} experiment source`);
  // Simulate an older, valid AP16 revision without altering any file or point order.
  const old = Buffer.from(raw); old.writeUInt16LE(old.readUInt16LE(48) === 0 ? 1 : 0, 48);
  assets[scene] = {
    spz: { bytes: spz, digest: expected.spzSha256 },
    alpha: { bytes: alpha, digest: expected.alphaRawSha256, encoding: "gzip" },
    ply: { bytes: ply, digest: expected.plySha256, encoding: "gzip" },
    oldAlpha: { bytes: gzipSync(old), digest: hash(old), encoding: "gzip" },
  };
}
export default defineConfig({
  server: { host: "127.0.0.1", port: 5180, strictPort: true },
  plugins: [{ name: "model-http-fixture", configureServer(server) { server.middlewares.use(modelHttpFixture(assets)); } }],
});
