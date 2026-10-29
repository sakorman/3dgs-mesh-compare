import { readPlyResponse } from "../../src/model-bytes";
import { hashHex, sha256 } from "../helpers/paired-model";
import { applyAlpha16 } from "../helpers/alpha16";
import { readAlpha16Response } from "../helpers/alpha16-stream";
import type { SceneData } from "../../src/types";

const button = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector("#status")!;
const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "pipes", format = params.get("format") ?? "ply";
const errors: string[] = [], visibility: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
document.addEventListener("visibilitychange", () => visibility.push(document.visibilityState));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
const workers: { createdMs: number; terminatedMs?: number; calls: { name: string; id?: number; sentMs: number; completedMs?: number; error?: boolean }[] }[] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  private record: typeof workers[number];
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.record = {createdMs: performance.now(), calls: []}; workers.push(this.record);
    this.addEventListener("message", event => {
      if (event.data.status !== undefined) return;
      const call = this.record.calls.find(c => c.id === event.data.id);
      if (call) { call.completedMs = performance.now(); call.error = event.data.error !== undefined; }
    });
  }
  override postMessage(message: any, options: Transferable[] | StructuredSerializeOptions = []) {
    this.record.calls.push({name: message.name, id: message.id, sentMs: performance.now()});
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
  override terminate() { this.record.terminatedMs = performance.now(); super.terminate(); }
};

