import {readFile, writeFile, mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {build} from "vite";
import type {RollupOutput} from "rollup";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const sourceDir = resolve(".qa/scoped-startup/build"), outDir = resolve(".qa/release-startup/site");
const source = JSON.parse(await readFile(`${sourceDir}/manifest.json`, "utf8"));
assert.equal(sha(await readFile("src/viewer.ts")), source.viewerSha256);
assert.equal(sha(await readFile(".qa/wasm-build/spark.tar.gz")), source.archiveSha256);
for (const v of source.variants) {
  const bytes = await readFile(`${sourceDir}/${v.variant}.mjs`);
  assert.equal(sha(bytes), v.sha256); assert.equal(bytes.length, v.bytes);
}
await mkdir(resolve(".qa/release-startup"), {recursive:true});
await mkdir(outDir); // Refuse to overwrite a completed or in-progress experiment.
const output = await build({configFile:false, base:"/", publicDir:false,
  build:{outDir,emptyOutDir:false,target:"es2022",sourcemap:false,minify:"esbuild",reportCompressedSize:false,
    chunkSizeWarningLimit:4000,rollupOptions:{input:{
      experiment:resolve("tests/browser/release-startup.html"),
      rebuilt:`${sourceDir}/rebuilt.mjs`,scoped:`${sourceDir}/scoped.mjs`,
    },preserveEntrySignatures:"strict"}}}) as RollupOutput;
const files: {url:string;bytes:number;sha256:string;gzipBytes:number;gzipSha256:string;entry?:string;imports:string[]}[] = [];
for (const file of output.output) {
  const bytes = await readFile(`${outDir}/${file.fileName}`), compressed = gzipSync(bytes, {level:6});
  await writeFile(`${outDir}/${file.fileName}.gz`, compressed, {flag:"wx"});
  files.push({url:"/"+file.fileName,bytes:bytes.length,sha256:sha(bytes),gzipBytes:compressed.length,gzipSha256:sha(compressed),
    entry:file.type === "chunk" && file.isEntry ? file.name : undefined,
    imports:file.type === "chunk" ? file.imports.map(i=>"/"+i) : []});
}
const sourceHashes: Record<string,string> = {};
for (const path of ["scripts/build_release_startup.ts","scripts/serve_release_startup.ts","tests/browser/release-startup.ts",
  "tests/browser/release-startup.html","tests/helpers/paired-model.ts","tests/helpers/http-model-fixture.ts",
  "tests/helpers/shared-response.ts","src/viewer.ts"]) sourceHashes[path] = sha(await readFile(path));
const manifest = {createdAt:new Date().toISOString(),source,sourceHashes,
  toolchain:{node:process.version,vite:JSON.parse(await readFile("node_modules/vite/package.json","utf8")).version,
    esbuild:JSON.parse(await readFile("node_modules/esbuild/package.json","utf8")).version},files,
  variants:source.variants.map((v:{variant:string})=>({...v,url:files.find(f=>f.entry===v.variant)!.url})),
  method:"Vite static multi-entry build, ES2022, esbuild minification, no source maps. Shared Three.js chunk. Matching fixed source main/Worker WASM. Precomputed gzip level 6 served with no-store for code; model pair retains controlled cache. No browser-process/compile-cache reset."};
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest,null,2)+"\n", {flag:"wx"});
console.log(JSON.stringify({toolchain:manifest.toolchain,files,variants:manifest.variants},null,2));
