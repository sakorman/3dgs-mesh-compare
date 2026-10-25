import type { CompareViewer } from "../../src/viewer";
import { nextFrame } from "../../src/viewer";
import { benchmark } from "../../src/benchmark";
import { quality } from "../../src/metrics";
import type { Backend } from "../../src/types";

const status = document.querySelector("#status")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const orbit = document.querySelector<HTMLButtonElement>("#orbit")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;
const left = document.querySelector<HTMLElement>("#left")!;
const right = document.querySelector<HTMLElement>("#right")!;
const errors: string[] = [];
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
window.addEventListener("error", (e) => errors.push(e.message));
let viewer: CompareViewer | undefined;
let orbitEnabled = false;
const variants = ["preserved", "discarded", "discarded", "preserved"] as const;

async function open(scene: string, variant: (typeof variants)[number]) {
  if (viewer) {
    viewer.dispose();
    Object.values(viewer.renderers).forEach((r) => r.forceContextLoss());
    left.replaceChildren();
    right.replaceChildren();
    await nextFrame();
  }
  const path = `/.qa/drawing-buffer-${variant}.ts`;
  const Viewer = (await import(/* @vite-ignore */ path)).CompareViewer;
  const created = new Viewer(left, right) as CompareViewer;
  viewer = created;
  created.onError = (message) => {
    if (!created.disposed) errors.push(message);
  };
  await viewer.load(scene);
  return viewer;
}
async function hash(bytes: Uint8ClampedArray) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
function environment(current: CompareViewer) {
  const gl = current.renderers.gaussian.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    userAgent: navigator.userAgent,
    gpu: debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
    attributes: gl.getContextAttributes(),
    gpuTimer: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"),
  };
}
run.onclick = async () => {
  run.disabled = true;
  const rows = [];
  try {
    for (const scene of ["pipes", "office"]) {
      for (let pass = 0; pass < variants.length; pass++) {
        const variant = variants[pass];
        status.textContent = `${scene} / ${variant} / ${pass + 1}: loading`;
        const current = await open(scene, variant);
        const data = current.data!;
        const views = data.views.filter((v) => v.heldOut);
        const performance = await benchmark(
          current,
          new AbortController().signal,
          (text) => {
            status.textContent = `${scene} / ${variant} / ${pass + 1}: ${text}`;
          },
        );
        current.playing = false;
        const captures = [];
        // Quality once per variant, after timing so readback cannot skew timing.
        if (pass < 2) {
          for (const view of views) {
            current.setView(view);
            await current.settle();
            const reference = await current.reference(view);
            for (const backend of ["gaussian", "mesh"] as Backend[]) {
              const pixels = current.pixels(backend);
              captures.push({
                view: view.image_name,
                backend,
                hash: await hash(pixels),
                quality: quality(
                  reference,
                  pixels,
                  current.width,
                  current.height,
                ),
              });
            }
          }
        }
        rows.push({
          scene,
          variant,
          pass: pass + 1,
          environment: environment(current),
          gaussianCount: data.gaussian.count,
          sh: current.gaussian!.maxSh,
          lod: false,
          camera: views[0].image_name,
          performance,
          captures,
        });
        document.querySelector("#result")!.textContent = JSON.stringify(
          { rows, errors },
          null,
          2,
        );
        document.querySelector("#summary")!.textContent = JSON.stringify(
          rows.map((row) => ({
            scene: row.scene,
            variant: row.variant,
            pass: row.pass,
            gaussian: { ...row.performance.gaussian, samples: undefined },
            mesh: { ...row.performance.mesh, samples: undefined },
          })),
          null,
          2,
        );
      }
    }
    const current = await open("pipes", "discarded");
    current.playing = false;
    const gallery = document.querySelector("#captures")!;
    for (const backend of ["gaussian", "mesh"] as Backend[]) {
      const canvas = document.createElement("canvas");
      canvas.width = current.width;
      canvas.height = current.height;
      canvas
        .getContext("2d")!
        .putImageData(
          new ImageData(current.pixels(backend), current.width, current.height),
          0,
          0,
        );
      const img = new Image();
      img.src = canvas.toDataURL();
      img.alt = `${backend} fresh capture`;
      gallery.append(img);
    }
    current.playing = true;
    orbit.disabled = reset.disabled = false;
    status.textContent = `Complete. Candidate idle preview; errors=${errors.length}`;
  } catch (error) {
    errors.push(String(error));
    status.textContent = "FAILED: " + String(error);
    document.querySelector("#result")!.textContent = JSON.stringify(
      { rows, errors },
      null,
      2,
    );
    viewer?.dispose();
  }
};
orbit.onclick = () => {
  viewer?.orbit((orbitEnabled = !orbitEnabled));
  status.textContent = orbitEnabled
    ? "Candidate orbit enabled"
    : "Candidate calibrated view";
};
reset.onclick = () => {
  orbitEnabled = false;
  viewer?.orbit(false);
  status.textContent = "Candidate reset to photo";
};
window.addEventListener("pagehide", () => viewer?.dispose(), { once: true });