button.onclick = async () => {
  button.disabled = true;
  let viewer: import("../../src/viewer").CompareViewer | undefined;
  let model: import("@sparkjsdev/spark").SplatMesh | undefined;
  let disposedModels = 0;
  const samples: object[] = [], controls: object[] = [];
  const releaseModel = () => {
    if (!model || !viewer) return;
    viewer.scenes.gaussian.remove(model); viewer.gaussian = undefined;
    model.dispose(); disposedModels++; model = undefined;
  };
  try {
    assert(["pipes", "office"].includes(scene) && ["ply", "spz"].includes(format), "Invalid scene/format");
    assert(!document.hidden, "Visible document required");
    status.textContent = "准备输入与摘要（计时区间外）";
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const asset = prior.assets.find((a: {scene: string}) => a.scene === scene);
    const data: SceneData = await (await fetch(`/scenes/${scene}/scene.json`)).json();
    const input = format === "ply"
      ? new Uint8Array(await readPlyResponse(await fetch(`/scenes/${scene}/${data.gaussian.url}`), undefined, data.gaussian.decodedBytes))
      : new Uint8Array(await (await fetch(`/.qa/spz-sh8/${scene}-sh8.spz`)).arrayBuffer());
    const inputHash = await hash(input);
    assert(inputHash === (format === "ply" ? asset.plySha256 : asset.spzSha256), "Model digest mismatch");
    const alpha = format === "spz" ? await readAlpha16Response(await fetch(`/.qa/spz-alpha16/${scene}.ap16.gz`), asset.count, await sha256(input)) : undefined;
    if (alpha) assert(await hash(alpha) === asset.alphaRawSha256, "Opacity digest mismatch");
    const modelHash = await sha256(input);
    const inputBytes = input.length;
    assert(workers.length === 0, "Unexpected worker before runtime import");

    status.textContent = "导入运行时";
    const importStart = performance.now();
    const [{CompareViewer}, {SplatMesh, SplatFileType}] = await Promise.all([import("../../src/viewer"), import("@sparkjsdev/spark")]);
    const importMs = performance.now() - importStart;
    const constructStart = performance.now();
    viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
    viewer.playing = false; viewer.data = data;
    const views = data.views.filter(v => v.heldOut);
    viewer.setView(views[0]);
    const constructMs = performance.now() - constructStart;
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    for (let index = 0; index < 3; index++) {
      status.textContent = `${scene}/${format}: ${index === 0 ? "首次" : "同页重复 " + index}`;
      releaseModel(); viewer.setView(views[0]);
      // Spark transfers this buffer to its worker; copy outside initialization timing.
      const bytes = input.slice(), workerStart = workers.length;
      assert(!document.hidden && visibility.length === 0, "Visibility changed");
      const start = performance.now();
      model = new SplatMesh({ fileBytes: bytes, fileType: format === "ply" ? SplatFileType.PLY : SplatFileType.SPZ,
        extSplats: true, enableLod: false, lod: false });
      await model.initialized;
      const initializedAt = performance.now();
      assert(model.numSplats === asset.count && model.extSplats!.getNumSh() === 3, "Count/SH mismatch");
      if (alpha) { applyAlpha16(alpha, model.extSplats!.extArrays[0], model.numSplats, modelHash); model.extSplats!.textures[0].needsUpdate = true; }
      model.maxSh = 3; model.updateGenerator();
      viewer.gaussian = model; viewer.scenes.gaussian.add(model);
      const preparedAt = performance.now();
      await viewer.settle();
      const end = performance.now();
      assert(!document.hidden && visibility.length === 0, "Visibility changed");
      samples.push({index, runtime: index === 0 ? "first-model-new-document" : "repeat-same-document",
        startMs: start, initializeMs: initializedAt - start, prepareMs: preparedAt - initializedAt,
        settleMs: end - preparedAt, totalMs: end - start, newWorkers: workers.length - workerStart});

      // First view for every trial; full held-out/yaw controls only in the first document per format.
      const full = params.get("sample") === "0" && index === 2;
      for (const [viewIndex, view] of (full ? views : views.slice(0, 1)).entries()) {
        for (const yaw of full && viewIndex === 0 ? [0, -0.08, 0.08] : [0]) {
          viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
          const pixels = viewer.pixels("gaussian");
          const pixelHash = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
          const expected = prior.comparisons.find((r: {scene: string; variant: string; view: string; yaw: number}) =>
            r.scene === scene && r.variant === (format === "ply" ? "original" : "alpha16") && r.view === view.image_name && r.yaw === yaw);
          assert(expected?.hash === pixelHash, `Pixel mismatch ${scene}/${format}/${view.image_name}/${yaw}`);
          controls.push({index, view: view.image_name, yaw, hash: pixelHash, matchesPrevious: true});
        }
      }
      if (index === 0) {
        const img = new Image(); img.src = viewer.renderers.gaussian.domElement.toDataURL("image/png");
        img.alt = `${scene} ${format} 首次初始化后的同视角画面`; document.querySelector("#gallery")!.append(img);
      }
    }
    releaseModel(); viewer.dispose();
    assert(errors.length === 0 && disposedModels === 3, "Error or model cleanup mismatch");
    document.querySelector("#result")!.textContent = JSON.stringify({createdAt: new Date().toISOString(),
      baseline: "d4b0602", scene, format, sample: params.get("sample"), spark: "2.4.0", three: "0.180.0",
      environment: {userAgent: navigator.userAgent, gpu, visibility}, importMs, constructMs,
      inputBytes, inputHash, alphaHash: alpha ? asset.alphaRawSha256 : null, count: asset.count, resolution: [viewer.width, viewer.height],
      method: "New document per scene/format, preloaded hash-checked memory inputs, runtime dynamic import before first viewer/model. Three serial fresh models in one viewer; source buffer copy excluded. initialize includes Spark worker dispatch/parse/results; settle includes shader/upload/sort/frame wait and empty Mesh draw submission. No page-navigation/network cold-cache, browser restart, independent WASM/GPU timing, presentation or peak-memory claim. Worker messages observed on main thread.",
      samples, controls, workers, disposedModels, errors}, null, 2);
    status.textContent = `Complete; samples=${samples.length}; controls=${controls.length}; disposed=${disposedModels}`;
  } catch (error) {
    document.querySelector("#result")!.textContent = JSON.stringify({failed: String(error), samples, controls, workers, errors}, null, 2);
    status.textContent = `FAILED: ${error}`;
  } finally { releaseModel(); viewer?.dispose(); }
};
