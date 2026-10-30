import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import ts from "typescript";
import { instrumentSparkWorker } from "../tests/helpers/worker-profile";

const source = await readFile("node_modules/@sparkjsdev/spark/dist/spark.module.js", "utf8");
const pkg = JSON.parse(await readFile("node_modules/@sparkjsdev/spark/package.json", "utf8"));
if (pkg.version !== "2.4.0") throw new Error("This probe requires Spark 2.4.0");
const ast = ts.createSourceFile("spark.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const workers: string[] = [];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "jsContent" && node.initializer && ts.isStringLiteral(node.initializer))
    workers.push(node.initializer.text);
  ts.forEachChild(node, visit);
}
visit(ast);
if (workers.length !== 1) throw new Error("Expected one embedded worker");
const worker = workers[0];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
if (sha(source) !== "5ae86ab35d4ceb655db486dcc336299775bb314c280d7e5b39f64e4539f8e0e9")
  throw new Error("Spark bundle differs from the measured 2.4.0 build");
const license = await readFile("node_modules/@sparkjsdev/spark/LICENSE", "utf8");
const header = "/* Spark 2.4.0 embedded worker; upstream license:\n" + license.replaceAll("*/", "* /") + "\n*/\n";
const baseline = header + worker, profile = header + instrumentSparkWorker(worker);
const out = ".qa/worker-profile";
await mkdir(out, {recursive: true});
await writeFile(out + "/baseline.js", baseline, {flag: "wx"});
await writeFile(out + "/profile.js", profile, {flag: "wx"});
const manifest = {createdAt: new Date().toISOString(),spark:pkg.version,bundleSha256:sha(source),workerSha256:sha(worker),
  baselineSha256:sha(baseline),profileSha256:sha(profile),license:"MIT",
  upstream:"https://github.com/sparkjsdev/spark/tree/ffe210dc0a45d0515a06c9235878108112827d61"};
await writeFile(out+"/manifest.json",JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify(manifest,null,2));
