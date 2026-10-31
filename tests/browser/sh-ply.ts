import { hashHex, sha256 } from "../helpers/paired-model";
import { readPlyResponse } from "../../src/model-bytes";
import type { SceneData } from "../../src/types";

const button = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector("#status")!;
const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "pipes";
const variant = params.get("variant") ?? "rebuilt";
const documentIndex = Number(params.get("doc") ?? 0);
assert(["rebuilt", "candidate", "scoped"].includes(variant), "Invalid worker variant");
const folder = variant === "rebuilt" ? "rebuild" : variant === "scoped" ? "sh-scoped" : "sh-grid";
const workerSourceUrl = `/.qa/wasm-build/${folder}/${variant}.worker`;
let workerUrl: string;
type RequestTrace = {id: number; sentAt: number; postMs?: number; receivedAt?: number; inputBytes: number; moduleReplaced?: boolean};
const requests: RequestTrace[] = [];
let rebuiltModule: WebAssembly.Module | undefined;
let moduleReplacements = 0;

const errors: string[] = [], visibility: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
document.addEventListener("visibilitychange", () => visibility.push(document.visibilityState));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
const workers: {createdMs: number; terminatedMs?: number}[] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  private record: typeof workers[number];
  constructor(_url: string | URL, options?: WorkerOptions) {
    super(workerUrl, options);
    this.record = {createdMs: performance.now()}; workers.push(this.record);
    this.addEventListener("message", event => {
      if (event.data.status !== undefined) return;
      const record = requests.find(r => r.id === event.data.id);
      if (record) { record.receivedAt = performance.now();  }
    });
  }
  override postMessage(message: {name?: string; module?: WebAssembly.Module; id?: number; args?: {fileBytes?: Uint8Array}}, options?: Transferable[] | StructuredSerializeOptions) {
    if (message.name === "init-wasm") {
      assert(rebuiltModule, "Rebuilt module not compiled");
      message = {...message, module: rebuiltModule}; moduleReplacements++;
    }
    const trace = message.name === "loadExtSplats" ? {id: message.id!, sentAt: performance.now(), inputBytes: message.args!.fileBytes!.length} as RequestTrace : undefined;
    if (trace) requests.push(trace);
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
    if (trace) trace.postMs = performance.now() - trace.sentAt;
  }
  override terminate() { this.record.terminatedMs = performance.now(); super.terminate(); }
};

