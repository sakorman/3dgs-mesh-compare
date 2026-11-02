import {readFile, writeFile, mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {build} from "esbuild";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const root = resolve(".qa/wasm-build"), out = resolve(".qa/scoped-startup/build");
const base = JSON.parse(await readFile(`${root}/rebuild/manifest.json`, "utf8"));
const scoped = JSON.parse(await readFile(`${root}/sh-scoped/manifest.json`, "utf8"));
const archive = `${root}/spark.tar.gz`;
if (sha(await readFile(archive)) !== base.archiveSha256) throw Error("Source archive mismatch");
await mkdir(resolve(".qa/scoped-startup"), {recursive: true});
await mkdir(out); // Refuse to overwrite an existing build.
const source = `${out}/source`;
await mkdir(source);
const prefix = `spark-${base.revision}/`;
const names = execFileSync("tar", ["-tzf", archive], {encoding:"utf8"}).trim().split("\n")
  .filter(n => n.startsWith(prefix + "src/") && !n.endsWith("/") || n === prefix + "LICENSE");
if (names.some(n => n.includes(".."))) throw Error("Invalid archive entry");
execFileSync("tar", ["-xzf", archive, "-C", source, "--strip-components=1", ...names]);
const license = await readFile(`${source}/LICENSE`, "utf8");
const entry = `export {CompareViewer} from ${JSON.stringify(resolve("src/viewer.ts"))};
export {SplatMesh, SplatFileType} from "@sparkjsdev/spark";
export {WASM_MODULE, initialization} from ${JSON.stringify(source + "/src/wasm.ts")};`;
const variants = [];
for (const variant of ["rebuilt", "scoped"]) {
  const dir = variant === "rebuilt" ? "rebuild" : "sh-scoped";
  const wasm = await readFile(`${root}/${dir}/pkg/spark_rs_bg.wasm`);
  const worker = await readFile(`${root}/${dir}/${variant}.worker`, "utf8");
  const manifest = variant === "rebuilt" ? base : scoped;
  if (sha(wasm) !== manifest.wasmSha256 || sha(worker) !== manifest[variant + "Sha256"]) throw Error("Build mismatch");
  const file = `${out}/${variant}.mjs`;
  await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:"ts"},outfile:file,
    bundle:true,format:"esm",target:"es2022",minify:false,external:["three","three/*"],
    loader:{".glsl":"text"},alias:{"@sparkjsdev/spark":source+"/src/index.ts"},
    banner:{js:"/* Experimental startup bundle; Spark 2.4.0, modified WASM only for scoped.\n"+license.replaceAll("*/","* /")+"\n*/"},
    plugins:[{name:"fixed-runtime",setup(b) {
      b.onResolve({filter:/^spark-rs\/spark_rs_bg\.wasm/}, () => ({path:"wasm",namespace:"fixed"}));
      b.onResolve({filter:/^spark-rs$/}, () => ({path:`${root}/${dir}/pkg/spark_rs.js`}));
      b.onResolve({filter:/worker\?worker&inline$/}, () => ({path:"worker",namespace:"fixed"}));
      b.onLoad({filter:/.*/,namespace:"fixed"}, ({path}) => ({contents:path==="wasm"
        ? `export default Uint8Array.from(atob(${JSON.stringify(wasm.toString("base64"))}), c => c.charCodeAt(0)).buffer;`
        : `const code=${JSON.stringify(worker)}; export default class extends Worker { constructor() { const url=URL.createObjectURL(new Blob([code],{type:"text/javascript"})); try { super(url); } finally { URL.revokeObjectURL(url); } } }`,
        loader:"js"}));
    }}]});
  const bytes = await readFile(file);
  variants.push({variant,url:`/.qa/scoped-startup/build/${variant}.mjs`,bytes:bytes.length,sha256:sha(bytes),
    wasmBytes:wasm.length,wasmSha256:sha(wasm),workerSha256:sha(worker)});
}
const manifest = {createdAt:new Date().toISOString(),revision:base.revision,archiveSha256:base.archiveSha256,
  esbuild:JSON.parse(await readFile("node_modules/esbuild/package.json","utf8")).version,
  viewerSha256:sha(await readFile("src/viewer.ts")), variants,
  method:"Same upstream TypeScript, GLSL text loader, external Three.js and bootstrap for both variants. Matching generated main/worker WASM bindings; no npm runtime or replacement module. Existing fixed Rust/WASM outputs reused; no runtime cache reset claim."};
await writeFile(out+"/manifest.json",JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify(manifest,null,2));
