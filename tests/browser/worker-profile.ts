import { hashHex, sha256 } from "../helpers/paired-model";
import { applyAlpha16, validateAlpha16 } from "../helpers/alpha16";
import type { SceneData } from "../../src/types";

const button = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector("#status")!;
const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "pipes";
const variant = params.get("variant") ?? "baseline";
const documentIndex = Number(params.get("doc") ?? 0);
assert(["baseline", "profile"].includes(variant), "Invalid worker variant");
const workerUrl = `/.qa/worker-profile/${variant}.js`;
type WorkerProfile = {handlerMs: number; stages: {name: string; elapsedMs: number; beforeBytes: number; afterBytes: number}[]};
type RequestTrace = {id: number; sentAt: number; postMs?: number; receivedAt?: number; inputBytes: number; profile?: WorkerProfile};
const requests: RequestTrace[] = [];

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
      if (record) { record.receivedAt = performance.now(); record.profile = event.data.profile ?? undefined; }
    });
  }
  override postMessage(message: {name?: string; id?: number; args?: {fileBytes?: Uint8Array}}, options?: Transferable[] | StructuredSerializeOptions) {
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
    const probeManifest = await (await fetch("/.qa/worker-profile/manifest.json")).json();
    const workerBytes = new Uint8Array(await (await fetch(workerUrl)).arrayBuffer());
    assert(await hash(workerBytes) === probeManifest[variant + "Sha256"], "Worker source mismatch");
    const manifest = await (await fetch("/.qa/spz-container/manifest.json")).json();
    const asset = manifest.assets.find((a: {scene: string}) => a.scene === scene);
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const source = prior.assets.find((a: {scene: string}) => a.scene === scene);
    assert(asset.count === source.count, "Source count changed");
    const data: SceneData = await (await fetch(`/scenes/${scene}/scene.json`)).json();
    const inputs: {name: string; bytes: Uint8Array; alpha: Uint8Array; modelHash: Uint8Array}[] = [];
    for (const variant of asset.variants.filter((v: {name: string}) => v.name === "original")) {
      const bytes = new Uint8Array(await (await fetch(variant.modelUrl)).arrayBuffer());
      const alpha = new Uint8Array(await (await fetch(variant.alphaUrl)).arrayBuffer());
      const modelHash = await sha256(bytes);
      assert(hashHex(modelHash) === variant.modelSha256 && bytes.length === variant.modelBytes, "Model mismatch");
      assert(await hash(alpha) === variant.alphaSha256 && await hash(alpha.subarray(48)) === asset.alphaPayloadSha256, "Alpha mismatch");
      validateAlpha16(alpha, asset.count, modelHash);
      const raw = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
      assert(raw.length === asset.rawBytes && await hash(raw) === asset.rawSha256, "Decoded SPZ source differs");
      assert(variant.modelSha256 === source.spzSha256 && variant.alphaSha256 === source.alphaRawSha256, "Historical source mismatch");
      inputs.push({name: variant.name, bytes, alpha, modelHash});
    }
    assert(inputs.length === 1 && inputs[0].name === "original", "Original source missing");
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
      const bytes = input.bytes.slice(), requestStart = requests.length;
      const workerStart = workers.length;
      assert(!document.hidden && visibility.length === 0, "Visibility changed");
      const start = performance.now();
      model = new SplatMesh({fileBytes: bytes, fileType: SplatFileType.SPZ, extSplats: true, enableLod: false, lod: false});
      await model.initialized;
      const initializedAt = performance.now();
      assert(model.numSplats === asset.count && model.extSplats!.getNumSh() === 3, "Count/SH mismatch");
      applyAlpha16(input.alpha, model.extSplats!.extArrays[0], model.numSplats, input.modelHash);
      model.extSplats!.textures[0].needsUpdate = true; model.maxSh = 3; model.updateGenerator();
      viewer.gaussian = model; viewer.scenes.gaussian.add(model);
      const preparedAt = performance.now();
      await viewer.settle();
      const end = performance.now();
      assert(!document.hidden && visibility.length === 0, "Visibility changed");
      const request = requests[requestStart];
      assert(requests.length === requestStart + 1 && request?.receivedAt !== undefined, "Expected one completed decode RPC");
      if (variant === "profile") {
        assert(request.profile?.stages.map(s => s.name).join(",") === "create,push,finish,resultLayout", "Missing or repeated probe boundary");
        assert(request.profile.stages.every(s => s.elapsedMs >= 0 && s.beforeBytes > 0 && s.afterBytes >= s.beforeBytes), "Invalid probe counters");
      } else assert(!request.profile, "Baseline unexpectedly instrumented");
      samples.push({index, variant, warmup, startMs: start, initializeMs: initializedAt - start,
        beforeRequestMs: request.sentAt - start, requestPostMs: request.postMs,
        roundTripMs: request.receivedAt - request.sentAt, afterReplyMs: initializedAt - request.receivedAt,
        prepareMs: preparedAt - initializedAt, settleMs: end - preparedAt, totalMs: end - start,
        newWorkers: workers.length - workerStart, request});
      // Compare all decoded attribute/SH buffers outside timing, including the restored opacity.
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
        caption.textContent = `${scene} · ${variant === "profile" ? "Worker 分段计时" : "未插桩 Worker"} · SH3 / 768`;
        figure.append(img, caption); document.querySelector("#gallery")!.append(figure);
      }
      for (const [viewIndex, view] of (full ? views : views.slice(0, 1)).entries()) {
        for (const yaw of full && viewIndex === 0 ? [0, -0.08, 0.08] : [0]) {
          viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
          const pixels = viewer.pixels("gaussian");
          const pixelHash = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
          const expected = prior.comparisons.find((r: {scene: string; variant: string; view: string; yaw: number}) =>
            r.scene === scene && r.variant === "alpha16" && r.view === view.image_name && r.yaw === yaw);
          assert(expected?.hash === pixelHash, `Pixel mismatch ${input.name}/${view.image_name}/${yaw}`);
          controls.push({index, variant, view: view.image_name, yaw, hash: pixelHash, matchesPrevious: true});
        }
      }
    }
    release(); viewer.dispose();
    assert(errors.length === 0 && disposedModels === order.length, "Error or cleanup mismatch");
    document.querySelector("#result")!.textContent = JSON.stringify({createdAt: new Date().toISOString(), baseline: "9a8520c",
      scene, variant, documentIndex, spark: "2.4.0", three: "0.180.0", environment: {userAgent: navigator.userAgent, gpu, visibility},
      manifest, asset, probeManifest, resolution: [viewer.width, viewer.height], samples, controls, attributeControls, workers, disposedModels, errors,
      method: "Pinned extracted Spark worker versus timing-only instrumented worker, same WASM module and preloaded original SPZ/AP16. One warmup plus four samples per fresh document; documents scheduled ABBA per scene. Raw input copy, hashes and module import outside timing; original SplatLoader still copies internally. Main round trip is same-clock request-to-reply including dispatch/serialization; worker stages use worker-local clock, never subtract absolute cross-thread times. push combines input copy, inflate and attribute consumption; finish includes finalization/export. Memory values are WASM linear-memory capacity at boundaries, NOT live heap/peak process/GPU memory. Total ends after settle/draw submission. No production optimization or format change."}, null, 2);
    status.textContent = `Complete; measured=4; controls=${controls.length}; disposed=${disposedModels}`;
  } catch (error) {
    document.querySelector("#result")!.textContent = JSON.stringify({failed: String(error), samples, controls, attributeControls, workers, errors}, null, 2);
    status.textContent = `FAILED: ${error}`;
  } finally { release(); viewer?.dispose(); }
};
