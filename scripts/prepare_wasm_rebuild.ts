import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import ts from "typescript";
import { build } from "esbuild";

const root = resolve(".qa/wasm-build");
const revision = "ffe210dc0a45d0515a06c9235878108112827d61";
const archiveSha256 = "47c6b34ee5477ebd161001284aa6372815c56d22a5adbdb322afd5483fbf0478";
const sourceRoot = `${root}/spark-${revision}`;
const out = `${root}/rebuild`;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const env = {...process.env, CARGO_HOME: `${root}/cargo-home`, RUSTUP_HOME: `${root}/rustup-home`,
  RUSTUP_TOOLCHAIN: "1.99.1", PATH: `${root}/cargo-home/bin:${process.env.PATH}`,
  RUSTFLAGS: "-C target-feature=+simd128,+bulk-memory"};
const run = (file: string, args: string[]) => execFileSync(file, args, {env, encoding: "utf8"});
const archive = `${root}/spark.tar.gz`;
if (sha(await readFile(archive)) !== archiveSha256) throw new Error("Source archive mismatch");
// Verify every original Rust source/configuration before building. Target output is excluded.
const names = run("tar", ["-tzf", archive]).trim().split("\n");
const sourceHashes: Record<string, string> = {};
for (const name of names.filter(n => n.startsWith(`spark-${revision}/rust/`) && /\.(rs|toml|lock)$/.test(n))) {
  const original = execFileSync("tar", ["-xOf", archive, name]);
  if (sha(await readFile(`${root}/${name}`)) !== sha(original)) throw new Error("Modified source: " + name);
  sourceHashes[name.slice(`spark-${revision}/`.length)] = sha(original);
}
try { await access(out); throw new Error("Refusing to overwrite rebuild output"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const rustc = run(`${root}/cargo-home/bin/rustc`, ["-Vv"]);
const cargo = run(`${root}/cargo-home/bin/cargo`, ["-V"]);
const bindgen = run(`${root}/wasm-bindgen`, ["--version"]);
if (!rustc.startsWith("rustc 1.99.1 ") || bindgen.trim() !== "wasm-bindgen 0.2.117") throw new Error("Toolchain mismatch");
const bundle = await readFile("node_modules/@sparkjsdev/spark/dist/spark.module.js", "utf8");
if (sha(bundle) !== "5ae86ab35d4ceb655db486dcc336299775bb314c280d7e5b39f64e4539f8e0e9") throw new Error("npm bundle mismatch");
const ast = ts.createSourceFile("spark.js", bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const workers: string[] = [];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "jsContent" && node.initializer && ts.isStringLiteral(node.initializer)) workers.push(node.initializer.text);
  ts.forEachChild(node, visit);
}
visit(ast);
if (workers.length !== 1) throw new Error("Expected one embedded worker");
const license = await readFile(`${sourceRoot}/LICENSE`, "utf8");
const header = "/* Spark 2.4.0; upstream MIT license:\n" + license.replaceAll("*/", "* /") + "\n*/\n";
const args = ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", `${sourceRoot}/rust/Cargo.toml`, "-p", "spark-rs", "--jobs", "4"];
execFileSync(`${root}/cargo-home/bin/cargo`, args, {env, stdio: "inherit"});
await mkdir(out);
const rawWasm = `${sourceRoot}/rust/target/wasm32-unknown-unknown/release/spark_rs.wasm`;
run(`${root}/wasm-bindgen`, [rawWasm, "--target", "web", "--out-dir", `${out}/pkg`, "--omit-default-module-path"]);
const workerSource = run("tar", ["-xOf", archive, `spark-${revision}/src/worker.ts`]);
await writeFile(`${out}/worker-entry.ts`, workerSource, {flag: "wx"});
await build({entryPoints: [`${out}/worker-entry.ts`], bundle: true, format: "iife", target: "es2022", minify: false,
  outfile: `${out}/rebuilt.js`, alias: {"spark-rs": `${out}/pkg/spark_rs.js`}, banner: {js: header}});
await writeFile(`${out}/baseline.js`, header + workers[0], {flag: "wx"});
// Serve exact bytes as data; Vite may append source maps to .js responses.
for (const name of ["baseline", "rebuilt"]) await writeFile(`${out}/${name}.worker`, await readFile(`${out}/${name}.js`), {flag: "wx"});
const manifest = {createdAt: new Date().toISOString(), revision, archiveSha256, sourceHashes, rustc, cargo, bindgen,
  rustflags: env.RUSTFLAGS, cargoArgs: args.map(a => a.replace(sourceRoot, "<source>")), wasmOpt: false,
  esbuild: JSON.parse(await readFile("node_modules/esbuild/package.json", "utf8")).version,
  bundleSha256: sha(bundle), rawWasmSha256: sha(await readFile(rawWasm)),
  wasmSha256: sha(await readFile(`${out}/pkg/spark_rs_bg.wasm`)),
  baselineSha256: sha(await readFile(`${out}/baseline.js`)), rebuiltSha256: sha(await readFile(`${out}/rebuilt.js`)),
  workerSourceSha256: sha(workerSource), license: "MIT"};
await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify({...manifest, sourceHashes: Object.keys(sourceHashes).length}));
