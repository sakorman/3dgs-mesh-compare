import { CompareViewer } from "../../src/viewer";
import { hashHex, sha256 } from "../helpers/paired-model";

const baseline = new URLSearchParams(location.search).get("variant") === "baseline";
const output = document.querySelector("#qa-result")!;
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
let viewer!: CompareViewer;
const load = CompareViewer.prototype.load;
CompareViewer.prototype.load = function (id) { viewer = this; return load.call(this, id); };
const baselinePath = "/.qa/quality-frames/main-before.ts";
if (baseline) await import(/* @vite-ignore */ baselinePath);
else await import("../../src/main");
const waitUntil = async (ready: () => boolean, label: string) => {
  const until = performance.now() + 15000;
  while (!ready()) {
    if (performance.now() > until) throw new Error(`Timeout: ${label}`);
    await new Promise(r => setTimeout(r, 20));
  }
};
await waitUntil(() => !button("quality").disabled, "initial load");
run.disabled = false;
output.textContent = `Ready: ${baseline ? "baseline" : "fixed"}`;
const exportReport = () => {
  button("export").click();
  const report = JSON.parse(document.querySelector<HTMLTextAreaElement>("#report-json")!.value);
  button("close-report").click();
  return report;
};
run.onclick = async () => {
  run.disabled = true;
  const records: object[] = [], normal: object[] = [], pixels: object[] = [];
  const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
  const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
  const reveal = () => {
    if (hidden) Object.defineProperty(document, "hidden", hidden);
    else delete (document as {hidden?: boolean}).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  try {
    const prior = await (await fetch("/docs/benchmarks/stream-input-2026-10-28.json")).json();
    for (const scene of ["pipes", "office"]) {
      if (viewer.data?.id !== scene) {
        document.querySelector<HTMLButtonElement>(`[data-scene="${scene}"]`)!.click();
        await waitUntil(() => !button("quality").disabled, "scene load");
      }
      const view = document.querySelector<HTMLSelectElement>("#view")!;
      view.value = "1"; view.dispatchEvent(new Event("change"));
      const original = viewer.data!.views[1].image_name;
      const scenarios = ["settle-cancel", "yield-cancel", "yield-hidden", "restore-cancel", "restore-hidden"];
      for (const scenario of scenarios) {
        output.textContent = `${scene}: ${scenario}`;
        let held = false, id = -1, entered = false, interrupted = false, latePixels = 0, lateRenders = 0, setsAfterDispose = 0;
        const frames = new Map<number, FrameRequestCallback>();
        window.requestAnimationFrame = callback => {
          if (!held) return request(callback);
          const handle = --id; frames.set(handle, callback); entered = true; return handle;
        };
        window.cancelAnimationFrame = handle => { if (!frames.delete(handle)) cancel(handle); };
        const settle = viewer.settle.bind(viewer), read = viewer.pixels.bind(viewer), render = viewer.render.bind(viewer), setView = viewer.setView.bind(viewer);
        let settlements = 0;
        const heldOutCount = viewer.data!.views.filter(v => v.heldOut).length;
        viewer.settle = async signal => {
          settlements++;
          if ((scenario === "settle-cancel" && settlements === 1) || (scenario.startsWith("restore-") && settlements === heldOutCount + 1)) held = true;
          return settle(signal);
        };
        viewer.pixels = kind => {
          if (interrupted) latePixels++;
          const result = read(kind);
          if (kind === "gaussian" && scenario.startsWith("yield-")) held = true;
          return result;
        };
        viewer.render = kind => { if (interrupted) lateRenders++; render(kind); };
        viewer.setView = v => { if (viewer.disposed) setsAfterDispose++; setView(v); };
        const quality = button("quality"), handler = quality.onclick!;
        let finished!: Promise<unknown>, ended = false;
        quality.onclick = function (event) {
          finished = Promise.resolve(handler.call(this, event)).finally(() => { ended = true; viewer.playing = false; });
        };
        quality.click();
        await waitUntil(() => entered, "held frame");
        const reportVisibleAtInterrupt = !document.querySelector<HTMLElement>("#quality-details")!.hidden;
        interrupted = true;
        if (scenario.endsWith("hidden")) {
          Object.defineProperty(document, "hidden", {configurable: true, get: () => true});
          document.dispatchEvent(new Event("visibilitychange"));
        } else button("cancel").click();
        await new Promise(r => setTimeout(r, 80));
        const row = {scene, scenario, endedWithoutFrame: ended, heldFrames: frames.size, controlsUnlocked: !quality.disabled,
          latePixels, lateRenders, setsAfterDispose, reportVisibleAtInterrupt,
          reportAbsent: document.querySelector("#gs-quality")!.textContent === "—" && document.querySelector<HTMLElement>("#quality-details")!.hidden,
          cameraRestored: viewer.view?.image_name === original, status: document.querySelector("#status")!.textContent};
        records.push(row);
        window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; held = false;
        reveal();
        for (const fn of frames.values()) request(fn); frames.clear();
        await finished;
        viewer.settle = settle; viewer.pixels = read; viewer.render = render; viewer.setView = setView; quality.onclick = handler;
        const exported = exportReport();
        Object.assign(row, {exportedQualityAbsent: exported.quality === null});
        if (!baseline && (!row.endedWithoutFrame || row.heldFrames || !row.controlsUnlocked || !row.reportAbsent || !row.cameraRestored || row.latePixels || row.lateRenders || exported.quality !== null)) throw new Error(`Failed ${scene}/${scenario}`);
        viewer.playing = false;
        await viewer.settle();
      }
      // Normal evaluation after repeated cancellations still covers every held-out camera.
      const quality = button("quality"), handler = quality.onclick!;
      const reference = viewer.reference.bind(viewer), read = viewer.pixels.bind(viewer);
      const captured: {view: string; kind: string; bytes: Uint8Array}[] = [];
      viewer.reference = async view => {
        const rgba = await reference(view);
        captured.push({view: view.image_name, kind: "reference", bytes: new Uint8Array(rgba)});
        return rgba;
      };
      viewer.pixels = kind => {
        const rgba = read(kind);
        captured.push({view: viewer.view!.image_name, kind, bytes: new Uint8Array(rgba)});
        return rgba;
      };
      let finished!: Promise<unknown>;
      quality.onclick = function (event) { finished = Promise.resolve(handler.call(this, event)); };
      quality.click(); await finished; quality.onclick = handler;
      viewer.reference = reference; viewer.pixels = read;
      const report = exportReport();
      const inputs = [];
      for (const {view, kind, bytes} of captured) inputs.push({view, kind, hash: hashHex(await sha256(bytes))});
      captured.length = 0;
      normal.push({scene, quality: report.quality, inputs, cameraRestored: viewer.view?.image_name === original});
      viewer.playing = false;
      for (const v of viewer.data!.views.filter(v => v.heldOut)) {
        viewer.setView(v); await viewer.settle();
        const rgba = viewer.pixels("gaussian"), hash = hashHex(await sha256(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)));
        const expected = prior.comparisons.find((x: {scene: string; mode: string; view: string; yaw: number}) => x.scene === scene && x.mode === "fileBytes" && x.view === v.image_name && x.yaw === 0);
        if (hash !== expected?.hash) throw new Error("Pixel mismatch");
        pixels.push({scene, view: v.image_name, hash, matchesOriginal: true});
      }
      viewer.playing = true;
    }
    output.textContent = JSON.stringify({createdAt: new Date().toISOString(), variant: baseline ? "baseline" : "fixed", baselineCommit: "d0bfb5b",
      method: "Real models and scores; hold animation callbacks, synthetic visibility. Observe for 80ms before releasing. Not native background throttling or cancellation latency measurement.", records, normal, pixels, errors}, null, 2);
  } catch (error) { output.textContent = `FAILED: ${error}\n${JSON.stringify({records, normal, pixels, errors}, null, 2)}`; }
  finally { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; reveal(); viewer.dispose(); }
};
