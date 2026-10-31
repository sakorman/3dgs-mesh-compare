import { PairedModelLoader, hashHex, sha256, type ModelFormat, type PairedSpec } from "../helpers/paired-model";
import type { SceneData } from "../../src/types";
import type { HttpRecord } from "../helpers/http-model-fixture";

const params = new URLSearchParams(location.search), scene = params.get("scene") ?? "pipes";
const variant = params.get("variant") ?? "fixed";
const button = document.querySelector<HTMLButtonElement>("#run")!, status = document.querySelector("#status")!;
const errors: string[] = [], visibility: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
document.addEventListener("visibilitychange", () => visibility.push(document.visibilityState));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => resolve = yes); return {promise, resolve}; }
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
let workerUrl: string, wasm: WebAssembly.Module, moduleReplacements = 0;
const workers: {terminated: boolean}[] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  record = {terminated: false};
  constructor(_url: string | URL, options?: WorkerOptions) { super(workerUrl, options); workers.push(this.record); }
  override postMessage(message: {name?: string; module?: WebAssembly.Module}, options?: Transferable[] | StructuredSerializeOptions) {
    if (message.name === "init-wasm") { message = {...message, module: wasm}; moduleReplacements++; }
    if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
  }
  override terminate() { this.record.terminated = true; super.terminate(); }
};

