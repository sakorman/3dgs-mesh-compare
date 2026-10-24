import * as THREE from "three";
import { CompareViewer } from "../../src/viewer";
const baseline =
  new URLSearchParams(location.search).get("variant") === "baseline";
const path = "/.qa/resource-baseline.ts";
const Viewer = baseline
  ? (await import(/* @vite-ignore */ path)).CompareViewer
  : CompareViewer;
const viewer: CompareViewer = new Viewer(
  document.querySelector("#left")!,
  document.querySelector("#right")!,
);
const result = document.querySelector("#result")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [];
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
window.addEventListener("error", (e) => errors.push(e.message));
function bitmaps() {
  const images = new Set<ImageBitmap>();
  viewer.mesh!.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      for (const value of Object.values(material))
        if (
          value instanceof THREE.Texture &&
          value.source.data instanceof ImageBitmap
        )
          images.add(value.source.data);
  });
  return [...images];
}
async function hash(canvas: HTMLCanvasElement) {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0);
  const bytes = ctx.getImageData(0, 0, copy.width, copy.height).data;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
await viewer.load("pipes");
result.textContent = "Ready";
run.disabled = false;
run.onclick = async () => {
  run.disabled = true;
  const rows = [];
  try {
    const first = {
      gaussian: await hash(viewer.renderers.gaussian.domElement),
      mesh: await hash(viewer.renderers.mesh.domElement),
    };
    for (const scene of ["office", "pipes"]) {
      const old = bitmaps();
      const oldPixels = old.reduce((n, b) => n + b.width * b.height, 0);
      await viewer.load(scene);
      rows.push({
        nextScene: scene,
        oldBitmaps: old.length,
        decodedRgbaMiBEstimate: (oldPixels * 4) / 1024 / 1024,
        remainingOpen: old.filter((b) => b.width > 0 || b.height > 0).length,
        newBitmaps: bitmaps().length,
        activeBitmapsValid: bitmaps().every((b) => b.width > 0 && b.height > 0),
      });
      // Clean baseline evidence after measuring so this test itself retains no decoded images.
      if (baseline) old.forEach((b) => b.close());
    }
    const reloaded = {
      gaussian: await hash(viewer.renderers.gaussian.domElement),
      mesh: await hash(viewer.renderers.mesh.domElement),
    };
    const live = bitmaps();
    viewer.dispose();
    rows.push({
      action: "dispose",
      oldBitmaps: live.length,
      remainingOpen: live.filter((b) => b.width > 0 || b.height > 0).length,
    });
    if (baseline) live.forEach((b) => b.close());
    const pixelsMatch =
      first.gaussian === reloaded.gaussian && first.mesh === reloaded.mesh;
    result.textContent = JSON.stringify(
      {
        passed:
          rows.every((row) => row.remainingOpen === 0) &&
          pixelsMatch &&
          errors.length === 0,
        variant: baseline ? "baseline" : "candidate",
        viewport: [viewer.width, viewer.height],
        rows,
        first,
        reloaded,
        pixelsMatch,
        errors,
      },
      null,
      2,
    );
  } catch (error) {
    result.textContent = "FAILED: " + String(error);
    viewer.dispose();
  } finally {
    run.textContent = "Reload to rerun";
    run.onclick = () => location.reload();
    run.disabled = false;
  }
};
