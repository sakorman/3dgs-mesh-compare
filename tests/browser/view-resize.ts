import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
import type { Backend } from "../../src/types";
const baseline =
  new URLSearchParams(location.search).get("variant") === "baseline";
const path = "/.qa/resize-baseline.ts";
const Viewer = baseline
  ? (await import(/* @vite-ignore */ path)).CompareViewer
  : CompareViewer;
const viewer: CompareViewer = new Viewer(
  document.querySelector("#left")!,
  document.querySelector("#right")!,
);
const backends: Backend[] = ["gaussian", "mesh"];
const calls = { gaussian: 0, mesh: 0 };
for (const kind of backends) {
  const renderer = viewer.renderers[kind];
  const setSize = renderer.setSize.bind(renderer);
  renderer.setSize = (...args) => {
    calls[kind]++;
    return setSize(...args);
  };
}
const resetCalls = () => {
  calls.gaussian = calls.mesh = 0;
};
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
const status = document.querySelector("#status")!;
const output = document.querySelector("#result")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const orbit = document.querySelector<HTMLButtonElement>("#orbit")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;
const hash = async (bytes: Uint8ClampedArray) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
function retainedPixels(kind: Backend) {
  const canvas = document.createElement("canvas");
  canvas.width = viewer.width;
  canvas.height = viewer.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(viewer.renderers[kind].domElement, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}
async function capture(withQuality: boolean) {
  const reference = withQuality
    ? await viewer.reference(viewer.view!)
    : undefined;
  const images = [];
  for (const kind of backends) {
    const pixels = viewer.pixels(kind);
    const canvas = viewer.renderers[kind].domElement;
    images.push({
      backend: kind,
      size: [canvas.width, canvas.height],
      hash: await hash(pixels),
      quality: reference
        ? quality(pixels, reference, viewer.width, viewer.height)
        : undefined,
    });
  }
  return images;
}
run.onclick = async () => {
  run.disabled = true;
  const scenes = [];
  try {
    for (const scene of ["pipes", "office"]) {
      status.textContent = `Loading ${scene}`;
      resetCalls();
      await viewer.load(scene);
      const loadResizeCalls = { ...calls };
      viewer.playing = false;
      const before = {
        gaussian: await hash(viewer.pixels("gaussian")),
        mesh: await hash(viewer.pixels("mesh")),
      };
      resetCalls();
      viewer.setSize(viewer.width);
      const sameSizeCalls = { ...calls };
      const after = {
        gaussian: await hash(retainedPixels("gaussian")),
        mesh: await hash(retainedPixels("mesh")),
      };
      const sameSizeRetainsPixels =
        before.gaussian === after.gaussian && before.mesh === after.mesh;
      const views = [];
      for (const view of viewer.data!.views.filter((v) => v.heldOut)) {
        status.textContent = `${scene}: ${view.image_name}`;
        resetCalls();
        // The photo selector applies the view, then leaves orbit mode.
        viewer.setView(view);
        viewer.orbit(false);
        const resizeCalls = { ...calls };
        await viewer.settle();
        views.push({
          view: view.image_name,
          resizeCalls,
          images: await capture(true),
        });
      }
      const resolutions = [];
      for (const width of [512, 1024, 768]) {
        resetCalls();
        viewer.setSize(width);
        const resizeCalls = { ...calls };
        await viewer.settle();
        resolutions.push({ width, resizeCalls, images: await capture(false) });
      }
      scenes.push({
        scene,
        loadResizeCalls,
        sameSizeCalls,
        sameSizeRetainsPixels,
        before,
        after,
        views,
        resolutions,
      });
    }
    const gl = viewer.renderers.gaussian.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    output.textContent = JSON.stringify(
      {
        variant: baseline ? "baseline" : "candidate",
        scenes,
        errors,
        environment: {
          userAgent: navigator.userAgent,
          gpu: debug
            ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
        },
        passed:
          scenes.every(
            (s) =>
              s.sameSizeRetainsPixels &&
              backends.every((k) => s.sameSizeCalls[k] === 0) &&
              s.views.every((v) =>
                backends.every((k) => v.resizeCalls[k] === 0),
              ) &&
              s.resolutions.every(
                (r) =>
                  backends.every((k) => r.resizeCalls[k] === 1) &&
                  r.images.every((i) => i.size[0] === r.width),
              ),
          ) && !errors.length,
      },
      null,
      2,
    );
    viewer.setView(viewer.data!.views.find((v) => v.heldOut)!);
    await viewer.settle();
    viewer.playing = true;
    orbit.disabled = reset.disabled = false;
    status.textContent = `Complete; ${baseline ? "baseline" : "candidate"}; errors=${errors.length}`;
  } catch (error) {
    status.textContent = "FAILED: " + String(error);
    viewer.dispose();
  }
};
let orbitEnabled = false;
orbit.onclick = () => {
  viewer.orbit((orbitEnabled = !orbitEnabled));
  status.textContent = `Orbit ${orbitEnabled}`;
};
reset.onclick = () => {
  viewer.orbit(false);
  orbitEnabled = false;
  status.textContent = "Photo reset";
};
window.addEventListener("pagehide", () => viewer.dispose(), { once: true });
