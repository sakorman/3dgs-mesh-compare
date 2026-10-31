import { PairedModelLoader, hashHex, sha256, type ModelFormat, type PairedSpec } from "../helpers/paired-model";
import { bufferOwnership } from "../helpers/buffer-ownership";
import type { SceneData } from "../../src/types";
import type { SplatMesh } from "@sparkjsdev/spark";

const params = new URLSearchParams(location.search), scene = params.get("scene") ?? "pipes", mode = params.get("mode") ?? "serial";
const button = document.querySelector<HTMLButtonElement>("#run")!, status = document.querySelector("#status")!;
const errors: string[] = [], visibility: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
document.addEventListener("visibilitychange", () => visibility.push(document.visibilityState));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!check()) { if (performance.now() > deadline) throw new Error("Checkpoint timeout"); await delay(5); }
}
type Memory = {beforeCapacity: number; capacity: number; outputBuffers: number; outputBytes: number; inputBytes: number};
const workers: {worker: Worker; id: number; terminated: boolean; calls: number}[] = [];
const messages: {worker: number; kind: string; id?: number; token?: number; capacity?: number; memory?: Memory}[] = [];
let workerUrl: string, wasm: WebAssembly.Module, holdNext = false, replacements = 0, nextToken = 0;
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  record = {worker: this as Worker, id: workers.length, terminated: false, calls: 0};
  constructor(_url: string | URL, options?: WorkerOptions) {
    super(workerUrl, options); workers.push(this.record);
    this.addEventListener("message", event => {
      if (!event.data.qaMemory) return;
      event.stopImmediatePropagation();
      const {qaMemory: kind, id, token, capacity, memory} = event.data;
      messages.push({worker: this.record.id, kind, id, token, capacity, memory});
    });
  }
  override postMessage(message: {name?: string; module?: WebAssembly.Module; args?: object}, options?: Transferable[] | StructuredSerializeOptions) {
    if (message.name === "init-wasm") { message = {...message, module: wasm}; replacements++; }
    if (message.name === "loadExtSplats") {
      this.record.calls++;
      if (holdNext) { message = {...message, args: {...message.args, qaHold: true}}; holdNext = false; }
    }
    if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
  }
  override terminate() { this.record.terminated = true; super.terminate(); }
};
const snapshots: object[] = [];
async function snapshot(label: string) {
  const token = ++nextToken, active = workers.filter(w => !w.terminated);
  for (const w of active) w.worker.postMessage({name: "qa-memory-snapshot", token});
  await until(() => messages.filter(m => m.kind === "snapshot" && m.token === token).length === active.length);
  const rows = messages.filter(m => m.kind === "snapshot" && m.token === token)
    .map(m => ({worker: m.worker, role: workers[m.worker].calls ? "decode" : "sort", capacity: m.capacity!}));
  const row = {label, workers: rows, decodeCapacity: rows.filter(w => w.role === "decode").reduce((n, w) => n + w.capacity, 0)};
  snapshots.push(row); return row;
}

