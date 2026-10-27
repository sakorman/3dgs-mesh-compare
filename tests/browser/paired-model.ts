import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
import { PairedModelLoader, hashHex, sha256, type ModelFormat, type PairedSpec } from "../helpers/paired-model";

const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
const records: { model: SplatMesh; format: ModelFormat; disposed: number; published: number }[] = [];
function replace(model: SplatMesh) {
  if (viewer.gaussian) viewer.scenes.gaussian.remove(viewer.gaussian);
  viewer.gaussian = model; viewer.scenes.gaussian.add(model);
}
const driver = {
  fetch: (url: string, signal: AbortSignal) => url === "missing-sidecar" ? Promise.resolve(new Response(null, { status: 404 })) : fetch(url, { signal }),
  create(bytes: Uint8Array, format: ModelFormat) {
    const model = new SplatMesh({ fileBytes: bytes, fileType: format === "spz" ? SplatFileType.SPZ : SplatFileType.PLY,
      extSplats: true, enableLod: false, lod: false });
    records.push({ model, format, disposed: 0, published: 0 }); return model;
  },
  initialized: (model: SplatMesh): Promise<unknown> => model.initialized,
  attributes: (model: SplatMesh) => ({ count: model.numSplats, sh: model.extSplats!.getNumSh(), words: model.extSplats!.extArrays[0] }),
  prepare(model: SplatMesh) { model.extSplats!.textures[0].needsUpdate = true; model.maxSh = 3; model.updateGenerator(); },
  publish(model: SplatMesh) { replace(model); records.find(r => r.model === model)!.published++; },
  dispose(model: SplatMesh) {
    viewer.scenes.gaussian.remove(model);
    if (viewer.gaussian === model) viewer.gaussian = undefined;
    records.find(r => r.model === model)!.disposed++; model.dispose();
  },
};
let loader = new PairedModelLoader(driver);
let original: SplatMesh | undefined;
function release() { loader.dispose(); if (original) replace(original); original = undefined; viewer.clear(); }
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function lock(value: boolean) { document.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = value); }
async function setup(scene: string) {
  release(); loader = new PairedModelLoader(driver);
  await viewer.load(scene); viewer.playing = false; original = viewer.gaussian!;
}
async function manifest(scene: string): Promise<PairedSpec> {
  const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
  const a = prior.assets.find((x: { scene: string }) => x.scene === scene);
  return { count: a.count, spzUrl: `/.qa/spz-sh8/${scene}-sh8.spz`, spzSha256: a.spzSha256,
    alphaUrl: `/.qa/spz-alpha16/${scene}.ap16.bin`, alphaRawSha256: a.alphaRawSha256,
    plyUrl: `/.qa/${scene}-gaussians.bin`, plySha256: a.plySha256 };
}
const comparisons: unknown[] = [], cases: unknown[] = [];
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  lock(true); release(); records.length = 0; comparisons.length = cases.length = 0;
  document.querySelector("#gallery")!.replaceChildren();
  try {
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: loading baseline`;
      await setup(scene); const spec = await manifest(scene);
      for (const variant of ["original", "candidate", "fallback"]) {
        status.textContent = `${scene}: ${variant} image controls`;
        if (variant !== "original") {
          const result = await loader.load(variant === "fallback" ? { ...spec, alphaUrl: "missing-sidecar" } : spec);
          assert(result.format === (variant === "candidate" ? "spz" : "ply"), "Wrong load result");
          cases.push({ scene, variant, format: result.format, reason: result.fallbackReason ?? null });
        }
        assert(viewer.scenes.gaussian.children.filter(x => x instanceof SplatMesh).length === 1, "Overlapping models");
        for (const [index, view] of viewer.data!.views.filter(v => v.heldOut).entries()) {
          for (const yaw of index === 0 ? [0, -0.08, 0.08] : [0]) {
            viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
            const pixels = viewer.pixels("gaussian"), pixelHash = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
            const previous = prior.comparisons.find((x: { scene: string; variant: string; view: string; yaw: number }) =>
              x.scene === scene && x.variant === (variant === "candidate" ? "alpha16" : "original") && x.view === view.image_name && x.yaw === yaw);
            assert(pixelHash === previous?.hash, `Pixel mismatch: ${scene}/${variant}/${view.image_name}/${yaw}`);
            comparisons.push({ scene, variant, view: view.image_name, yaw, hash: pixelHash, matchesPrevious: true,
              quality: yaw === 0 ? quality(pixels, await viewer.reference(view), viewer.width, viewer.height) : null });
            if (index === 0 && yaw === 0) {
              const figure = document.createElement("figure"), caption = document.createElement("figcaption"), img = new Image();
              caption.textContent = `${scene} · ${variant}`; img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92);
              figure.append(caption, img); document.querySelector("#gallery")!.append(figure);
            }
          }
        }
      }
      // Exercise wrong-version SPZ and a real sidecar from the other scene.
      for (const [name, altered] of [
        ["wrong-SPZ-digest", { ...spec, spzSha256: "0".repeat(64) }],
        ["cross-scene-sidecar", { ...spec, alphaUrl: `/.qa/spz-alpha16/${scene === "pipes" ? "office" : "pipes"}.ap16.bin` }],
      ] as const) {
        const result = await loader.load(altered);
        assert(result.format === "ply", "Wrong fallback format");
        cases.push({ scene, name, format: result.format, reason: result.fallbackReason });
      }
      // Hold the delivery of a real initialization result until a newer model is visible.
      status.textContent = `${scene}: delayed initialization cancellation`;
      const entered = deferred(), gate = deferred();
      let delayed: SplatMesh | undefined;
      driver.initialized = async model => {
        if (!delayed) { delayed = model; entered.resolve(); await model.initialized; await gate.promise; }
        else await model.initialized;
      };
      const obsolete = loader.load(spec).then(() => "published", error => error.name);
      await entered.promise;
      const current = await loader.load(spec);
      assert(records.find(r => r.model === delayed)!.disposed === 0, "Disposed before initialization settled");
      gate.resolve(); assert(await obsolete === "AbortError", "Cancelled load succeeded");
      driver.initialized = model => model.initialized;
      assert(viewer.gaussian === current.model, "Late result replaced current model");
      const late = records.find(r => r.model === delayed)!;
      assert(late.disposed === 1 && late.published === 0, "Late model leaked or published");
      await viewer.settle();
      cases.push({ scene, name: "late-initialize", disposed: late.disposed, published: late.published,
        visibleModels: viewer.scenes.gaussian.children.filter(x => x instanceof SplatMesh).length });
      release();
    }
    assert(records.every(r => r.disposed === 1), "Leaked or double-disposed model");
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify({ createdAt: new Date().toISOString(), baselineCommit: "ca44e88", spark: "2.4.0",
      resolution: 768, maxSh: 3, lod: false, method: "Correctness only; real local files, pinned prior manifest. Delayed initialization delivery injected for cancellation. No latency/cache/memory benchmark.",
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) },
      cases, comparisons, resources: records.map(({ format, disposed, published }) => ({ format, disposed, published })), errors }, null, 2);
    status.textContent = `Complete; controls=${comparisons.length}; cases=${cases.length}; disposed=${records.length}; errors=${errors.length}`;
  } catch (error) { status.textContent = `FAILED: ${error}`; }
  finally { driver.initialized = model => model.initialized; release(); lock(false); }
};
document.querySelector<HTMLButtonElement>("#show")!.onclick = async () => {
  lock(true);
  try {
    const scene = document.querySelector<HTMLSelectElement>("#scene")!.value;
    const variant = document.querySelector<HTMLSelectElement>("#variant")!.value;
    await setup(scene); const spec = await manifest(scene);
    await loader.load(variant === "fallback" ? { ...spec, alphaUrl: "missing-sidecar" } : spec);
    await viewer.settle(); viewer.playing = true;
    status.textContent = `Viewing ${scene}: ${variant}; models=${viewer.scenes.gaussian.children.filter(x => x instanceof SplatMesh).length}`;
  } catch (error) { release(); status.textContent = `FAILED: ${error}`; }
  finally { lock(false); }
};
document.querySelector<HTMLButtonElement>("#orbit")!.onclick = () => viewer.orbit(true);
document.querySelector<HTMLButtonElement>("#reset")!.onclick = () => viewer.orbit(false);
window.addEventListener("pagehide", () => { release(); viewer.dispose(); }, { once: true });