button.onclick = async () => {
  button.disabled = true;
  let viewer: import("../../src/viewer").CompareViewer | undefined;
  let model: import("@sparkjsdev/spark").SplatMesh | undefined;
  let disposedModels = 0;
  const samples: object[] = [], controls: object[] = [], attributeControls: object[] = [];
  let expectedAttributes: string | undefined;
  const release = () => {
    if (!model || !viewer) return;
    viewer.scenes.gaussian.remove(model); viewer.gaussian = undefined;
    model.dispose(); disposedModels++; model = undefined;
  };
  try {
    assert(["pipes", "office"].includes(scene) && !document.hidden, "Visible valid scene required");
    status.textContent = "准备输入与校验（计时区间外）";
    const probeManifest = await (await fetch(`/.qa/wasm-build/${folder}/manifest.json`)).json();
    const workerBytes = new Uint8Array(await (await fetch(workerSourceUrl)).arrayBuffer());
    assert(await hash(workerBytes) === probeManifest[variant + "Sha256"], "Worker source mismatch");
    workerUrl = URL.createObjectURL(new Blob([workerBytes], {type: "text/javascript"}));
    {
      const wasm = new Uint8Array(await (await fetch(`/.qa/wasm-build/${folder}/pkg/spark_rs_bg.wasm`)).arrayBuffer());
      assert(await hash(wasm) === probeManifest.wasmSha256, "WASM mismatch");
      rebuiltModule = await WebAssembly.compile(wasm);
    }
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const asset = prior.assets.find((a: {scene: string}) => a.scene === scene);
    const data: SceneData = await (await fetch(`/scenes/${scene}/scene.json`)).json();
    const gzip = new Uint8Array(await (await fetch(`/.qa/${scene}-gaussians.bin`)).arrayBuffer());
    assert(gzip.length === data.gaussian.bytes && await hash(gzip) === asset.plyGzipSha256, "Gzip source mismatch");
    const raw = new Uint8Array(await readPlyResponse(new Response(gzip), undefined, data.gaussian.decodedBytes));
    assert(await hash(raw) === asset.plySha256 && asset.count === data.gaussian.count, "PLY source mismatch");
    if (variant !== "rebuilt") {
      const control = await (await fetch(`/.qa/sh-ply/browser-${scene}-0.json`)).json();
      assert(control.variant === "rebuilt" && control.scene === scene && control.attributeControls.length === 5, "Baseline missing");
      expectedAttributes = JSON.stringify(control.attributeControls[0].attributes);
    }
    const inputs = [{name: "original", bytes: gzip}];
    assert(workers.length === 0, "Unexpected worker before import");
    const [{CompareViewer}, {SplatMesh, SplatFileType}] = await Promise.all([import("../../src/viewer"), import("@sparkjsdev/spark")]);
    viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
    viewer.playing = false; viewer.data = data;
    const views = data.views.filter(v => v.heldOut);
    viewer.setView(views[0]);
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const order = [0, 0, 0, 0, 0];
    for (const [index, inputIndex] of order.entries()) {
      const input = inputs[inputIndex], warmup = index === 0;
      status.textContent = `${scene} / ${variant} / 文档 ${documentIndex} / ${warmup ? "预热" : index + "/4"}`;
      release(); viewer.setView(views[0]);
      const compressed = input.bytes.slice(), requestStart = requests.length;
      const workerStart = workers.length;
      assert(!document.hidden && visibility.length === 0, "Visibility changed");
      const start = performance.now();
      const bytes = new Uint8Array(await readPlyResponse(new Response(compressed), undefined, data.gaussian.decodedBytes));
      const readAt = performance.now();
      model = new SplatMesh({fileBytes: bytes, fileType: SplatFileType.PLY, extSplats: true, enableLod: false, lod: false});
      await model.initialized;
      const initializedAt = performance.now();
      assert(model.numSplats === asset.count && model.extSplats!.getNumSh() === 3, "Count/SH mismatch");
      model.maxSh = 3; model.updateGenerator();
      viewer.gaussian = model; viewer.scenes.gaussian.add(model);
      const preparedAt = performance.now();
      await viewer.settle();
      const end = performance.now();
      assert(!document.hidden && visibility.length === 0, "Visibility changed");
      const request = requests[requestStart];
      assert(requests.length === requestStart + 1 && request?.receivedAt !== undefined, "Expected one completed decode RPC");
      samples.push({index, variant, warmup, startMs: start, readMs: readAt - start, initializeMs: initializedAt - readAt,
        beforeRequestMs: request.sentAt - readAt, requestPostMs: request.postMs,
        roundTripMs: request.receivedAt - request.sentAt, afterReplyMs: initializedAt - request.receivedAt,
        prepareMs: preparedAt - initializedAt, settleMs: end - preparedAt, totalMs: end - start,
        newWorkers: workers.length - workerStart, request});
      // Compare all decoded attribute/SH buffers outside timing, including padding; candidate checked against saved original build.
      const ext = model.extSplats!;
      const arrays = [ext.extArrays[0], ext.extArrays[1], ext.extra.sh1!, ext.extra.sh2!, ext.extra.sh3a!, ext.extra.sh3b!];
      const attributes = [];
      for (const array of arrays) {
        assert(array instanceof Uint32Array, "Missing decoded SH3 attributes");
        attributes.push({bytes: array.byteLength, sha256: await hash(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))});
      }
      const attributeKey = JSON.stringify(attributes);
      expectedAttributes ??= attributeKey;
      assert(attributeKey === expectedAttributes, "Decoded attributes differ from original control");
      attributeControls.push({index, variant, attributes, matchesOriginal: true});
      const full = index === order.length - 1;
      if (full) {
        const figure = document.createElement("figure"), img = new Image(), caption = document.createElement("figcaption");
        img.src = viewer.renderers.gaussian.domElement.toDataURL("image/png");
        img.alt = `${scene} ${input.name} 首个留出视角`;
        caption.textContent = `${scene} · ${variant === "rebuilt" ? "原始编码" : variant === "scoped" ? "恢复通用编码" : "通用网格判断"} · SH3 / 768`;
        figure.append(img, caption); document.querySelector("#gallery")!.append(figure);
      }
      for (const [viewIndex, view] of (full ? views : views.slice(0, 1)).entries()) {
        for (const yaw of full && viewIndex === 0 ? [0, -0.08, 0.08] : [0]) {
          viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
          const pixels = viewer.pixels("gaussian");
          const pixelHash = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
          const expected = prior.comparisons.find((r: {scene: string; variant: string; view: string; yaw: number}) =>
            r.scene === scene && r.variant === "original" && r.view === view.image_name && r.yaw === yaw);
          assert(expected?.hash === pixelHash, `Pixel mismatch ${input.name}/${view.image_name}/${yaw}`);
          controls.push({index, variant, view: view.image_name, yaw, hash: pixelHash, matchesPrevious: true});
        }
      }
    }
    release(); viewer.dispose();
    assert(moduleReplacements === workers.length, "Wrong module replacement count");
    assert(errors.length === 0 && disposedModels === order.length, "Error or cleanup mismatch");
    document.querySelector("#result")!.textContent = JSON.stringify({createdAt: new Date().toISOString(), baseline: "700f8c3", format: "ply",
      scene, variant, documentIndex, spark: "2.4.0", three: "0.180.0", environment: {userAgent: navigator.userAgent, gpu, visibility},
      asset, sourceUrl: `/scenes/${scene}/${data.gaussian.url}`, sourceDecodedBytes: data.gaussian.decodedBytes, probeManifest, resolution: [viewer.width, viewer.height], samples, controls, attributeControls, workers, moduleReplacements, disposedModels, errors,
      method: "Same pinned original/grid-exponent WASM builds, now decoding default gzip PLY. Preloaded compressed input; readPlyResponse gzip decode and size validation included in readMs/totalMs. WASM compile, imports, source copies and hashes excluded. One warmup then four samples in each fresh document; ABBA serial. Full attributes cross-checked between builds and pixels against historical original PLY. No AP16 restoration or SH quantization change. End is stable draw submission, not GPU finish or screen presentation. No network/peak-memory/general-format conclusion beyond these two PLY models."}, null, 2);
    status.textContent = `Complete; measured=4; controls=${controls.length}; disposed=${disposedModels}`;
  } catch (error) {
    document.querySelector("#result")!.textContent = JSON.stringify({failed: String(error), samples, controls, attributeControls, workers, requests, errors}, null, 2);
    status.textContent = `FAILED: ${error}`;
  } finally { release(); viewer?.dispose(); if (workerUrl) URL.revokeObjectURL(workerUrl); }
};