button.onclick = async () => {
  button.disabled = true;
  let viewer: import("../../src/viewer").CompareViewer | undefined, loader: PairedModelLoader<SplatMesh> | undefined;
  const resources: {model: SplatMesh; disposed: number; published: number; before?: object; after?: object}[] = [];
  const controls: object[] = [], attributes: object[] = [];
  const modelViews = (model: SplatMesh) => {
    const ext = model.extSplats;
    return ext ? [...ext.extArrays, ext.extra.sh1!, ext.extra.sh2!, ext.extra.sh3a!, ext.extra.sh3b!].filter(Boolean) : [];
  };
  const owned = (model: SplatMesh) => bufferOwnership(modelViews(model));
  try {
    assert(["pipes", "office"].includes(scene) && ["serial", "overlap"].includes(mode) && !document.hidden, "Invalid experiment state");
    const manifest = await (await fetch("/.qa/scoped-memory/manifest.json")).json();
    const worker = new Uint8Array(await (await fetch("/.qa/scoped-memory/memory.worker")).arrayBuffer());
    const moduleBytes = new Uint8Array(await (await fetch("/.qa/wasm-build/sh-scoped/pkg/spark_rs_bg.wasm")).arrayBuffer());
    assert(await hash(worker) === manifest.workerSha256 && await hash(moduleBytes) === manifest.wasmSha256, "Build mismatch");
    workerUrl = URL.createObjectURL(new Blob([worker], {type: "text/javascript"})); wasm = await WebAssembly.compile(moduleBytes);
    const [{CompareViewer}, {SplatMesh, SplatFileType, ExtSplats}] = await Promise.all([import("../../src/viewer"), import("@sparkjsdev/spark")]);
    viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!); viewer.playing = false;
    const data: SceneData = await (await fetch(`/scenes/${scene}/scene.json`)).json(); viewer.data = data;
    const views = data.views.filter(v => v.heldOut); viewer.setView(views[0]);
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const priorAttrs = await (await fetch("/docs/benchmarks/sh-scoped-2026-10-31.json")).json();
    const asset = prior.assets.find((x: {scene: string}) => x.scene === scene), run = crypto.randomUUID();
    const url = (kind: string, digest: string) => `/__model_http/${run}/versioned/${scene}/${kind}?sha256=${digest}`;
    const spec: PairedSpec = {count: asset.count, spzSha256: asset.spzSha256, alphaRawSha256: asset.alphaRawSha256, plySha256: asset.plySha256,
      spzUrl: url("spz", asset.spzSha256), alphaUrl: url("alpha", asset.alphaRawSha256), plyUrl: url("ply", asset.plySha256)};
    loader = new PairedModelLoader({
      fetch: (url, signal) => fetch(url, {signal}),
      create(bytes, format: ModelFormat) {
        assert(format === "spz", "Unexpected PLY fallback");
        const model = new SplatMesh({fileBytes: bytes, fileType: SplatFileType.SPZ, extSplats: true, enableLod: false, lod: false});
        resources.push({model, disposed: 0, published: 0}); return model;
      },
      initialized: model => model.initialized,
      attributes: model => ({count: model.numSplats, sh: model.extSplats!.getNumSh(), words: model.extSplats!.extArrays[0]}),
      prepare(model) { model.extSplats!.textures[0].needsUpdate = true; model.maxSh = 3; model.updateGenerator(); },
      publish(model) {
        if (viewer!.gaussian) viewer!.scenes.gaussian.remove(viewer!.gaussian);
        viewer!.gaussian = model; viewer!.scenes.gaussian.add(model); resources.find(r => r.model === model)!.published++;
      },
      dispose(model) {
        const resource = resources.find(r => r.model === model)!;
        const ext = model.extSplats!;
        // Unpublished late results may never have created their SH textures.
        const textures = [...ext.textures, ...[ext.extra.sh1Texture, ext.extra.sh2Texture,
          ext.extra.sh3TextureA, ext.extra.sh3TextureB].flatMap(uniform => uniform ? [uniform.value] : [])]
          .filter(texture => texture !== ExtSplats.emptyTexture);
        resource.before = owned(model);
        viewer!.scenes.gaussian.remove(model); if (viewer!.gaussian === model) viewer!.gaussian = undefined;
        model.dispose(); resource.disposed++;
        resource.after = {model: owned(model), ext: bufferOwnership([...ext.extArrays]), extraKeys: Object.keys(ext.extra),
          textureSourcesCleared: textures.map(texture => texture.source.data === null)};
        assert(owned(model).backingBytes === 0 && ext.extArrays.every(a => a.byteLength === 0) && Object.keys(ext.extra).length === 0 &&
          textures.every(texture => texture.source.data === null), "Disposed arrays or textures retained");
      },
    });
    const capture = async (label: string, all: boolean) => {
      const row = [];
      for (const a of modelViews(viewer!.gaussian!)) row.push({bytes: a.byteLength, sha256: await hash(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))});
      const expected = priorAttrs.experiments.find((e: {prefix: string}) => e.prefix === "scoped-spz")
        .documents.find((d: {scene: string}) => d.scene === scene).attributeControls[0].attributes;
      assert(JSON.stringify(row) === JSON.stringify(expected), "Attribute mismatch"); attributes.push({label, buffers: row});
      for (const [i, view] of (all ? views : views.slice(0, 1)).entries()) {
        for (const yaw of all && i === 0 ? [0, -.08, .08] : [0]) {
          viewer!.setView(view); viewer!.camera.rotateY(yaw); await viewer!.settle();
          const pixels = viewer!.pixels("gaussian"), digest = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
          const previous = prior.comparisons.find((c: {scene: string; variant: string; view: string; yaw: number}) =>
            c.scene === scene && c.variant === "alpha16" && c.view === view.image_name && c.yaw === yaw);
          assert(digest === previous.hash, "Pixel mismatch"); controls.push({label, view: view.image_name, yaw, hash: digest});
          if (all && i === 0 && yaw === 0) {
            const figure = document.createElement("figure"), img = new Image(), caption = document.createElement("figcaption");
            img.src = viewer!.renderers.gaussian.domElement.toDataURL("image/png"); caption.textContent = `${scene} · ${mode} · SH3 / 768`;
            figure.append(img, caption); document.querySelector("#gallery")!.append(figure);
          }
        }
      }
    };
    status.textContent = "建立单模型基线";
    await loader.load(spec); await capture("initial", false); const initial = await snapshot("initial");
    const initialOwned = owned(viewer.gaussian!);
    if (mode === "overlap") {
      status.textContent = "保留迟到结果并取消重试";
      holdNext = true;
      const pending = loader.load(spec).then(() => "resolved", error => error.name);
      await until(() => messages.some(m => m.kind === "held"));
      const held = messages.find(m => m.kind === "held")!;
      loader.cancel(); assert(await pending === "AbortError", "Cancellation did not return");
      await loader.load(spec); await capture("retry", false); await snapshot("retry-with-held-result");
      assert(resources[1].disposed === 0 && resources[1].published === 0, "Held model released too early");
      workers[held.worker].worker.postMessage({name: "qa-memory-release", id: held.id});
      await until(() => resources[1].disposed === 1);
      assert(resources[1].published === 0, "Late model was published");
    } else {
      await loader.load(spec); await capture("second", false); await loader.load(spec);
    }
    await capture("final", true); const finalOwned = owned(viewer.gaussian!);
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const environment = {userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), visibility,
      crossOriginIsolated, measureUserAgentSpecificMemory: typeof (performance as Performance & {measureUserAgentSpecificMemory?: unknown}).measureUserAgentSpecificMemory};
    const beforeDispose = await snapshot("before-dispose");
    loader.dispose(); viewer.dispose(); const afterDispose = await snapshot("after-dispose");
    await delay(1000); const afterIdle = await snapshot("after-one-second-idle");
    assert(resources.length === 3 && resources.every(r => r.disposed === 1), "Model cleanup count");
    const decoders = workers.filter(w => w.calls > 0);
    assert(decoders.length === (mode === "serial" ? 1 : 2) && decoders.every(w => !w.terminated), "Pool ownership mismatch");
    assert(workers.filter(w => !w.calls).every(w => w.terminated) && replacements === workers.length, "Sort worker or module cleanup");
    assert(beforeDispose.decodeCapacity === afterDispose.decodeCapacity && afterDispose.decodeCapacity === afterIdle.decodeCapacity, "Unexpected capacity change");
    assert(errors.length === 0 && visibility.length === 0, "Browser errors or hidden document");
    const network = await (await fetch(`/__model_http/${run}/records`, {cache: "no-store"})).json();
    assert(network.length === 2, "Expected one SPZ/AP16 pair and exact-key cache reuse");
    const report = {createdAt: new Date().toISOString(), baseline: "da5ddf2", scene, mode, manifest, asset, environment,
      resolution: [viewer.width, viewer.height], initialOwned, finalOwned, snapshots, messages, controls, attributes, network,
      resources: resources.map(({disposed,published,before,after}) => ({disposed,published,before,after})),
      workers: workers.map(({id,terminated,calls}) => ({id,terminated,calls})), errors,
      method: "One document per scene/mode; three real SPZ decodes, fixed SH-scoped WASM and AP16, no LoD. Overlap holds the second decoded result in its Worker before transfer, cancels the caller, loads a replacement, then releases the old result. This controlled overlap is not natural decode latency. Counts explicit backing stores and WASM capacities at boundaries, not allocator live bytes, whole-process peak, VRAM or garbage collection. Input/output/main arrays and WASM must not be summed as a measured peak. GPU drawing is serial; no timing comparison."};
    document.querySelector("#result")!.textContent = JSON.stringify(report, null, 2);
    document.querySelector("#summary")!.textContent = `解析 Worker ${decoders.length} 个；WASM 容量 ${(afterIdle.decodeCapacity / 1048576).toFixed(2)} MiB；3 个模型已清理。此值不是内存峰值。`;
    status.textContent = `Complete; pixels=${controls.length}; attributes=${attributes.length}; initialCapacity=${initial.decodeCapacity}`;
  } catch (error) {
    status.textContent = `FAILED: ${error}`;
    document.querySelector("#result")!.textContent = JSON.stringify({failed: String(error), snapshots, messages, controls, attributes, errors}, null, 2);
  } finally {
    for (const m of messages.filter(m => m.kind === "held")) workers[m.worker].worker.postMessage({name: "qa-memory-release", id: m.id});
    loader?.dispose(); viewer?.dispose(); if (workerUrl) URL.revokeObjectURL(workerUrl);
  }
};
