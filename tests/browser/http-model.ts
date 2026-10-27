import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
import { PairedModelLoader, hashHex, sha256, type PairedSpec, type ModelFormat } from "../helpers/paired-model";
import type { HttpRecord } from "../helpers/http-model-fixture";

const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
function assert(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
const hash = async (data: Uint8Array) => hashHex(await sha256(data));
const resources: { model: SplatMesh; format: ModelFormat; disposed: number; published: number }[] = [];
const responses: { url: string; status: number; contentEncoding: string | null }[] = [];
let abortSlow = false;
function replace(model: SplatMesh) {
  if (viewer.gaussian) viewer.scenes.gaussian.remove(viewer.gaussian);
  viewer.gaussian = model; viewer.scenes.gaussian.add(model);
}
const driver = {
  async fetch(url: string, signal: AbortSignal) {
    const result = await fetch(url, { signal });
    responses.push({ url, status: result.status, contentEncoding: result.headers.get("Content-Encoding") });
    if (abortSlow && url.includes("/slow/") && url.includes("/alpha")) queueMicrotask(() => loader.cancel());
    return result;
  },
  create(bytes: Uint8Array, format: ModelFormat) {
    const model = new SplatMesh({ fileBytes: bytes, fileType: format === "spz" ? SplatFileType.SPZ : SplatFileType.PLY,
      extSplats: true, enableLod: false, lod: false });
    resources.push({ model, format, disposed: 0, published: 0 }); return model;
  },
  initialized: (model: SplatMesh) => model.initialized,
  attributes: (model: SplatMesh) => ({ count: model.numSplats, sh: model.extSplats!.getNumSh(), words: model.extSplats!.extArrays[0] }),
  prepare(model: SplatMesh) { model.extSplats!.textures[0].needsUpdate = true; model.maxSh = 3; model.updateGenerator(); },
  publish(model: SplatMesh) { replace(model); resources.find(r => r.model === model)!.published++; },
  dispose(model: SplatMesh) {
    viewer.scenes.gaussian.remove(model); if (viewer.gaussian === model) viewer.gaussian = undefined;
    resources.find(r => r.model === model)!.disposed++; model.dispose();
  },
};
let loader = new PairedModelLoader(driver), original: SplatMesh | undefined;
function release() { loader.dispose(); if (original) replace(original); original = undefined; viewer.clear(); }
const cases: unknown[] = [], comparisons: unknown[] = [], priming: unknown[] = [];
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  document.querySelector<HTMLButtonElement>("#run")!.disabled = true;
  release(); resources.length = responses.length = cases.length = comparisons.length = priming.length = 0;
  document.querySelector("#rows")!.replaceChildren(); document.querySelector("#gallery")!.replaceChildren();
  const run = crypto.randomUUID();
  const logs = async (): Promise<HttpRecord[]> => (await fetch(`/__model_http/${run}/records`, { cache: "no-store" })).json();
  try {
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: baseline`;
      release(); loader = new PairedModelLoader(driver);
      await viewer.load(scene); viewer.playing = false; original = viewer.gaussian!;
      const a = prior.assets.find((x: { scene: string }) => x.scene === scene);
      const specFor = (policy: string): PairedSpec => {
        const url = (kind: string, digest: string) => `/__model_http/${run}/${policy}/${scene}/${kind}${policy === "versioned" ? `?sha256=${digest}` : ""}`;
        return { count: a.count, spzSha256: a.spzSha256, alphaRawSha256: a.alphaRawSha256, plySha256: a.plySha256,
          spzUrl: url("spz", a.spzSha256), alphaUrl: url("alpha", a.alphaRawSha256), plyUrl: url("ply", a.plySha256) };
      };
      async function capture(name: string, format: ModelFormat, allViews: boolean) {
        const views = viewer.data!.views.filter(v => v.heldOut);
        for (const [index, view] of (allViews ? views : views.slice(0, 1)).entries()) {
          for (const yaw of allViews && index === 0 ? [0, -0.08, 0.08] : [0]) {
            viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
            const pixels = viewer.pixels("gaussian");
            const pixelHash = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
            const expected = prior.comparisons.find((x: { scene: string; variant: string; view: string; yaw: number }) =>
              x.scene === scene && x.variant === (format === "spz" ? "alpha16" : "original") && x.view === view.image_name && x.yaw === yaw);
            assert(expected?.hash === pixelHash, `Pixel mismatch: ${scene}/${name}/${view.image_name}/${yaw}`);
            comparisons.push({ scene, name, format, view: view.image_name, yaw, hash: pixelHash, matchesPrevious: true,
              quality: yaw === 0 ? quality(pixels, await viewer.reference(view), viewer.width, viewer.height) : null });
            if (["baseline", "versioned-cold", "disconnect"].includes(name) && index === 0 && yaw === 0) {
              const figure = document.createElement("figure"), caption = document.createElement("figcaption"), img = new Image();
              caption.textContent = `${scene} · ${name}`; img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92);
              figure.append(caption, img); document.querySelector("#gallery")!.append(figure);
            }
          }
        }
      }
      await capture("baseline", "ply", false);
      async function trial(name: string, policy: string, expected: ModelFormat | "AbortError", statuses: number[]) {
        status.textContent = `${scene}: ${name}`;
        const before = (await logs()).length, responseStart = responses.length;
        const displayed = viewer.gaussian, count = resources.length;
        let format: ModelFormat | "AbortError", reason: string | null = null;
        try {
          const result = await loader.load(specFor(policy)); format = result.format; reason = result.fallbackReason ?? null;
        } catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) throw error; format = "AbortError"; }
        assert(format === expected, `Unexpected format for ${name}: ${format}`);
        let network = (await logs()).slice(before);
        for (let attempt = 0; network.some(row => !row.closed) && attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20)); network = (await logs()).slice(before);
        }
        assert(JSON.stringify(network.map(row => row.status)) === JSON.stringify(statuses), `Unexpected network for ${name}: ${JSON.stringify(network)}`);
        assert(network.every(row => row.closed), "HTTP response left open");
        if (format === "AbortError") {
          assert(viewer.gaussian === displayed && resources.length === count, "Abort changed the displayed model");
          assert(network.every(row => row.kind !== "ply"), "Abort started a fallback");
        } else await capture(name, format, ["versioned-cold", "disconnect"].includes(name));
        const visibleModels = viewer.scenes.gaussian.children.filter(x => x instanceof SplatMesh).length;
        assert(visibleModels === 1, "Overlapping models");
        const bodyBytesOffered = network.reduce((sum, row) => sum + row.bodyBytesOffered, 0);
        cases.push({ scene, name, policy, result: format, reason, visibleModels, network,
          fetchResponses: responses.slice(responseStart), bodyBytesOffered });
        const row = document.createElement("tr");
        for (const value of [scene, name, format, network.map(x => x.status).join(" / ") || "缓存命中，无请求", `${bodyBytesOffered.toLocaleString()} B`]) {
          const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
        }
        document.querySelector("#rows")!.append(row);
      }
      await trial("fresh-cold", "fresh", "spz", [200, 200]);
      await trial("fresh-warm", "fresh", "spz", []);
      await trial("validate-cold", "validate", "spz", [200, 200]);
      await trial("validate-304", "validate", "spz", [304, 304]);
      // Prime the mutable alias with an older valid AP16, then change the server revision.
      const primeStart = (await logs()).length;
      const prime = await fetch(specFor("mutable").alphaUrl); const old = new Uint8Array(await prime.arrayBuffer());
      assert(await hash(old) !== a.alphaRawSha256, "Old AP16 cache was not primed");
      priming.push({ scene, oldRawSha256: await hash(old), network: (await logs()).slice(primeStart) });
      await fetch(`/__model_http/${run}/update/${scene}`, { method: "POST" });
      await trial("stale-alias", "mutable", "ply", [200, 200]);
      await trial("stale-alias-repeat", "mutable", "ply", []);
      await trial("versioned-cold", "versioned", "spz", [200, 200]);
      await trial("versioned-warm", "versioned", "spz", []);
      await trial("disconnect", "cut", "ply", [200, 200, 200]);
      abortSlow = true;
      try { await trial("cancel-body", "slow", "AbortError", [200, 200]); }
      finally { abortSlow = false; }
      release();
    }
    assert(resources.every(r => r.disposed === 1), "Model disposal imbalance");
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify({ createdAt: new Date().toISOString(), run, baselineCommit: "5ba54a6", spark: "2.4.0",
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) },
      resolution: 768, maxSh: 3, lod: false,
      method: "Real same-origin HTTP responses and browser HTTP cache, unique run URLs. Fresh means a cache key not previously requested in this run, not a cold renderer or browser. Cache hits and 304 verified by server records. Body bytes offered to the server socket are not total wire bytes. No first-frame, latency, memory or FPS benchmark. Older AP16 is synthesized in server memory; defaults remain untouched.",
      assets: prior.assets, priming, cases, comparisons, resources: resources.map(({ format, disposed, published }) => ({ format, disposed, published })), errors }, null, 2);
    status.textContent = `Complete; cases=${cases.length}; controls=${comparisons.length}; disposed=${resources.length}; errors=${errors.length}`;
  } catch (error) { status.textContent = `FAILED: ${error}`; }
  finally { abortSlow = false; release(); document.querySelector<HTMLButtonElement>("#run")!.disabled = false; }
};
window.addEventListener("pagehide", () => { release(); viewer.dispose(); }, { once: true });