button.onclick = async () => {
  button.disabled = true;
  let viewer: import("../../src/viewer").CompareViewer | undefined;
  let loader: PairedModelLoader<import("@sparkjsdev/spark").SplatMesh> | undefined;
  const resources: {model: import("@sparkjsdev/spark").SplatMesh; format: ModelFormat; disposed: number; published: number}[] = [];
  const checks: object[] = [], controls: object[] = [], attributes: object[] = [];
  const releases: (() => void)[] = [];
  const requests: {url: string; aborted: boolean}[] = [];
  try {
    assert(["pipes", "office"].includes(scene) && ["baseline", "fixed"].includes(variant) && !document.hidden, "Invalid experiment state");
    const manifest = await (await fetch("/.qa/wasm-build/sh-scoped/manifest.json")).json();
    const worker = new Uint8Array(await (await fetch("/.qa/wasm-build/sh-scoped/scoped.worker")).arrayBuffer());
    const moduleBytes = new Uint8Array(await (await fetch("/.qa/wasm-build/sh-scoped/pkg/spark_rs_bg.wasm")).arrayBuffer());
    assert(await hash(worker) === manifest.scopedSha256 && await hash(moduleBytes) === manifest.wasmSha256, "Build mismatch");
    workerUrl = URL.createObjectURL(new Blob([worker], {type: "text/javascript"})); wasm = await WebAssembly.compile(moduleBytes);
    const [{CompareViewer}, {SplatMesh, SplatFileType}] = await Promise.all([import("../../src/viewer"), import("@sparkjsdev/spark")]);
    // Frozen pre-fix loader is generated from 777a1a3; only its relative helper imports change.
    const Loader: typeof PairedModelLoader = variant === "fixed" ? PairedModelLoader :
      // @ts-expect-error Ignored baseline fixture.
      (await import("/.qa/scoped-cancel/baseline-loader.ts")).PairedModelLoader;
    viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
    viewer.playing = false;
    const data: SceneData = await (await fetch(`/scenes/${scene}/scene.json`)).json(); viewer.data = data;
    const views = data.views.filter(v => v.heldOut); viewer.setView(views[0]);
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const priorAttrs = await (await fetch("/docs/benchmarks/sh-scoped-2026-10-31.json")).json();
    const asset = prior.assets.find((x: {scene: string}) => x.scene === scene);
    const run = crypto.randomUUID();
    const specFor = (key: string): PairedSpec => {
      const url = (kind: string, digest: string) => `/__model_http/${run}/versioned/${scene}/${kind}?sha256=${digest}&sample=${key}`;
      return {count: asset.count, spzSha256: asset.spzSha256, alphaRawSha256: asset.alphaRawSha256, plySha256: asset.plySha256,
        spzUrl: url("spz", asset.spzSha256), alphaUrl: url("alpha", asset.alphaRawSha256), plyUrl: url("ply", asset.plySha256)};
    };
    const logs = async (): Promise<HttpRecord[]> => (await fetch(`/__model_http/${run}/records`, {cache: "no-store"})).json();
    const driver = {
      async fetch(url: string, signal: AbortSignal) {
        const entry = {url, aborted: false}; requests.push(entry);
        signal.addEventListener("abort", () => { entry.aborted = true; }, {once: true});
        return fetch(url, {signal});
      },
      create(bytes: Uint8Array, format: ModelFormat) {
        const model = new SplatMesh({fileBytes: bytes, fileType: format === "ply" ? SplatFileType.PLY : SplatFileType.SPZ,
          extSplats: true, enableLod: false, lod: false});
        resources.push({model, format, disposed: 0, published: 0}); return model;
      },
      initialized: (model: import("@sparkjsdev/spark").SplatMesh): Promise<unknown> => model.initialized,
      attributes: (model: import("@sparkjsdev/spark").SplatMesh) => ({count: model.numSplats, sh: model.extSplats!.getNumSh(), words: model.extSplats!.extArrays[0]}),
      prepare(model: import("@sparkjsdev/spark").SplatMesh) { model.extSplats!.textures[0].needsUpdate = true; model.maxSh = 3; model.updateGenerator(); },
      publish(model: import("@sparkjsdev/spark").SplatMesh) {
        if (viewer!.gaussian) viewer!.scenes.gaussian.remove(viewer!.gaussian);
        viewer!.gaussian = model; viewer!.scenes.gaussian.add(model); resources.find(r => r.model === model)!.published++;
      },
      dispose(model: import("@sparkjsdev/spark").SplatMesh) {
        viewer!.scenes.gaussian.remove(model); if (viewer!.gaussian === model) viewer!.gaussian = undefined;
        resources.find(r => r.model === model)!.disposed++; model.dispose();
      },
    };
    loader = new Loader(driver);
    const capture = async (label: string, format: ModelFormat, all: boolean) => {
      const ext = viewer!.gaussian!.extSplats!;
      const buffers = [ext.extArrays[0], ext.extArrays[1], ext.extra.sh1!, ext.extra.sh2!, ext.extra.sh3a!, ext.extra.sh3b!];
      const row = [];
      for (const a of buffers) row.push({bytes: a.byteLength, sha256: await hash(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))});
      const expected = priorAttrs.experiments.find((e: {prefix: string}) => e.prefix === "scoped-" + format)
        .documents.find((d: {scene: string}) => d.scene === scene).attributeControls[0].attributes;
      assert(JSON.stringify(row) === JSON.stringify(expected), "Attribute mismatch");
      attributes.push({label, format, buffers: row});
      for (const [i, view] of (all ? views : views.slice(0, 1)).entries()) {
        for (const yaw of all && i === 0 ? [0, -.08, .08] : [0]) {
          viewer!.setView(view); viewer!.camera.rotateY(yaw); await viewer!.settle();
          const pixels = viewer!.pixels("gaussian"), digest = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
          const previous = prior.comparisons.find((c: {scene: string; variant: string; view: string; yaw: number}) =>
            c.scene === scene && c.variant === (format === "ply" ? "original" : "alpha16") && c.view === view.image_name && c.yaw === yaw);
          assert(digest === previous.hash, "Pixel mismatch");
          controls.push({label, format, view: view.image_name, yaw, hash: digest});
          if (all && i === 0 && yaw === 0) {
            const figure = document.createElement("figure"), img = new Image(), caption = document.createElement("figcaption");
            img.src = viewer!.renderers.gaussian.domElement.toDataURL("image/png");
            caption.textContent = `${scene} · ${label} · SH3 / 768`; figure.append(img, caption); document.querySelector("#gallery")!.append(figure);
          }
        }
      }
    };
    status.textContent = "读取候选与验证画面";
    const initial = specFor("initial");
    await loader.load(initial); await capture("SPZ 控制", "spz", true);
    const initialNetwork = await logs();
    assert(initialNetwork.length === 2 && initialNetwork.every(r => r.finished && r.closed), "HTTP source missing");
    const beforeWarm = initialNetwork.length;
    await loader.load(initial);
    assert((await logs()).length === beforeWarm, "Expected exact-key HTTP cache hit");
    checks.push({kind: "http-miss-hit", initialNetwork, warmExtraRequests: 0});
    for (const format of ["spz", "ply"] as const) {
      for (const lateFailure of [false, true]) {
        status.textContent = `${format} 取消 / 迟到${lateFailure ? "失败" : "成功"}`;
        const entered = deferred(), gate = deferred(); releases.push(gate.resolve);
        let delayed: typeof resources[number] | undefined;
        const previous = viewer.gaussian;
        driver.initialized = async model => {
          delayed = resources.find(r => r.model === model)!; entered.resolve();
          await model.initialized; await gate.promise;
          if (lateFailure) throw new Error("Injected late initialization failure");
        };
        let outcome: string | undefined, returnedMs: number | undefined, cancelAt = 0;
        const pending = loader.load(specFor(`cancel-${format}-${lateFailure}`), format).then(
          () => { outcome = "resolved"; }, error => { outcome = error.name; returnedMs = performance.now() - cancelAt; });
        await entered.promise; cancelAt = performance.now(); loader.cancel();
        await delay(30);
        const returnedBeforeRelease = outcome === "AbortError";
        assert(returnedBeforeRelease === (variant === "fixed"), "Cancellation outcome before decoder release");
        assert(delayed!.disposed === 0 && delayed!.published === 0 && viewer.gaussian === previous, "Unsafe cancellation");
        driver.initialized = model => model.initialized;
        const requestStart = requests.length;
        const retry = await loader.load(initial);
        const snapshot = JSON.stringify(retry.phases);
        gate.resolve(); await pending;
        const deadline = performance.now() + 2000;
        while (delayed!.disposed === 0 && performance.now() < deadline) await delay(5);
        assert(Number(delayed!.disposed) === 1 && delayed!.published === 0 && viewer.gaussian === retry.model, "Late result ownership");
        assert(JSON.stringify(retry.phases) === snapshot, "Late completion changed retry report");
        assert(requests.slice(requestStart).every(r => !r.url.includes("/ply?")), "Cancellation started fallback");
        checks.push({kind: "initialize-cancel", format, lateFailure, returnedBeforeRelease, returnedMs,
          lateDisposed: delayed!.disposed, latePublished: delayed!.published, retryReportUnchanged: true});
        await capture(`${format}-${lateFailure} 重试`, "spz", false);
      }
    }
    status.textContent = "检查 HTTP 中断与 PLY 回退";
    const beforeCancel = (await logs()).length, previous = viewer.gaussian, modelCount = resources.length;
    const slow = specFor("network");
    slow.spzUrl = slow.spzUrl.replace("/versioned/", "/shared/");
    slow.alphaUrl = slow.alphaUrl.replace("/versioned/", "/slow/");
    const networkPending = loader.load(slow).then(() => "resolved", error => error.name);
    let rows: HttpRecord[] = [];
    const deadline = performance.now() + 5000;
    do { rows = (await logs()).slice(beforeCancel); if (rows.length === 2 && rows.every(r => (r.shared?.bytesOffered ?? r.bodyBytesOffered) > 0)) break; await delay(10); } while (performance.now() < deadline);
    assert(rows.length === 2 && rows.every(r => (r.shared?.bytesOffered ?? r.bodyBytesOffered) > 0), "Body cancellation checkpoint");
    loader.cancel(); assert(await networkPending === "AbortError", "HTTP cancel failed");
    do { rows = (await logs()).slice(beforeCancel); if (rows.every(r => r.closed)) break; await delay(10); } while (performance.now() < deadline);
    assert(rows.every(r => r.closed && !r.finished) && viewer.gaussian === previous && resources.length === modelCount, "HTTP cleanup failed");
    checks.push({kind: "http-body-cancel", network: rows});
    await loader.load(initial); await capture("HTTP 取消后重试", "spz", false);
    const fallbackSpec = specFor("fallback");
    fallbackSpec.alphaUrl = fallbackSpec.alphaUrl.replace(asset.alphaRawSha256, "0".repeat(64));
    const beforeFallback = requests.length;
    const fallback = await loader.load(fallbackSpec);
    assert(fallback.format === "ply" && fallback.fallbackReason?.includes("404"), "Expected PLY fallback");
    assert(requests.slice(beforeFallback).filter(r => r.url.includes("/ply?")).length === 1, "Repeated fallback");
    await capture("PLY 回退", "ply", true);
    checks.push({kind: "missing-sidecar", reason: fallback.fallbackReason, phases: fallback.phases});
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    loader.dispose(); viewer.dispose();
    assert(resources.every(r => r.disposed === 1) && errors.length === 0 && visibility.length === 0, "Cleanup/error mismatch");
    assert(moduleReplacements === workers.length && workers.length >= 2 && workers.length <= 3, "Unexpected worker/module count");
    document.querySelector("#result")!.textContent = JSON.stringify({createdAt: new Date().toISOString(), baseline: "777a1a3", scene, variant, manifest,
      asset, environment: {userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), visibility},
      resolution: [viewer.width, viewer.height], checks, controls, attributes, resources: resources.map(({format,disposed,published}) => ({format,disposed,published})),
      workers, moduleReplacements, requests, network: await logs(), errors,
      method: "Same SPZ-scoped WASM and files, old/fixed loader correctness comparison. Real HTTP miss/hit, body abort and 404 PLY fallback. Initialization delivery is held after real decoding; a synthetic late failure is optional. Cancellation sampled after 30ms while gate remains closed; response time is not decoder speed. No cold-process, GPU timing, memory peak, continuous orbit or PSNR rerun."}, null, 2);
    status.textContent = `Complete; checks=${checks.length}; pixels=${controls.length}; attributes=${attributes.length}; disposed=${resources.length}`;
  } catch (error) {
    status.textContent = `FAILED: ${error}`;
    document.querySelector("#result")!.textContent = JSON.stringify({failed: String(error), checks, controls, attributes, workers, moduleReplacements, errors}, null, 2);
  } finally { releases.forEach(release => release()); loader?.dispose(); viewer?.dispose(); if (workerUrl) URL.revokeObjectURL(workerUrl); }
};
