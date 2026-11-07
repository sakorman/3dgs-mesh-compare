import * as THREE from "three";
import {CompareViewer} from "../../src/viewer";

const status = document.querySelector("#status")!;
const result = document.querySelector("#result")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

function memory() {
  const p = performance as Performance & {memory?: {usedJSHeapSize:number; totalJSHeapSize:number; jsHeapSizeLimit:number}};
  return p.memory ? {usedJSHeapSize:p.memory.usedJSHeapSize, totalJSHeapSize:p.memory.totalJSHeapSize, jsHeapSizeLimit:p.memory.jsHeapSizeLimit} : null;
}

function images(viewer: CompareViewer) {
  const seen = new Set<ImageBitmap>();
  viewer.mesh?.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && value.source.data instanceof ImageBitmap) seen.add(value.source.data);
      }
    }
  });
  return {count: seen.size, open: [...seen].filter(image => image.width > 0 || image.height > 0).length};
}

function bytes(viewer: CompareViewer) {
  const ext = viewer.gaussian?.extSplats;
  return ext ? [...ext.extArrays, ext.extra.sh1!, ext.extra.sh2!, ext.extra.sh3a!, ext.extra.sh3b!]
    .reduce((sum, array) => sum + array.byteLength, 0) : 0;
}

function resources(viewer: CompareViewer) {
  return {
    gaussianAttributeBytes: bytes(viewer),
    meshImages: images(viewer),
    gaussianMemory: {...viewer.renderers.gaussian.info.memory},
    meshMemory: {...viewer.renderers.mesh.info.memory},
    jsHeap: memory(),
  };
}

async function pixels(viewer: CompareViewer, kind: "gaussian" | "mesh") {
  const data = viewer.pixels(kind);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map(x => x.toString(16).padStart(2, "0")).join("");
}

const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const baseline = resources(viewer);
await viewer.load("pipes");
status.textContent = "Ready";
run.disabled = false;
run.onclick = async () => {
  run.disabled = true;
  try {
    const rows: {stage:string; resources:ReturnType<typeof resources>}[] = [{stage:"renderer-baseline", resources:baseline}];
    const firstPixels = {gaussian: await pixels(viewer, "gaussian"), mesh: await pixels(viewer, "mesh")};
    rows.push({stage: "pipes-loaded", resources: resources(viewer)});
    await viewer.load("office");
    rows.push({stage: "office-loaded-after-pipes", resources: resources(viewer)});
    await viewer.load("pipes");
    const secondPixels = {gaussian: await pixels(viewer, "gaussian"), mesh: await pixels(viewer, "mesh")};
    rows.push({stage: "pipes-reloaded-after-office", resources: resources(viewer)});
    viewer.dispose();
    rows.push({stage: "viewer-disposed", resources: resources(viewer)});
    result.textContent = JSON.stringify({
      passed: firstPixels.gaussian === secondPixels.gaussian && firstPixels.mesh === secondPixels.mesh &&
        rows[1].resources.meshImages.open > 0 && rows[4].resources.meshImages.open === 0 &&
        rows[4].resources.gaussianAttributeBytes === 0 && errors.length === 0,
      rendererMemoryReturnedToBaseline:
        JSON.stringify(rows[0].resources.gaussianMemory) === JSON.stringify(rows[4].resources.gaussianMemory) &&
        JSON.stringify(rows[0].resources.meshMemory) === JSON.stringify(rows[4].resources.meshMemory),
      browser: {userAgent: navigator.userAgent, gpu: (() => {
        const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
        return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      })()}, rows, firstPixels, secondPixels, errors,
      limitations: ["renderer.info.memory counts Three.js-managed resources, not total browser or driver memory", "performance.memory is optional and its values are not forced through garbage collection", "WASM worker pools and GPU driver allocations are not reported"],
    }, null, 2);
    status.textContent = "Complete";
  } catch (error) {
    result.textContent = "FAILED: " + String(error);
    status.textContent = "FAILED";
    viewer.dispose();
  }
};
