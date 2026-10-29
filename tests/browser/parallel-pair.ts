import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
import { PairedModelLoader, elapsedModelPhases, hashHex, sha256, type PairedSpec, type ModelFormat } from "../helpers/paired-model";
// Recreated from commit 6b2f875; see docs/PARALLEL-PAIR.md.
// @ts-expect-error The frozen baseline is generated in the ignored .qa directory.
import { PairedModelLoader as SerialLoader } from "/.qa/parallel-pair/serial-loader.ts";
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
type Schedule = "serial" | "parallel";
let requestOrigin = 0;
let requests: { url: string; startMs: number; headersMs?: number; error?: string }[] = [];
const driver = {
  async fetch(url: string, signal: AbortSignal) {
    const item = { url, startMs: performance.now() - requestOrigin } as typeof requests[number];
    requests.push(item);
    try { const response = await fetch(url, { signal }); item.headersMs = performance.now() - requestOrigin; return response; }
    catch (error) { item.error = String(error); throw error; }
  },
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
let loader: PairedModelLoader<SplatMesh> = new PairedModelLoader(driver);
function select(schedule: Schedule) { loader.dispose(); loader = schedule === "parallel" ? new PairedModelLoader(driver) : new SerialLoader(driver); }
function clearCandidate() { loader.clear(); if (original) replace(original); }
function release() { loader.dispose(); if (original) replace(original); original = undefined; viewer.clear(); }
button.onclick = async () => {
  button.disabled = true; release(); resources.length = 0; errors.length = 0;
  document.querySelector("#rows")!.replaceChildren(); document.querySelector("#gallery")!.replaceChildren();
  const run = crypto.randomUUID(), samples: unknown[] = [], warmups: unknown[] = [], comparisons: unknown[] = [], checks: unknown[] = [];
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
      const reference = new Map<string, { pixels: Uint8ClampedArray; hash: string }>();
      for (const view of views) { const pixels = await viewer.reference(view); reference.set(view.image_name, { pixels, hash: await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)) }); }
      async function capture(name: string, schedule: Schedule, all: boolean) {
        for (const [index, view] of (all ? views : views.slice(0, 1)).entries()) {
          for (const yaw of all && index === 0 ? [0, -0.08, 0.08] : [0]) {
            viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
            const pixels = viewer.pixels("gaussian");
            const pixelHash = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
            const expected = prior.comparisons.find((x: { scene: string; variant: string; view: string; yaw: number }) =>
              x.scene === scene && x.variant === "alpha16" && x.view === view.image_name && x.yaw === yaw);
            assert(expected?.hash === pixelHash, `Pixel mismatch ${scene}/${name}/${view.image_name}/${yaw}`);
            comparisons.push({ scene, name, schedule, view: view.image_name, yaw, hash: pixelHash, matchesPrevious: true,
              referenceHash: reference.get(view.image_name)!.hash,
              quality: all && yaw === 0 ? quality(pixels, reference.get(view.image_name)!.pixels, viewer.width, viewer.height) : null });
            if (all && index === 0 && yaw === 0) {
              const figure = document.createElement("figure"), img = new Image(), label = document.createElement("figcaption");
              label.textContent = `${scene} · ${schedule} · SH8 + AP16`;
              img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92);
              figure.append(label, img); document.querySelector("#gallery")!.append(figure);
            }
          }
        }
      }
      // Prime the exact shared cache keys; both schedules decode the same SPZ + AP16.
      for (const schedule of ["serial", "parallel"] as const) {
        clearCandidate(); select(schedule); viewer.setView(views[0]); await viewer.settle();
        const before = (await logs()).length;
        const loaded = await loader.load(specFor("warm"));
        assert(loaded.format === "spz" && !loaded.fallbackReason, "Warm-up fallback");
        await viewer.settle();
        warmups.push({ scene, schedule, network: (await logs()).slice(before) });
        await capture("warm-up", schedule, true);
      }
      for (const cache of ["cold-key", "warm-key"]) {
        const order: Schedule[] = ["serial", "parallel", "parallel", "serial", "serial", "parallel", "parallel", "serial"];
        for (const [index, schedule] of order.entries()) {
          status.textContent = `${scene}: ${cache} ${index + 1}/8 ${schedule}`;
          clearCandidate(); select(schedule); viewer.setView(views[0]); await viewer.settle();
          const before = (await logs()).length, visibilityStart = visibility.length;
          const spec = specFor(cache === "warm-key" ? "warm" : `cold-${index}`);
          assert(!document.hidden, "Document hidden before trial");
          requests = []; const start = performance.now(); requestOrigin = start;
          const result = await loader.load(spec);
          const loadMs = performance.now() - start;
          assert(result.format === "spz" && !result.fallbackReason, "Unexpected fallback");
          const settleStart = performance.now(); await viewer.settle();
          const totalMs = performance.now() - start, settleMs = performance.now() - settleStart;
          assert(!document.hidden && visibility.length === visibilityStart, "Visibility changed during trial");
          const network = (await logs()).slice(before);
          const bytes = network.reduce((sum, row) => sum + row.bodyBytesOffered, 0);
          assert(network.every(row => row.finished && row.closed && row.status === 200), "Incomplete HTTP response");
          if (cache === "warm-key") assert(network.length === 0, "Expected browser HTTP cache hit");
          else {
            assert(network.length === 2, "Unexpected request count");
            assert(bytes === a.combinedBytes, "HTTP byte mismatch");
            assert(network.every(row => row.pacing && row.pacing.lastChunkMs! >= row.pacing.idealMs), "Pacing budget violated");
          }
          assert(viewer.scenes.gaussian.children.filter(x => x instanceof SplatMesh).length === 1, "Overlapping models");
          samples.push({ scene, cache, index, schedule, loadMs, settleMs, totalMs, phases: result.phases,
            otherLoadMs: loadMs - (schedule === "parallel" ? elapsedModelPhases(result.phases) : result.phases.reduce((sum, phase) => sum + phase.ms, 0)), requests, network, bodyBytesOffered: bytes });
          const row = document.createElement("tr");
          for (const value of [scene, cache, schedule, loadMs.toFixed(2), settleMs.toFixed(2), totalMs.toFixed(2), bytes]) {
            const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell);
          }
          document.querySelector("#rows")!.append(row);
          await capture(`${cache}-${index}`, schedule, false);
        }
      }
      // Real Fetch cancellation with both requests outstanding; the sidecar has sent a body prefix.
      clearCandidate(); select("parallel"); viewer.setView(views[0]); await viewer.settle();
      const beforeCancel = (await logs()).length;
      const cancelSpec = specFor("cancel");
      cancelSpec.alphaUrl = cancelSpec.alphaUrl.replace("/paced/", "/slow/");
      const pending = loader.load(cancelSpec);
      const outcome = pending.then(() => "resolved", error => String(error));
      const deadline = performance.now() + 5000;
      while ((await logs()).slice(beforeCancel).length < 2 && performance.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert((await logs()).slice(beforeCancel).length === 2, "Both requests must start before cancel");
      const cancelStart = performance.now(); loader.cancel();
      const error = await outcome, cancelMs = performance.now() - cancelStart;
      assert(error.includes("AbortError") && viewer.gaussian === original, "Cancel changed model or failed");
      let cancelled = (await logs()).slice(beforeCancel);
      while (cancelled.some(row => !row.closed) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10)); cancelled = (await logs()).slice(beforeCancel);
      }
      assert(cancelled.length === 2 && cancelled.every(row => row.closed && !row.finished), "Bodies not aborted");
      checks.push({ scene, kind: "cancel-both", cancelMs, error, network: cancelled });

      // A missing sidecar cancels SPZ and falls back to the original PLY once.
      clearCandidate(); select("parallel");
      const failSpec = specFor("missing");
      failSpec.alphaUrl = failSpec.alphaUrl.replace(a.alphaRawSha256, "0".repeat(64));
      const beforeFailure = (await logs()).length;
      const fallback = await loader.load(failSpec); await viewer.settle();
      assert(fallback.format === "ply" && fallback.fallbackReason?.includes("404"), "Missing sidecar fallback");
      const fallbackPixels = viewer.pixels("gaussian");
      const fallbackHash = await hash(new Uint8Array(fallbackPixels.buffer, fallbackPixels.byteOffset, fallbackPixels.byteLength));
      const expectedPly = prior.comparisons.find((x: {scene: string; variant: string; view: string; yaw: number}) =>
        x.scene === scene && x.variant === "original" && x.view === views[0].image_name && x.yaw === 0);
      assert(fallbackHash === expectedPly.hash, "Fallback pixels changed");
      checks.push({ scene, kind: "missing-sidecar", reason: fallback.fallbackReason, hash: fallbackHash,
        network: (await logs()).slice(beforeFailure) });
      release();
    }
    assert(errors.length === 0 && resources.every(r => r.disposed === 1), "Errors or unbalanced resources");
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify({ createdAt: new Date().toISOString(), run, baselineCommit: "6b2f87522f63e73f7656ab5156bf91b4e71a5c14",
      spark: "2.4.0", resolution: 768, maxSh: 3, lod: false,
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), visibility },
      method: "Serial ABBAABBA, four samples per schedule/cache/scene. Identical SPZ + AP16. HTTP body paced at 5 MiB/s PER REQUEST, 64 KiB chunks, 40ms server hold per request (not RTT). Concurrent requests have independent budgets: this is not a shared-link bandwidth experiment. Cold-key is an unused HTTP cache key, with warm renderer/WASM; warm-key reuses exact primed URL. New model every trial. Baseline model retained and displayed while loading, removed on publish. All formats use digest validation. Total ends after four quiet sort frames and mesh draw submission; not GPU time or screen presentation. Excludes page/mesh/runtime startup, baseline restoration, controls, captures and quality scoring. No memory, training, FPS or CDN measurement.",
      assets: prior.assets, warmups, samples, comparisons, checks, resources: resources.map(({ format, disposed }) => ({ format, disposed })), errors }, null, 2);
    status.textContent = `Complete; samples=${samples.length}; controls=${comparisons.length}; disposed=${resources.length}; errors=${errors.length}`;
  } catch (error) { status.textContent = `FAILED: ${error}`; }
  finally { document.removeEventListener("visibilitychange", recordVisibility); release(); button.disabled = false; }
};
window.addEventListener("pagehide", () => { release(); viewer.dispose(); }, { once: true });
