import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
import { PairedModelLoader, elapsedModelPhases, hashHex, sha256, type PairedSpec, type ModelFormat } from "../helpers/paired-model";
import type { HttpRecord } from "../helpers/http-model-fixture";

const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const status = document.querySelector("#status")!, button = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
const resources: { model: SplatMesh; format: ModelFormat; disposed: number }[] = [];
let original: SplatMesh | undefined;
function replace(model: SplatMesh) {
  if (viewer.gaussian) viewer.scenes.gaussian.remove(viewer.gaussian);
  viewer.gaussian = model; viewer.scenes.gaussian.add(model);
}
const driver = {
  fetch: (url: string, signal: AbortSignal) => fetch(url, { signal }),
  create(bytes: Uint8Array, format: ModelFormat) {
    const model = new SplatMesh({ fileBytes: bytes, fileType: format === "ply" ? SplatFileType.PLY : SplatFileType.SPZ,
      extSplats: true, enableLod: false, lod: false });
    resources.push({ model, format, disposed: 0 }); return model;
  },
  initialized: (model: SplatMesh) => model.initialized,
  attributes: (model: SplatMesh) => ({ count: model.numSplats, sh: model.extSplats!.getNumSh(), words: model.extSplats!.extArrays[0] }),
  prepare(model: SplatMesh) { model.extSplats!.textures[0].needsUpdate = true; model.maxSh = 3; model.updateGenerator(); },
  publish: replace,
  dispose(model: SplatMesh) {
    viewer.scenes.gaussian.remove(model); if (viewer.gaussian === model) viewer.gaussian = undefined;
    resources.find(r => r.model === model)!.disposed++; model.dispose();
  },
};
let loader = new PairedModelLoader(driver);
function clearCandidate() { loader.clear(); if (original) replace(original); }
function release() { loader.dispose(); if (original) replace(original); original = undefined; viewer.clear(); }
button.onclick = async () => {
  button.disabled = true; release(); resources.length = 0; errors.length = 0;
  document.querySelector("#rows")!.replaceChildren(); document.querySelector("#gallery")!.replaceChildren();
  const run = crypto.randomUUID(), samples: unknown[] = [], warmups: unknown[] = [], comparisons: unknown[] = [];
  const visibility: { ms: number; state: string }[] = [];
  const recordVisibility = () => visibility.push({ ms: performance.now(), state: document.visibilityState });
  document.addEventListener("visibilitychange", recordVisibility); recordVisibility();
  const logs = async (): Promise<HttpRecord[]> => (await fetch(`/__model_http/${run}/records`, { cache: "no-store" })).json();
  try {
    assert(!document.hidden, "Visible document required for timing");
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: runtime warm-up`;
      release(); loader = new PairedModelLoader(driver);
      await viewer.load(scene); viewer.playing = false; original = viewer.gaussian!;
      const a = prior.assets.find((x: { scene: string }) => x.scene === scene);
      const views = viewer.data!.views.filter(v => v.heldOut);
      const specFor = (sample: string): PairedSpec => {
        const url = (kind: string, digest: string) => `/__model_http/${run}/paced/${scene}/${kind}?sha256=${digest}&sample=${sample}`;
        return { count: a.count, spzSha256: a.spzSha256, alphaRawSha256: a.alphaRawSha256, plySha256: a.plySha256,
          spzUrl: url("spz", a.spzSha256), alphaUrl: url("alpha", a.alphaRawSha256), plyUrl: url("ply", a.plySha256) };
      };
      async function capture(name: string, format: ModelFormat, all: boolean) {
        for (const [index, view] of (all ? views : views.slice(0, 1)).entries()) {
          for (const yaw of all && index === 0 ? [0, -0.08, 0.08] : [0]) {
            viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
            const pixels = viewer.pixels("gaussian");
            const pixelHash = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
            const expected = prior.comparisons.find((x: { scene: string; variant: string; view: string; yaw: number }) =>
              x.scene === scene && x.variant === (format === "ply" ? "original" : "alpha16") && x.view === view.image_name && x.yaw === yaw);
            assert(expected?.hash === pixelHash, `Pixel mismatch ${scene}/${name}/${view.image_name}/${yaw}`);
            comparisons.push({ scene, name, format, view: view.image_name, yaw, hash: pixelHash, matchesPrevious: true,
              quality: all && yaw === 0 ? quality(pixels, await viewer.reference(view), viewer.width, viewer.height) : null });
            if (all && index === 0 && yaw === 0) {
              const figure = document.createElement("figure"), img = new Image(), label = document.createElement("figcaption");
              label.textContent = `${scene} · ${format === "ply" ? "原始 PLY" : "SH8 + AP16"}`;
              img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92);
              figure.append(label, img); document.querySelector("#gallery")!.append(figure);
            }
          }
        }
      }
      // Prime exact cache keys and both parsers outside measured trials.
      for (const format of ["ply", "spz"] as const) {
        clearCandidate(); viewer.setView(views[0]); await viewer.settle();
        const before = (await logs()).length;
        const loaded = await loader.load(specFor("warm"), format);
        assert(loaded.format === format && !loaded.fallbackReason, "Warm-up fallback");
        await viewer.settle();
        warmups.push({ scene, format, network: (await logs()).slice(before) });
        await capture("warm-up", format, true);
      }
      for (const cache of ["cold-key", "warm-key"]) {
        const order: ModelFormat[] = ["ply", "spz", "spz", "ply", "ply", "spz", "spz", "ply"];
        for (const [index, format] of order.entries()) {
          status.textContent = `${scene}: ${cache} ${index + 1}/8 ${format}`;
          clearCandidate(); viewer.setView(views[0]); await viewer.settle();
          const before = (await logs()).length, visibilityStart = visibility.length;
          const spec = specFor(cache === "warm-key" ? "warm" : `cold-${index}`);
          assert(!document.hidden, "Document hidden before trial");
          const start = performance.now();
          const result = await loader.load(spec, format);
          const loadMs = performance.now() - start;
          assert(result.format === format && !result.fallbackReason, "Unexpected fallback");
          const settleStart = performance.now(); await viewer.settle();
          const totalMs = performance.now() - start, settleMs = performance.now() - settleStart;
          assert(!document.hidden && visibility.length === visibilityStart, "Visibility changed during trial");
          const network = (await logs()).slice(before);
          const bytes = network.reduce((sum, row) => sum + row.bodyBytesOffered, 0);
          assert(network.every(row => row.finished && row.closed && row.status === 200), "Incomplete HTTP response");
          if (cache === "warm-key") assert(network.length === 0, "Expected browser HTTP cache hit");
          else {
            assert(network.length === (format === "ply" ? 1 : 2), "Unexpected request count");
            assert(bytes === (format === "ply" ? a.plyGzipBytes : a.combinedBytes), "HTTP byte mismatch");
            assert(network.every(row => row.pacing && row.pacing.lastChunkMs! >= row.pacing.idealMs), "Pacing budget violated");
          }
          assert(viewer.scenes.gaussian.children.filter(x => x instanceof SplatMesh).length === 1, "Overlapping models");
          samples.push({ scene, cache, index, format, loadMs, settleMs, totalMs, phases: result.phases,
            otherLoadMs: loadMs - elapsedModelPhases(result.phases), network, bodyBytesOffered: bytes });
          const row = document.createElement("tr");
          for (const value of [scene, cache, format, loadMs.toFixed(2), settleMs.toFixed(2), totalMs.toFixed(2), bytes]) {
            const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell);
          }
          document.querySelector("#rows")!.append(row);
          await capture(`${cache}-${index}`, format, false);
        }
      }
      release();
    }
    assert(errors.length === 0 && resources.every(r => r.disposed === 1), "Errors or unbalanced resources");
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify({ createdAt: new Date().toISOString(), run, baselineCommit: "55905ad",
      spark: "2.4.0", resolution: 768, maxSh: 3, lod: false,
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), visibility },
      method: "Serial ABBAABBA, four samples per format/cache/scene. Real HTTP body paced at 5 MiB/s, 64 KiB chunks, 40ms server hold per request (not RTT). Cold-key is an unused HTTP cache key, with warm renderer/WASM; warm-key reuses exact primed URL. New model every trial. Baseline model retained and displayed while loading, removed on publish. All formats use digest validation. Total ends after four quiet sort frames and mesh draw submission; not GPU time or screen presentation. Excludes page/mesh/runtime startup, baseline restoration, controls, captures and quality scoring. No memory, training, FPS or CDN measurement.",
      assets: prior.assets, warmups, samples, comparisons, resources: resources.map(({ format, disposed }) => ({ format, disposed })), errors }, null, 2);
    status.textContent = `Complete; samples=${samples.length}; controls=${comparisons.length}; disposed=${resources.length}; errors=${errors.length}`;
  } catch (error) { status.textContent = `FAILED: ${error}`; }
  finally { document.removeEventListener("visibilitychange", recordVisibility); release(); button.disabled = false; }
};
window.addEventListener("pagehide", () => { release(); viewer.dispose(); }, { once: true });
