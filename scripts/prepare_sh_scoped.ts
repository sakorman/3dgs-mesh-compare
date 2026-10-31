import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";

const root = resolve(".qa/wasm-build");
const base = JSON.parse(await readFile(`${root}/rebuild/manifest.json`, "utf8"));
const grid = JSON.parse(await readFile(`${root}/sh-grid/manifest.json`, "utf8"));
const sourceRoot = `${root}/spark-${base.revision}`;
const sourceOut = `${root}/sh-scoped-source`, out = `${root}/sh-scoped`;
const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
if (JSON.stringify(grid.baseline) !== JSON.stringify(base)) throw new Error("Different baseline");
for (const target of [out, sourceOut]) {
  try { await access(target); throw new Error("Refusing to overwrite " + target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
for (const [name, hash] of Object.entries(base.sourceHashes)) {
  const bytes = await readFile(`${sourceRoot}/${name}`);
  if (sha(bytes) !== hash) throw new Error("Source mismatch: " + name);
  const target = `${sourceOut}/${name}`;
  await mkdir(dirname(target), {recursive: true}); await writeFile(target, bytes, {flag: "wx"});
}
const replaceOnce = (s: string, a: string, b: string) => {
  if (s.split(a).length !== 2) throw new Error("Source boundary changed: " + a);
  return s.replace(a, b);
};
const encoderPath = "rust/spark-lib/src/splat_encode.rs";
const originalEncoder = await readFile(`${sourceRoot}/${encoderPath}`, "utf8");
const gridEncoder = await readFile(`${root}/sh-grid-source/${encoderPath}`, "utf8");
if (sha(gridEncoder) !== grid.encoderSourceSha256) throw new Error("Grid encoder changed");
const extractEncoder = (s: string) => s.slice(s.indexOf("pub fn encode_ext_rgb("), s.indexOf("pub fn decode_ext_rgb("));
const fastEncoder = extractEncoder(gridEncoder).replace("pub fn encode_ext_rgb(", "pub fn encode_ext_rgb_grid(");
const encoder = replaceOnce(originalEncoder, "pub fn decode_ext_rgb(", fastEncoder + "pub fn decode_ext_rgb(");
if (extractEncoder(encoder).split("pub fn encode_ext_rgb_grid(")[0] !== extractEncoder(originalEncoder)) throw new Error("General encoder changed");
await writeFile(`${sourceOut}/${encoderPath}`, encoder);

const decoderPath = "rust/spark-lib/src/decoder.rs";
const decoder = await readFile(`${sourceRoot}/${decoderPath}`, "utf8");
const signature = "fn set_sh_spz(&mut self, base: usize, count: usize, sh1: &[f32], sh2: &[f32], sh3: &[f32])";
await writeFile(`${sourceOut}/${decoderPath}`, replaceOnce(decoder,
  "    fn set_sh(&mut self,", `    // Quantized SPZ input may use a specialized receiver; other receivers keep their existing path.\n    ${signature} { self.set_sh(base, count, sh1, sh2, sh3); }\n\n    fn set_sh(&mut self,`));
const spzPath = "rust/spark-lib/src/spz.rs";
const spz = await readFile(`${sourceRoot}/${spzPath}`, "utf8");
await writeFile(`${sourceOut}/${spzPath}`, replaceOnce(spz, "self.splats.set_sh(", "self.splats.set_sh_spz("));

const extPath = "rust/spark-rs/src/ext_splats.rs";
const originalExt = await readFile(`${sourceRoot}/${extPath}`, "utf8");
// Generate specialized copies from the pinned implementation. Leave every original
// SH and codebook method unchanged, avoiding a per-coefficient branch for PLY.
const methods = originalExt.slice(originalExt.indexOf("    fn set_sh1("), originalExt.indexOf("    fn set_sh1_codes("));
if (!methods || (methods.match(/encode_ext_rgb\(/g) ?? []).length !== 5) throw new Error("SH batch methods changed");
const specialized = methods.replace(/fn set_sh([123])\(/g, "fn set_sh$1_spz(").replaceAll("encode_ext_rgb(", "spark_lib::splat_encode::encode_ext_rgb_grid(");
const dispatch = `    ${signature} {\n` + [1, 2, 3].map(i => `        if !sh${i}.is_empty() { self.set_sh${i}_spz(base, count, sh${i}); }`).join("\n") + "\n    }\n\n";
const ext = replaceOnce(originalExt, "    fn set_sh(&mut self,", dispatch + "    fn set_sh(&mut self,") + "\nimpl ExtSplatsData {\n" + specialized + "}\n";
await writeFile(`${sourceOut}/${extPath}`, ext);

const env = {...process.env, CARGO_HOME: `${root}/cargo-home`, RUSTUP_HOME: `${root}/rustup-home`, RUSTUP_TOOLCHAIN: "1.99.1",
  PATH: `${root}/cargo-home/bin:${process.env.PATH}`, RUSTFLAGS: base.rustflags, CARGO_TARGET_DIR: `${sourceRoot}/rust/target`};
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, {env, encoding: "utf8"});
if (run(`${root}/cargo-home/bin/rustc`, ["-Vv"]) !== base.rustc || run(`${root}/wasm-bindgen`, ["--version"]) !== base.bindgen) throw new Error("Toolchain changed");
execFileSync(`${root}/cargo-home/bin/cargo`, ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", `${sourceOut}/rust/Cargo.toml`, "-p", "spark-rs", "--jobs", "4"], {env, stdio: "inherit"});
await mkdir(out);
run(`${root}/wasm-bindgen`, [`${env.CARGO_TARGET_DIR}/wasm32-unknown-unknown/release/spark_rs.wasm`, "--target", "web", "--out-dir", `${out}/pkg`, "--omit-default-module-path"]);
const worker = await readFile(`${root}/rebuild/worker-entry.ts`, "utf8");
if (sha(worker) !== base.workerSourceSha256) throw new Error("Worker source changed");
await writeFile(`${out}/worker-entry.ts`, worker, {flag: "wx"});
const license = await readFile(`${sourceRoot}/LICENSE`, "utf8");
await build({entryPoints: [`${out}/worker-entry.ts`], bundle: true, format: "iife", target: "es2022", minify: false,
  outfile: `${out}/scoped.js`, alias: {"spark-rs": `${out}/pkg/spark_rs.js`},
  banner: {js: "/* Spark 2.4.0 experimental build; upstream MIT license:\n" + license.replaceAll("*/", "* /") + "\n*/"}});
await writeFile(`${out}/scoped.worker`, await readFile(`${out}/scoped.js`), {flag: "wx"});
const changedSources: Record<string, string> = {};
for (const path of [encoderPath, decoderPath, spzPath, extPath]) changedSources[path] = sha(await readFile(`${sourceOut}/${path}`));
const manifest = {createdAt: new Date().toISOString(), baseline: base, changedSources,
  originalEncoderSha256: sha(extractEncoder(originalEncoder)), reusedGridEncoderSha256: sha(extractEncoder(gridEncoder)),
  priorGridVerification: grid.verification, gridEncoderSourceSha256: grid.encoderSourceSha256,
  workerSourceSha256: sha(worker), wasmSha256: sha(await readFile(`${out}/pkg/spark_rs_bg.wasm`)), scopedSha256: sha(await readFile(`${out}/scoped.worker`)),
  scope: "SPZ receiver hook only; original general encoder and SH/codebook methods unchanged. Specialized batch methods generated from original source. Grid function identical to previously verified implementation; no repeated numerical experiment or profiling imports."};
await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify(manifest));
