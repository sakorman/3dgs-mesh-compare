import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CompareViewer } from "../../src/viewer";
import { disposeMeshResources } from "../../src/mesh-resources";

const baseline =
  new URLSearchParams(location.search).get("variant") === "baseline";
const path = "/.qa/load-baseline.ts";
const Viewer: typeof CompareViewer = baseline
  ? (await import(/* @vite-ignore */ path)).CompareViewer
  : CompareViewer;
const result = document.querySelector<HTMLPreElement>("#result")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [];
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
window.addEventListener("error", (e) => errors.push(e.message));
const originalFetch = window.fetch;
const originalParse = GLTFLoader.prototype.parseAsync;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function observed<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error: String(error) }),
  );
}
function urlOf(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}
function bitmapList(root: THREE.Object3D) {
  const images = new Set<ImageBitmap>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(o.material)
      ? o.material
      : [o.material]) {
      for (const value of Object.values(material)) {
        if (
          value instanceof THREE.Texture &&
          value.source.data instanceof ImageBitmap
        )
          images.add(value.source.data);
      }
    }
  });
  return [...images];
}
function delayMetadata(
  ready: ReturnType<typeof gate>,
  resume: ReturnType<typeof gate>,
) {
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!urlOf(input).endsWith("/pipes/scene.json")) return response;
    const data = await response.json();
    const deferred = new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
    deferred.json = async () => {
      ready.release();
      await resume.promise;
      return data;
    };
    return deferred;
  };
}
button.onclick = async () => {
  button.disabled = true;
  errors.length = 0;
  const records: object[] = [];
  const run = async (
    name: string,
    check: (viewer: CompareViewer) => Promise<object>,
  ) => {
    result.textContent = `Running: ${name}`;
    document.querySelector("#left")!.replaceChildren();
    document.querySelector("#right")!.replaceChildren();
    const viewer = new Viewer(
      document.querySelector("#left")!,
      document.querySelector("#right")!,
    );
    try {
      records.push({ name, ...(await check(viewer)) });
    } finally {
      window.fetch = originalFetch;
      GLTFLoader.prototype.parseAsync = originalParse;
      viewer.dispose();
      Object.values(viewer.renderers).forEach((r) => r.forceContextLoss());
    }
  };
  try {
    await run("late metadata", async (viewer) => {
      const ready = gate(),
        resume = gate();
      delayMetadata(ready, resume);
      const stale = observed(viewer.load("pipes"));
      await ready.promise;
      try {
        await viewer.load("office");
        const current = {
          gaussian: viewer.gaussian,
          mesh: viewer.mesh,
          view: viewer.view,
          timings: viewer.loadTimings,
        };
        resume.release();
        await stale;
        const passed =
          viewer.data?.id === "office" &&
          viewer.view === current.view &&
          viewer.gaussian === current.gaussian &&
          viewer.mesh === current.mesh &&
          (baseline ||
            (viewer.loadTimings === current.timings &&
              viewer.loadTimings?.scene === "office"));
        return {
          passed,
          activeScene: viewer.data?.id,
          modelsPresent: !!viewer.gaussian && !!viewer.mesh,
        };
      } finally {
        resume.release();
        await stale;
      }
    });
    await run("late first-frame completion", async (viewer) => {
      const ready = gate(),
        resume = gate();
      const settle = viewer.settle.bind(viewer);
      let delayed = false;
      viewer.settle = async (signal) => {
        if (!delayed && viewer.data?.id === "pipes") {
          delayed = true;
          ready.release();
          await resume.promise;
        }
        return settle(signal);
      };
      const stale = observed(viewer.load("pipes"));
      await ready.promise;
      try {
        await viewer.load("office");
        const current = {
          gaussian: viewer.gaussian,
          mesh: viewer.mesh,
          timings: viewer.loadTimings,
        };
        resume.release();
        await stale;
        const passed =
          viewer.data?.id === "office" &&
          !!viewer.gaussian &&
          !!viewer.mesh &&
          viewer.gaussian === current.gaussian &&
          viewer.mesh === current.mesh &&
          (baseline ||
            (viewer.loadTimings === current.timings &&
              viewer.loadTimings?.scene === "office"));
        return {
          passed,
          activeScene: viewer.data?.id,
          modelsPresent: !!viewer.gaussian && !!viewer.mesh,
        };
      } finally {
        resume.release();
        await stale;
      }
    });
    await run("one model fails after the other parsed", async (viewer) => {
      const parsed = gate();
      let captured: THREE.Group | undefined;
      GLTFLoader.prototype.parseAsync = async function (data, path) {
        const gltf = await originalParse.call(this, data, path);
        captured = gltf.scene;
        parsed.release();
        return gltf;
      };
      window.fetch = async (input, init) => {
        if (urlOf(input).endsWith("/pipes/gaussians.ply.gz")) {
          await parsed.promise;
          throw new Error("Injected Gaussian download failure");
        }
        return originalFetch(input, init);
      };
      const failed = await observed(viewer.load("pipes"));
      const failedTraceAbsent = !viewer.loadTimings;
      await parsed.promise;
      await Promise.resolve();
      const images = bitmapList(captured!);
      const open = images.filter((image) => image.width > 0).length;
      // Close references kept for baseline inspection after counting them.
      if (open) disposeMeshResources(captured!);
      window.fetch = originalFetch;
      GLTFLoader.prototype.parseAsync = originalParse;
      await viewer.load("office");
      return {
        passed:
          failed.status === "rejected" &&
          images.length > 0 &&
          open === 0 &&
          failedTraceAbsent &&
          viewer.data?.id === "office",
        failedTraceAbsent,
        failed: failed.status,
        loadedBitmaps: images.length,
        remainingOpen: open,
        retryScene: viewer.data?.id,
      };
    });
    await run("disposed during metadata", async (viewer) => {
      const ready = gate(),
        resume = gate();
      delayMetadata(ready, resume);
      let lateCameraChanges = 0;
      const setView = viewer.setView.bind(viewer);
      viewer.setView = (view) => {
        if (viewer.disposed) lateCameraChanges++;
        setView(view);
      };
      const stale = observed(viewer.load("pipes"));
      await ready.promise;
      viewer.dispose();
      resume.release();
      await stale;
      return {
        passed: lateCameraChanges === 0 && !viewer.data && !viewer.loadTimings,
        disposedTraceAbsent: !viewer.loadTimings,
        lateCameraChanges,
        hasMetadataAfterDispose: !!viewer.data,
      };
    });
    result.textContent = JSON.stringify(
      { variant: baseline ? "baseline" : "candidate", records, errors },
      null,
      2,
    );
  } catch (error) {
    result.textContent = JSON.stringify(
      { failed: String(error), records, errors },
      null,
      2,
    );
  } finally {
    button.textContent = "Reload to rerun";
    button.onclick = () => location.reload();
    button.disabled = false;
  }
};
