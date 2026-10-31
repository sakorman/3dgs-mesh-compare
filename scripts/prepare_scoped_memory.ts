import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = ".qa/scoped-memory";
const base = JSON.parse(await readFile(".qa/wasm-build/sh-scoped/manifest.json", "utf8"));
let worker = await readFile(".qa/wasm-build/sh-scoped/scoped.worker", "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
if (hash(worker) !== base.scopedSha256) throw new Error("Scoped worker changed");
const replace = (before: string, after: string) => {
  if (worker.split(before).length !== 2) throw new Error("Worker boundary changed: " + before);
  worker = worker.replace(before, after);
};
replace("async function onMessage(event) {", `const memoryGates = new Map();
  async function onMessage(event) {
    if (event.data.name === "qa-memory-release") {
      memoryGates.get(event.data.id)?.();
      return;
    }
    if (event.data.name === "qa-memory-snapshot") {
      self.postMessage({qaMemory: "snapshot", token: event.data.token, capacity: wasm.memory.buffer.byteLength});
      return;
    }`);
replace("const result = await handler(args, { sendStatus });", `const beforeCapacity = wasm.memory.buffer.byteLength;
      const result = await handler(args, { sendStatus });
      if (name === "loadExtSplats") {
        const stores = [...new Set(getTransferable(result))];
        const memory = {beforeCapacity, capacity: wasm.memory.buffer.byteLength,
          outputBuffers: stores.length, outputBytes: stores.reduce((n, b) => n + b.byteLength, 0),
          inputBytes: args.fileBytes?.byteLength ?? 0};
        if (args.qaHold) {
          const wait = new Promise(resolve => memoryGates.set(id, resolve));
          self.postMessage({qaMemory: "held", id, memory});
          await wait;
          memoryGates.delete(id);
        }
        self.postMessage({qaMemory: "decode", id, memory});
      }`);
await mkdir(root, {recursive: true});
await writeFile(root + "/memory.worker", worker, {flag: "wx"});
const manifest = {createdAt: new Date().toISOString(), baseWorkerSha256: base.scopedSha256,
  wasmSha256: base.wasmSha256, workerSha256: hash(worker), license: "MIT",
  upstream: base.baseline.revision,
  method: "Boundary capacity counters only. Optional controlled delay after actual loadExtSplats decoding and before result transfer. No timing claim or allocator/heap/VRAM peak measurement."};
await writeFile(root + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify(manifest));
