import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CompareViewer } from "../../src/viewer";
import { hashHex, sha256 } from "../helpers/paired-model";

const baseline = new URLSearchParams(location.search).get("variant") === "baseline";
const output = document.querySelector("#qa-result")!;
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (ready: () => boolean, label: string) => {
  const until = performance.now() + 15000;
  while (!ready()) {
    if (performance.now() > until) throw new Error(`Timeout: ${label}`);
    await pause(20);
  }
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
};
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
let viewer!: CompareViewer;
let pending: Promise<unknown>;
const load = CompareViewer.prototype.load;
CompareViewer.prototype.load = function (id) {
  viewer = this;
  const result = load.call(this, id); pending = result; return result;
};
const path = "/.qa/load-cancel/main-before.ts";
if (baseline) await import(/* @vite-ignore */ path);
else await import("../../src/main");
run.disabled = false;
output.textContent = `Ready: ${baseline ? "baseline" : "fixed"}`;

run.onclick = async () => {
  run.disabled = true;
  const records: object[] = [], pixels: object[] = [];
  const fetchOriginal = window.fetch, parseOriginal = GLTFLoader.prototype.parseAsync;
  const settleOriginal = viewer.settle.bind(viewer);
  let release = () => {};
  const choose = (scene: string) => document.querySelector<HTMLButtonElement>(`[data-scene="${scene}"]`)!.click();
  try {
    const controls = await (await fetch("/docs/benchmarks/stream-input-2026-10-28.json")).json();
    for (const scene of ["pipes", "office"]) {
      for (const stage of ["metadata", "gaussian-body", "mesh-body", "mesh-parse", "settle"]) {
        output.textContent = `${scene}: ${stage}`;
        const held = gate(); release = held.release;
        let entered = false, signal: AbortSignal | undefined, streamCancelled = false;
        let parsed: Awaited<ReturnType<typeof parseOriginal>> | undefined;
        let disposals = 0;
        window.fetch = async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const response = await fetchOriginal(input, init);
          if (!url.includes(`/scenes/${scene}/`)) return response;
          if (stage === "metadata" && url.endsWith("scene.json")) {
            const data = await response.json(); signal = init?.signal ?? undefined;
            response.json = async () => { entered = true; await held.promise; return data; };
          }
          if ((stage === "gaussian-body" && url.endsWith(".ply.gz")) || (stage === "mesh-body" && url.endsWith(".glb"))) {
            signal = init?.signal ?? undefined;
            const bytes = new Uint8Array(await response.arrayBuffer());
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            const abort = () => { streamCancelled = true; controller.error(signal!.reason); };
            const body = new ReadableStream<Uint8Array>({
              start(c) { controller = c; c.enqueue(bytes.subarray(0, 1024)); signal?.addEventListener("abort", abort, {once: true}); },
              async pull(c) { entered = true; await held.promise; signal?.removeEventListener("abort", abort); if (!signal?.aborted) { c.enqueue(bytes.subarray(1024)); c.close(); } },
              cancel() { streamCancelled = true; signal?.removeEventListener("abort", abort); },
            });
            return new Response(body);
          }
          return response;
        };
        GLTFLoader.prototype.parseAsync = async function (...args) {
          const result = await parseOriginal.apply(this, args);
          if (stage === "mesh-parse" && !entered) {
            parsed = result;
            result.scene.traverse(o => { if ("geometry" in o) (o as any).geometry.addEventListener("dispose", () => disposals++); });
            entered = true; await held.promise;
          }
          return result;
        };
        viewer.settle = async s => {
          if (stage === "settle" && !entered) { signal = s; entered = true; await held.promise; }
          return settleOriginal(s);
        };
        choose(scene);
        await waitUntil(() => entered, "held load");
        const stale = pending!;
        const offered = !button("cancel").hidden;
        const label = button("cancel").textContent;
        // A hidden button is not a user-accessible cancellation path.
        if (offered) button("cancel").click();
        await pause(80);
        const row = {scene, stage, offered, label, cancelledStatus: document.querySelector("#status")!.textContent,
          signalAborted: signal?.aborted ?? null, streamCancelled,
          retryAvailable: !button("retry").hidden,
          scenesEnabled: [...document.querySelectorAll<HTMLButtonElement>("[data-scene]")].every(b => !b.disabled),
          viewDisabled: button("view").disabled, reportDisabled: button("export").disabled,
          traceAbsent: !viewer.loadTimings, modelsDetached: !viewer.gaussian && !viewer.mesh};
        const clearedCanvases = Object.values(viewer.renderers).every(renderer => {
          const canvas = document.createElement("canvas");
          canvas.width = viewer.width; canvas.height = viewer.height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(renderer.domElement, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data.every((v, i) => i % 4 === 3 || v === 0);
        });
        Object.assign(row, {clearedCanvases});
        records.push(row);
        window.fetch = fetchOriginal; GLTFLoader.prototype.parseAsync = parseOriginal; viewer.settle = settleOriginal;
        if (baseline) { held.release(); await stale; await waitUntil(() => !button("quality").disabled, "baseline release"); continue; }
        if (!offered || !clearedCanvases || !row.retryAvailable || !row.scenesEnabled || !row.traceAbsent || !row.modelsDetached || !row.viewDisabled || !row.reportDisabled || (signal && !signal.aborted)) throw new Error(`Cancel failed: ${scene}/${stage}`);
        // Keep uncancellable parsing pending while a newer scene finishes.
        const retryScene = stage === "mesh-parse" ? (scene === "pipes" ? "office" : "pipes") : scene;
        if (retryScene === scene) button("retry").click(); else choose(retryScene);
        await waitUntil(() => !button("quality").disabled, "retry");
        const current = {g: viewer.gaussian, m: viewer.mesh, trace: viewer.loadTimings, status: document.querySelector("#status")!.textContent};
        held.release(); await stale; await pause(20);
        const kept = viewer.data?.id === retryScene && viewer.gaussian === current.g && viewer.mesh === current.m && viewer.loadTimings === current.trace && document.querySelector("#status")!.textContent === current.status && !button("quality").disabled && button("cancel").hidden;
        Object.assign(row, {retryScene, staleDidNotOverwrite: kept, lateMeshDetached: !parsed || parsed.scene.parent === null, lateGeometryDisposals: disposals});
        if (!kept || (parsed && (!disposals || parsed.scene.parent))) throw new Error(`Late result failed: ${scene}/${stage}`);
      }
      if (viewer.data?.id !== scene) { choose(scene); await waitUntil(() => !button("quality").disabled, "pixel scene"); }
      viewer.playing = false;
      for (const view of viewer.data!.views.filter(v => v.heldOut)) {
        viewer.setView(view); await viewer.settle();
        const rgba = viewer.pixels("gaussian");
        const hash = hashHex(await sha256(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)));
        const expected = controls.comparisons.find((r: any) => r.scene === scene && r.mode === "fileBytes" && r.view === view.image_name && r.yaw === 0);
        pixels.push({scene, view: view.image_name, hash, expected: expected?.hash});
        if (hash !== expected?.hash) throw new Error(`Pixel mismatch: ${scene}/${view.image_name}`);
      }
      viewer.playing = true;
    }
    output.textContent = JSON.stringify({variant: baseline ? "baseline" : "fixed", createdAt: new Date().toISOString(), environment: navigator.userAgent, records, pixels, errors}, null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({failed: String(error), records, pixels, errors}, null, 2);
  } finally {
    release(); window.fetch = fetchOriginal; GLTFLoader.prototype.parseAsync = parseOriginal; viewer.settle = settleOriginal;
    viewer.dispose();
  }
};
