import * as THREE from "three";
import {CompareViewer} from "../../src/viewer";
import {attributeStorage, retainModelResources} from "../helpers/lifecycle-resources";

const status = document.querySelector("#status")!;
const result = document.querySelector("#result")!;
const summary = document.querySelector("#summary")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

function memory() {
  const p = performance as Performance & {memory?: {usedJSHeapSize:number; totalJSHeapSize:number; jsHeapSizeLimit:number}};
  return p.memory ? {usedJSHeapSize:p.memory.usedJSHeapSize, totalJSHeapSize:p.memory.totalJSHeapSize, jsHeapSizeLimit:p.memory.jsHeapSizeLimit} : null;
}

function resources(viewer: CompareViewer) {
  const bitmaps = new Set<ImageBitmap>();
  viewer.mesh?.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && value.source.data instanceof ImageBitmap) bitmaps.add(value.source.data);
      }
    }
  });
  return {
    activeAttributes: attributeStorage(viewer.gaussian?.extSplats),
    activeMeshImages: {count:bitmaps.size, open:[...bitmaps].filter(image => image.width > 0 || image.height > 0).length},
    gaussianMemory: {...viewer.renderers.gaussian.info.memory}, meshMemory: {...viewer.renderers.mesh.info.memory},
    jsHeap: memory(),
  };
}

async function pixels(viewer: CompareViewer) {
  async function hash(kind: "gaussian" | "mesh") {
    const data = viewer.pixels(kind);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map(x => x.toString(16).padStart(2, "0")).join("");
  }
  return {gaussian:await hash("gaussian"), mesh:await hash("mesh")};
}

const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
const browser = {userAgent:navigator.userAgent, gpu:debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), backend:"WebGL2"};
const baseline = resources(viewer);
try {
  await viewer.load("pipes");
  viewer.playing = false;
  status.textContent = "Ready";
  run.disabled = false;
} catch (error) {
  status.textContent = "FAILED";
  result.textContent = String(error);
  viewer.dispose();
}
run.onclick = async () => {
  run.disabled = true;
  const startedAt = new Date().toISOString(), started = performance.now();
  const visibility = [document.visibilityState];
  const onVisibility = () => visibility.push(document.visibilityState);
  document.addEventListener("visibilitychange", onVisibility);
  try {
    status.textContent = "Running";
    const rows = [{stage:"renderer-baseline", resources:baseline}];
    const firstPixels = await pixels(viewer);
    rows.push({stage:"pipes-loaded", resources:resources(viewer)});
    const retained = [retainModelResources(viewer.gaussian!, viewer.mesh!)];
    await viewer.load("office");
    viewer.playing = false;
    const releases = [{stage:"pipes-replaced", ...retained[0].inspect()}];
    const officePixels = await pixels(viewer);
    rows.push({stage:"office-loaded-after-pipes", resources:resources(viewer)});
    retained.push(retainModelResources(viewer.gaussian!, viewer.mesh!));
    await viewer.load("pipes");
    viewer.playing = false;
    releases.push({stage:"office-replaced", ...retained[1].inspect()});
    const secondPixels = await pixels(viewer);
    rows.push({stage:"pipes-reloaded-after-office", resources:resources(viewer)});
    retained.push(retainModelResources(viewer.gaussian!, viewer.mesh!));
    viewer.dispose();
    releases.push({stage:"pipes-disposed", ...retained[2].inspect()});
    rows.push({stage:"viewer-disposed", resources:resources(viewer)});
    const pixelEqual = firstPixels.gaussian === secondPixels.gaussian && firstPixels.mesh === secondPixels.mesh;
    const passed = pixelEqual && releases.every(row => row.passed) && errors.length === 0 && visibility.every(state => state === "visible");
    result.textContent = JSON.stringify({
      protocol:2, startedAt, sceneOrder:["pipes","office","pipes"],
      passed, pixelEqual, browser, viewport:[viewer.width,viewer.height], visibility,
      probeWallMs:performance.now()-started,
      rendererMemoryReturnedToBaseline:
        JSON.stringify(rows[0].resources.gaussianMemory) === JSON.stringify(rows[4].resources.gaussianMemory) &&
        JSON.stringify(rows[0].resources.meshMemory) === JSON.stringify(rows[4].resources.meshMemory),
      rows, releases, firstPixels, officePixels, secondPixels, errors,
      limitations:[
        "Retained old objects prove field clearing, bitmap closure and dispose events, not GC or driver reclamation",
        "Owned Mesh texture Source.data is cleared after dispose; this does not prove browser image or GPU reclamation",
        "Array view bytes and unique backing capacity describe attributes only; renderer.info counts are not total memory",
        "performance.memory is optional; no forced GC; retained probe objects affect heap values",
        "Worker pools, WASM capacity and GPU driver allocations are not measured",
        "Pixel equality covers initial/reloaded pipes first held-out view only; office hashes are observational",
        "Wall time includes diagnostic hashing and UI idle; it is not loading, rendering or training time",
      ],
    }, null, 2);
    summary.textContent = (passed ? "通过" : "未通过") + " · " + releases.length + " 组旧模型 · " +
      releases.reduce((sum,row) => sum+row.initial.meshBitmaps,0) + " 个旧 ImageBitmap 已检查 · pipes 回载画面" + (pixelEqual ? "一致" : "有差异");
    status.textContent = "Complete";
  } catch (error) {
    result.textContent = "FAILED: " + String(error);
    status.textContent = "FAILED";
    viewer.dispose();
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
  }
};
