import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";

const root = resolve(".qa/wasm-build");
const base = JSON.parse(await readFile(`${root}/rebuild/manifest.json`, "utf8"));
const sourceRoot = `${root}/spark-${base.revision}`;
const sourceOut = `${root}/sh-grid-source`, out = `${root}/sh-grid`;
const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
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
const file = `${sourceOut}/rust/spark-lib/src/splat_encode.rs`;
const original = await readFile(file, "utf8");
const old = `    let base = (max_abs.log2().ceil() + 15.0).clamp(0.0, 31.0).round() as i32;
    let divisor = ((base - 15) as f32).exp2() / 255.0;`;
if (original.split(old).length !== 2) throw new Error("Encoder boundary changed");
const replacement = (await readFile("tests/helpers/sh-grid-exponent.rs", "utf8")).trimEnd();
const source = original.replace(old, replacement);
await writeFile(file, source); await mkdir(out);
const env = {...process.env, CARGO_HOME: `${root}/cargo-home`, RUSTUP_HOME: `${root}/rustup-home`, RUSTUP_TOOLCHAIN: "1.99.1",
  PATH: `${root}/cargo-home/bin:${process.env.PATH}`, RUSTFLAGS: base.rustflags, CARGO_TARGET_DIR: `${sourceRoot}/rust/target`};
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, {env, encoding: "utf8"});
if (run(`${root}/cargo-home/bin/rustc`, ["-Vv"]) !== base.rustc || run(`${root}/wasm-bindgen`, ["--version"]) !== base.bindgen) throw new Error("Toolchain changed");
// Test actual Rust f32 arithmetic in WASM, not a JavaScript approximation.
const extract = (text: string, name: string) => text.slice(text.indexOf("pub fn encode_ext_rgb("), text.indexOf("pub fn decode_ext_rgb(")).replace("pub fn encode_ext_rgb", `fn ${name}`);
const license = await readFile(`${sourceRoot}/LICENSE`, "utf8");
const verifier = `/* Original encoder: Spark 2.4.0, MIT.\n${license.replaceAll("*/", "* /")}\n*/\n` +
  extract(original, "original") + extract(source, "candidate") + await readFile("tests/helpers/sh-grid-verifier.rs", "utf8");
await writeFile(`${out}/verify.rs`, verifier, {flag: "wx"});
run(`${root}/cargo-home/bin/rustc`, [`${out}/verify.rs`, "--edition", "2021", "--crate-type", "cdylib", "--target", "wasm32-unknown-unknown", "-C", "opt-level=3", "-C", "target-feature=+simd128,+bulk-memory", "-o", `${out}/verify.wasm`]);
const check = (await WebAssembly.instantiate(await readFile(`${out}/verify.wasm`))).instance.exports as unknown as {verify_discrete(start: number, count: number): number; verify_general(count: number): number};
for (let start = 0; start < 0x1000000; start += 0x10000) {
  const failure = check.verify_discrete(start, 0x10000);
  if (failure) throw new Error(`Discrete mismatch at ${failure - 1}`);
}
const generalCount = 1_000_000;
const failure = check.verify_general(generalCount);
if (failure) throw new Error(`General mismatch at ${failure}`);
await writeFile(`${out}/verification.json`, JSON.stringify({discreteTriplets: 0x1000000, generalIterations: generalCount,
  casesPerGeneralIteration: 3, specialTriplets: 16 ** 3, mismatches: 0, verifierSha256: sha(verifier), wasmSha256: sha(await readFile(`${out}/verify.wasm`))}, null, 2) + "\n");
console.log("All 16,777,216 discrete triplets and general/boundary controls match");
execFileSync(`${root}/cargo-home/bin/cargo`, ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", `${sourceOut}/rust/Cargo.toml`, "-p", "spark-rs", "--jobs", "4"], {env, stdio: "inherit"});
run(`${root}/wasm-bindgen`, [`${env.CARGO_TARGET_DIR}/wasm32-unknown-unknown/release/spark_rs.wasm`, "--target", "web", "--out-dir", `${out}/pkg`, "--omit-default-module-path"]);
const worker = await readFile(`${root}/rebuild/worker-entry.ts`, "utf8");
if (sha(worker) !== base.workerSourceSha256) throw new Error("Worker source changed");
await writeFile(`${out}/worker-entry.ts`, worker, {flag: "wx"});
await build({entryPoints: [`${out}/worker-entry.ts`], bundle: true, format: "iife", target: "es2022", minify: false,
  outfile: `${out}/candidate.js`, alias: {"spark-rs": `${out}/pkg/spark_rs.js`},
  banner: {js: "/* Spark 2.4.0 experimental build; upstream MIT license:\n" + license.replaceAll("*/", "* /") + "\n*/"}});
await writeFile(`${out}/candidate.worker`, await readFile(`${out}/candidate.js`), {flag: "wx"});
const manifest = {createdAt: new Date().toISOString(), baseline: base, encoderSourceSha256: sha(source), replacementSha256: sha(replacement),
  workerSourceSha256: sha(worker), wasmSha256: sha(await readFile(`${out}/pkg/spark_rs_bg.wasm`)), candidateSha256: sha(await readFile(`${out}/candidate.worker`)),
  verification: JSON.parse(await readFile(`${out}/verification.json`, "utf8")), scope: "Independent experimental build only. Grid maximum exponent fast path; other values use original log2/exp2. No timing imports, layout, assets or shaders changed."};
await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify({wasmSha256: manifest.wasmSha256, candidateSha256: manifest.candidateSha256}));
