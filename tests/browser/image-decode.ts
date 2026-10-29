import { CompareViewer } from "../../src/viewer";
import { hashHex, sha256 } from "../helpers/paired-model";

const params = new URLSearchParams(location.search);
const baseline = params.get("variant") === "baseline";
const scene = params.get("scene") ?? "pipes";
const output = document.querySelector("#qa-result")!;
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (ready: () => boolean) => {
  const end = performance.now() + 15000;
  while (!ready()) { if (performance.now() > end) throw new Error("Timed out"); await pause(20); }
};
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
let viewer!: CompareViewer;
const load = CompareViewer.prototype.load;
CompareViewer.prototype.load = function (id) { viewer = this; return load.call(this, id); };
const path = "/.qa/image-decode/main-before.ts";
if (baseline) {
  const referencePath = "/.qa/image-decode/reference-before.ts";
  CompareViewer.prototype.reference = (await import(/* @vite-ignore */ referencePath)).reference;
  await import(/* @vite-ignore */ path);
}
else await import("../../src/main");
if (scene !== "pipes") {
  document.querySelector<HTMLButtonElement>(`[data-scene="${scene}"]`)!.click();
  await waitUntil(() => !button("quality").disabled);
}
const view = document.querySelector<HTMLSelectElement>("#view")!;
view.value = "1"; view.dispatchEvent(new Event("change"));
run.disabled = false; output.textContent = `Ready: ${baseline ? "baseline" : "fixed"} / ${scene}`;

run.onclick = async () => {
  run.disabled = true;
  const records: object[] = [], inputs: object[] = [];
  let normal: unknown;
  const decode = HTMLImageElement.prototype.decode;
  const getImageData = CanvasRenderingContext2D.prototype.getImageData;
  const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
  const reveal = () => {
    if (hidden) Object.defineProperty(document, "hidden", hidden);
    else delete (document as {hidden?: boolean}).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const exportQuality = () => {
    button("export").click();
    const report = JSON.parse(document.querySelector<HTMLTextAreaElement>("#report-json")!.value);
    button("close-report").click(); return report.quality;
  };
  let release = () => {};
  try {
    for (const scenario of ["cancel", "resize", "hidden", "dispose"]) {
      output.textContent = `${scene}: ${scenario}`;
      let entered = false, interrupted = false, ended = false, lateReads = 0;
      let image: HTMLImageElement | undefined;
      const held = new Promise<void>(resolve => { release = resolve; });
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        image = this; entered = true; await held;
        if (scenario === "hidden") throw new DOMException("Late decoder failure", "EncodingError");
      };
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        if (interrupted) lateReads++;
        return getImageData.apply(this, args);
      };
      const quality = button("quality"), handler = quality.onclick!;
      let completed!: Promise<unknown>;
      quality.onclick = function (event) { completed = Promise.resolve(handler.call(this, event)).finally(() => { ended = true; }); };
      quality.click(); await waitUntil(() => entered); interrupted = true;
      if (scenario === "cancel") button("cancel").click();
      if (scenario === "resize") window.dispatchEvent(new Event("resize"));
      if (scenario === "hidden") {
        Object.defineProperty(document, "hidden", {configurable: true, get: () => true});
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (scenario === "dispose") window.dispatchEvent(new PageTransitionEvent("pagehide", {persisted: false}));
      await pause(80);
      const row = {scene, scenario, endedWithoutDecode: ended, sourceDetached: !image!.hasAttribute("src"),
        controlsUnlocked: !quality.disabled, disposed: viewer.disposed, lateReads,
        restoredCamera: viewer.disposed ? null : viewer.view?.image_name === viewer.data?.views[1].image_name,
        reportAbsent: document.querySelector("#gs-quality")!.textContent === "—" && document.querySelector<HTMLElement>("#quality-details")!.hidden,
        status: document.querySelector("#status")!.textContent};
      release(); await completed; reveal();
      Object.assign(row, {lateReadsAfterRelease: lateReads}); records.push(row);
      HTMLImageElement.prototype.decode = decode; CanvasRenderingContext2D.prototype.getImageData = getImageData; quality.onclick = handler;
      if (!viewer.disposed) Object.assign(row, {exportedQualityAbsent: exportQuality() === null});
      if (!baseline && (!row.endedWithoutDecode || !row.sourceDetached || lateReads || !row.reportAbsent || row.controlsUnlocked === row.disposed)) throw new Error(`Failed ${scenario}`);
      if (scenario === "hidden") {
        // Check actual scoring inputs after recovery without changing their image path.
        const ref = viewer.reference.bind(viewer), pixels = viewer.pixels.bind(viewer);
        const captured: {view: string; kind: string; bytes: Uint8Array}[] = [];
        viewer.reference = async (...args) => {
          const rgba = await ref(...args);
          captured.push({view: args[0].image_name, kind: "reference", bytes: new Uint8Array(rgba)}); return rgba;
        };
        viewer.pixels = kind => {
          const rgba = pixels(kind);
          captured.push({view: viewer.view!.image_name, kind, bytes: new Uint8Array(rgba)}); return rgba;
        };
        quality.onclick = function (event) { completed = Promise.resolve(handler.call(this, event)); };
        quality.click(); await completed; quality.onclick = handler;
        normal = exportQuality();
        for (const {view, kind, bytes} of captured) inputs.push({view, kind, hash: hashHex(await sha256(bytes))});
        viewer.reference = ref; viewer.pixels = pixels;
      }
    }
    output.textContent = JSON.stringify({createdAt: new Date().toISOString(), variant: baseline ? "baseline" : "fixed", scene,
      baselineCommit: "870afb8", method: "Hold decoded image completion; observe cancellation for 80ms before releasing, with a late rejection in hidden case. Not a network or cancellation latency benchmark.",
      records, inputs, normal, errors}, null, 2);
  } catch (error) { output.textContent = JSON.stringify({failed: String(error), records, inputs, normal, errors}, null, 2); }
  finally { release(); reveal(); HTMLImageElement.prototype.decode = decode; CanvasRenderingContext2D.prototype.getImageData = getImageData; viewer.dispose(); }
};
