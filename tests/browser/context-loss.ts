import type { CompareViewer as Viewer } from "../../src/viewer";
import { hashHex, sha256 } from "../helpers/paired-model";
import type { Backend } from "../../src/types";

const params = new URLSearchParams(location.search);
const baseline = params.get("variant") === "baseline";
const scene = params.get("scene") ?? "pipes";
const stage = params.get("stage") ?? "ready";
const backend = (params.get("backend") ?? "gaussian") as Backend;
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const output = document.querySelector("#qa-result")!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitUntil = async (test: () => boolean, label: string) => {
  const end = performance.now() + 20000;
  while (!test()) {
    if (performance.now() > end) throw new Error("Timeout: " + label);
    await pause(20);
  }
};
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
const workers: {terminated: boolean}[] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  private record: {terminated: boolean};
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); this.record = {terminated: false}; workers.push(this.record);
  }
  override terminate() { this.record.terminated = true; super.terminate(); }
};
const viewerPath = "/.qa/context-loss/viewer-before.ts";
const { CompareViewer }: {CompareViewer: typeof import("../../src/viewer").CompareViewer} = baseline
  ? await import(/* @vite-ignore */ viewerPath) : await import("../../src/viewer");
let viewer!: Viewer, pending: Promise<unknown>, loads = 0;
const load = CompareViewer.prototype.load;
CompareViewer.prototype.load = function (id) { viewer = this; loads++; return pending = load.call(this, id); };
const path = "/.qa/context-loss/main-before.ts";
if (baseline) await import(/* @vite-ignore */ path);
else await import("../../src/main");
await waitUntil(() => !button("quality").disabled, "initial load");
run.disabled = false;
output.textContent = "Ready: " + (baseline ? "baseline" : "fixed");
const choose = (id: string) => document.querySelector<HTMLButtonElement>(`[data-scene="${id}"]`)!.click();
const state = () => ({
  status: button("status").textContent,
  scenesDisabled: [...document.querySelectorAll<HTMLButtonElement>("[data-scene]")].every(b => b.disabled),
  viewDisabled: button("view").disabled, resolutionDisabled: button("resolution").disabled,
  qualityDisabled: button("quality").disabled, benchmarkDisabled: button("bench").disabled,
  exportDisabled: button("export").disabled, cancelHidden: button("cancel").hidden,
  retryVisible: !button("retry").hidden, retryLabel: button("retry").textContent,
  loadReportHidden: button("load-details").hidden, qualityReportHidden: button("quality-details").hidden,
  qualityCleared: button("gs-quality").textContent === "—" && button("mesh-quality").textContent === "—",
  lost: viewer.lost, disposed: viewer.disposed, playing: viewer.playing, traceAbsent: !viewer.loadTimings,
  workersCreated: workers.length, workersTerminated: workers.filter(w => w.terminated).length,
  modelsDetached: !viewer.gaussian && !viewer.mesh,
});
run.onclick = async () => {
  run.disabled = true;
  const pixels: object[] = [];
  const originalFetch = window.fetch, originalSettle = viewer.settle.bind(viewer);
  let release = () => {}, entered = false, work: Promise<unknown> | undefined;
  let before: ReturnType<typeof state> | undefined, after: ReturnType<typeof state> | undefined;
  const gate = new Promise<void>(r => { release = r; });
  try {
    assert(["pipes", "office"].includes(scene) && ["gaussian", "mesh"].includes(backend), "Invalid scene/backend");
    assert(["ready", "metadata", "settle", "benchmark", "quality-restore"].includes(stage), "Invalid stage");
    if (viewer.data?.id !== scene) { choose(scene); await pending!; }
    viewer.playing = false;
    if (stage === "ready") {
      const prior = await (await fetch("/docs/benchmarks/quality-frames-2026-10-29.json")).json();
      for (const view of viewer.data!.views.filter(v => v.heldOut)) {
        viewer.setView(view); await viewer.settle();
        for (const kind of ["gaussian", "mesh"] as const) {
          const rgba = viewer.pixels(kind);
          const hash = hashHex(await sha256(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)));
          const expected = prior.normal.find((r: {scene: string}) => r.scene === scene)?.inputs.find((i: {view: string; kind: string}) => i.view === view.image_name && i.kind === kind);
          assert(hash === expected?.hash, "Pixel mismatch");
          pixels.push({scene, view: view.image_name, kind, hash, matchesPrevious: true});
        }
      }
    }
    if (stage === "metadata") {
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith(`/scenes/${scene}/scene.json`)) {
          const data = await response.json();
          response.json = async () => { entered = true; await gate; return data; };
        }
        return response;
      };
      choose(scene); work = pending!;
    } else if (stage === "settle") {
      viewer.settle = async signal => { entered = true; await gate; return originalSettle(signal); };
      choose(scene); work = pending!;
    } else if (stage === "quality-restore" || stage === "benchmark") {
      if (stage === "quality-restore") {
        let calls = 0;
        const target = viewer.data!.views.filter(v => v.heldOut).length + 1;
        viewer.settle = async signal => { if (++calls === target) { entered = true; await gate; } return originalSettle(signal); };
      }
      const target = button(stage === "benchmark" ? "bench" : "quality"), handler = target.onclick!;
      target.onclick = function (event) { work = Promise.resolve(handler.call(this, event)); };
      target.click();
      if (stage === "benchmark") await waitUntil(() => button("status").textContent?.includes("第 1/4") ?? false, "benchmark sampling");
    }
    if (["metadata", "settle", "quality-restore"].includes(stage)) await waitUntil(() => entered, "held work");
    const qualityPublishedBeforeLoss = !button("quality-details").hidden;
    const gl = viewer.renderers[backend].getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const extension = gl.getExtension("WEBGL_lose_context");
    assert(extension, "WEBGL_lose_context unavailable");
    extension!.loseContext();
    await waitUntil(() => viewer.lost && gl.isContextLost(), "native context loss");
    await pause(80); before = state();
    release();
    await work; await pause(80); after = state();
    const oldLoads = loads;
    choose(scene === "pipes" ? "office" : "pipes");
    await pause(30);
    const attemptedSceneSwitch = {extraLoads: loads - oldLoads, state: state()};
    const healthy = (s: ReturnType<typeof state>) => s.lost && s.disposed && s.workersTerminated === 1 && !s.playing && s.scenesDisabled && s.viewDisabled &&
      s.resolutionDisabled && s.qualityDisabled && s.benchmarkDisabled && s.exportDisabled && s.cancelHidden &&
      s.retryVisible && s.retryLabel === "刷新页面" && s.status?.includes("显卡上下文丢失") &&
      s.loadReportHidden && s.qualityReportHidden && s.qualityCleared && s.traceAbsent && s.modelsDetached;
    const passed = healthy(before) && healthy(after) && healthy(attemptedSceneSwitch.state) && attemptedSceneSwitch.extraLoads === 0;
    assert(stage !== "quality-restore" || qualityPublishedBeforeLoss, "Restore gate missed published quality report");
    if (!baseline) assert(passed, "Unusable page state escaped loss handling");
    assert(errors.length === 0, "Unhandled browser errors");
    output.textContent = JSON.stringify({createdAt: new Date().toISOString(), baselineCommit: "ae2ead8",
      variant: baseline ? "baseline" : "fixed", scene, stage, backend, gpu, userAgent: navigator.userAgent,
      passed, qualityPublishedBeforeLoss, before, after, attemptedSceneSwitch, pixels, errors,
      method: "Real WEBGL_lose_context event, delayed metadata/settle completions, 80ms observation before/after release. Full-size held-out pixels checked in ready cases. Not natural GPU fault, restoration or performance measurement."}, null, 2);
  } catch (error) { output.textContent = JSON.stringify({failed: String(error), scene, stage, backend, before, after, pixels, errors}, null, 2); }
  finally { release(); window.fetch = originalFetch; viewer.settle = originalSettle; }
};
