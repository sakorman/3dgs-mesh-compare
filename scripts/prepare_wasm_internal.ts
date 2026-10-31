import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";

const root = resolve(".qa/wasm-build");
const base = JSON.parse(await readFile(`${root}/rebuild/manifest.json`, "utf8"));
const sourceRoot = `${root}/spark-${base.revision}`;
const sourceOut = `${root}/instrumented-source`;
const out = `${root}/internal`;
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
const file = `${sourceOut}/rust/spark-lib/src/spz.rs`;
let source = await readFile(file, "utf8");
const replace = (a: string, b: string) => {
  if (source.split(a).length !== 2) throw new Error("Profile boundary changed: " + a.slice(0, 70));
  source = source.replace(a, b);
};
source = `// Diagnostic build only: wall-clock scopes, no changes to decoder values.
#[link(wasm_import_module = "spz_profile")]
unsafe extern "C" {
    fn profile_clock() -> f64;
    fn profile_record(kind: u32, elapsed: f64);
}
struct SpzProfileScope { kind: u32, started: f64 }
impl SpzProfileScope {
    fn new(kind: u32) -> Self { Self { kind, started: unsafe { profile_clock() } } }
}
impl Drop for SpzProfileScope {
    fn drop(&mut self) { unsafe { profile_record(self.kind, profile_clock() - self.started); } }
}

` + source;
replace(`        loop {\n            match state.stage {`, `        loop {\n            let _stage_profile = SpzProfileScope::new(10 + state.stage as u32);\n            match state.stage {`);
replace(`            self.decompressor.write_all(&self.compressed[start..end])?;\n            self.decompressor.flush()?;`, `            {\n                let _inflate_profile = SpzProfileScope::new(0);\n                self.decompressor.write_all(&self.compressed[start..end])?;\n                self.decompressor.flush()?;\n            }`);
replace(`                std::mem::swap(self.decompressor.get_mut(), &mut self.buffer);\n                self.poll()?;\n                std::mem::swap(self.decompressor.get_mut(), &mut self.buffer);`, `                let _poll_profile = SpzProfileScope::new(1);\n                std::mem::swap(self.decompressor.get_mut(), &mut self.buffer);\n                self.poll()?;\n                std::mem::swap(self.decompressor.get_mut(), &mut self.buffer);`);
await writeFile(file, source);
const env = {...process.env, CARGO_HOME: `${root}/cargo-home`, RUSTUP_HOME: `${root}/rustup-home`, RUSTUP_TOOLCHAIN: "1.99.1",
  PATH: `${root}/cargo-home/bin:${process.env.PATH}`, RUSTFLAGS: base.rustflags,
  CARGO_TARGET_DIR: `${sourceRoot}/rust/target`};
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, {env, encoding: "utf8"});
if (run(`${root}/cargo-home/bin/rustc`, ["-Vv"]) !== base.rustc || run(`${root}/wasm-bindgen`, ["--version"]) !== base.bindgen) throw new Error("Toolchain changed");
execFileSync(`${root}/cargo-home/bin/cargo`, ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", `${sourceOut}/rust/Cargo.toml`, "-p", "spark-rs", "--jobs", "4"], {env, stdio: "inherit"});
await mkdir(out);
run(`${root}/wasm-bindgen`, [`${env.CARGO_TARGET_DIR}/wasm32-unknown-unknown/release/spark_rs.wasm`, "--target", "web", "--out-dir", `${out}/pkg`, "--omit-default-module-path"]);
const glue = await readFile(`${out}/pkg/spark_rs.js`, "utf8");
const runtime = `export const spz_profile = {};
export const profile_clock = () => performance.now();
export function profile_record(kind, elapsed) {
  const row = spz_profile[kind] ??= {calls: 0, elapsedMs: 0};
  row.calls++; row.elapsedMs += elapsed;
}
`;
await writeFile(`${out}/profile-runtime.js`, runtime, {flag: "wx"});
let worker = await readFile(`${root}/rebuild/worker-entry.ts`, "utf8");
if (sha(worker) !== base.workerSourceSha256) throw new Error("Worker source changed");
worker = 'import { spz_profile } from "spz_profile";\n' + worker;
const call = '    const result = await handler(args, { sendStatus });';
if (worker.split(call).length !== 2) throw new Error("Missing handler boundary");
worker = worker.replace(call, '    if (name === "loadExtSplats") for (const key of Object.keys(spz_profile)) delete spz_profile[key];\n' + call);
const reply = 'self.postMessage({ id, result },';
if (worker.split(reply).length !== 2) throw new Error("Missing response boundary");
worker = worker.replace(reply, 'self.postMessage({ id, result, spzProfile: name === "loadExtSplats" ? spz_profile : undefined },');
await writeFile(`${out}/worker-entry.ts`, worker, {flag: "wx"});
const license = await readFile(`${sourceRoot}/LICENSE`, "utf8");
await build({entryPoints: [`${out}/worker-entry.ts`], bundle: true, format: "iife", target: "es2022", minify: false,
  outfile: `${out}/profile.js`, alias: {"spark-rs": `${out}/pkg/spark_rs.js`, "spz_profile": `${out}/profile-runtime.js`},
  banner: {js: "/* Spark 2.4.0 diagnostic build; upstream MIT license:\n" + license.replaceAll("*/", "* /") + "\n*/"}});
await writeFile(`${out}/profile.worker`, await readFile(`${out}/profile.js`), {flag: "wx"});
const manifest = {createdAt: new Date().toISOString(), baseline: base, spzSourceSha256: sha(source), workerSourceSha256: sha(worker),
  glueSha256: sha(glue), runtimeSha256: sha(runtime), wasmSha256: sha(await readFile(`${out}/pkg/spark_rs_bg.wasm`)), profileSha256: sha(await readFile(`${out}/profile.worker`)),
  phases: {0: "gzipWriteFlush", 1: "pollWithSwaps", 10: "centers", 11: "alphas", 12: "rgb", 13: "scales", 14: "quats", 15: "sh", 16: "extension", 17: "childCounts", 18: "childStarts", 19: "done"},
  scope: "Scopes 10-19 are nested inside pollWithSwaps; do not sum parent and children. Gzip scope includes writes/flush/allocation, not pure inflate. Stage scopes include conversion, output packing, JS boundary and buffer drains; partial waiting polls included. Clock crossings and timer quantization perturb short scopes."};
await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify({wasmSha256: manifest.wasmSha256, profileSha256: manifest.profileSha256}));
