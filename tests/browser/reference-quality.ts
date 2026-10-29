import { CompareViewer, nextFrame } from "../../src/viewer";
import { quality } from "../../src/metrics";
import { read, keep, diff } from "../helpers/reference-pixels";

const scene = new URLSearchParams(location.search).get("scene") ?? "pipes";
const output = document.querySelector("#qa-result")!;
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
let viewer!: CompareViewer;
const load = CompareViewer.prototype.load;
CompareViewer.prototype.load = function (id) { viewer = this; return load.call(this, id); };
await import("../../src/main");
if (scene !== "pipes") {
  document.querySelector<HTMLButtonElement>(`[data-scene="${scene}"]`)!.click();
  const limit = performance.now() + 60000;
  while (document.querySelector<HTMLButtonElement>("#quality")!.disabled) {
    if (performance.now() > limit) throw new Error("Scene did not load");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
run.disabled = false; output.textContent = `Ready: ${scene}`;
run.onclick = async () => {
  run.disabled = true; viewer.playing = false;
  const records: object[] = [], nativeDecode = HTMLImageElement.prototype.decode;
  let lastImage: HTMLImageElement | undefined;
  HTMLImageElement.prototype.decode = async function () { await nativeDecode.call(this); lastImage = this; };
  try {
    for (let repeat = 0; repeat < 2; repeat++) for (const view of viewer.data!.views.filter(v => v.heldOut)) {
      output.textContent = `${scene} ${view.image_name} / ${repeat}`;
      viewer.setView(view); await viewer.settle();
      // Read the unchanged production path before additional diagnostic draws.
      const target = await viewer.reference(view);
      const image = lastImage!;
      const natural = read(image, image.naturalWidth, image.naturalHeight, false);
      const cpuNatural = read(image, image.naturalWidth, image.naturalHeight, true);
      const cpuScaled = read(image, viewer.width, viewer.height, true);
      const again = read(image, viewer.width, viewer.height, false);
      const results: object[] = [];
      for (const kind of ["gaussian", "mesh"] as const) {
        const pixels = viewer.pixels(kind);
        results.push({kind, hash: await keep(pixels, kind), production: quality(pixels, target, viewer.width, viewer.height),
          readFrequently: quality(pixels, cpuScaled.data, viewer.width, viewer.height)});
        await nextFrame();
      }
      records.push({repeat, scene, view: view.image_name, sourceSha256: view.sha256, width: viewer.width, height: viewer.height,
        productionHash: await keep(target, "production"), naturalHash: await keep(natural.data, "natural"),
        readFrequentlyNaturalHash: await keep(cpuNatural.data, "natural-read-frequently"),
        readFrequentlyHash: await keep(cpuScaled.data, "scaled-read-frequently"), afterDiagnosticsHash: await keep(again.data, "after-diagnostics"),
        naturalDifference: diff(natural.data, cpuNatural.data), scaledDifference: diff(target, cpuScaled.data), results});
    }
    output.textContent = JSON.stringify({createdAt: new Date().toISOString(), baseline: "0344969", scene, userAgent: navigator.userAgent,
      method: "Unmodified production reference read first; reuse the same decoded image for natural-size and readFrequently diagnostics. Same rendered pixels scored against both references; full SH3, no LoD, DPR1, serial rendering. No timing comparison.", records, errors}, null, 2);
  } catch (error) { output.textContent = JSON.stringify({failed: String(error), records, errors}, null, 2); }
  finally { HTMLImageElement.prototype.decode = nativeDecode; viewer.dispose(); }
};
