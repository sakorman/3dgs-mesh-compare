import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
const baseline =
  new URLSearchParams(location.search).get("variant") === "baseline";
const path = "/.qa/timing-baseline.ts";
const Viewer = baseline
  ? (await import(/* @vite-ignore */ path)).CompareViewer
  : CompareViewer;
const viewer: CompareViewer = new Viewer(
  document.querySelector("#left")!,
  document.querySelector("#right")!,
);
const run = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
window.addEventListener("error", (e) => errors.push(e.message));
run.onclick = async () => {
  run.disabled = true;
  const rows = [];
  try {
    for (const [index, scene] of [
      "pipes",
      "pipes",
      "office",
      "office",
    ].entries()) {
      status.textContent = `Loading ${scene} (${index + 1}/4)`;
      const start = performance.now();
      await viewer.load(scene);
      const elapsedMs = performance.now() - start;
      const trace = viewer.loadTimings ?? null;
      viewer.playing = false;
      const captures = [];
      if (index % 2 === 1)
        for (const view of viewer.data!.views.filter((v) => v.heldOut)) {
          viewer.setView(view);
          await viewer.settle();
          const reference = await viewer.reference(view);
          for (const kind of ["gaussian", "mesh"] as const) {
            const pixels = viewer.pixels(kind);
            const hash = [
              ...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)),
            ]
              .map((x) => x.toString(16).padStart(2, "0"))
              .join("");
            captures.push({
              view: view.image_name,
              backend: kind,
              hash,
              quality: quality(pixels, reference, viewer.width, viewer.height),
            });
          }
        }
      rows.push({
        scene,
        sequence: index + 1,
        viewerReused: index > 0,
        httpCache: "uncontrolled",
        elapsedMs,
        trace,
        captures,
      });
    }
    viewer.clear();
    document.querySelector("#result")!.textContent = JSON.stringify(
      {
        variant: baseline ? "baseline" : "candidate",
        rows,
        clearedTrace:
          (viewer as CompareViewer & { loadTimings?: unknown }).loadTimings ??
          null,
        errors,
      },
      null,
      2,
    );
    status.textContent = "Complete";
  } catch (error) {
    status.textContent = "FAILED: " + String(error);
  } finally {
    viewer.dispose();
  }
};
window.addEventListener("pagehide", () => viewer.dispose(), { once: true });
