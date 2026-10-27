import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { CompareViewer } from "../../src/viewer";
import { readPlyResponse } from "../../src/model-bytes";
import { quality } from "../../src/metrics";
import { encodeAlpha16, applyAlpha16 } from "../helpers/alpha16";
const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const status = document.querySelector("#status")!;
const originalFetch = window.fetch.bind(window);
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
let backgrounded = document.hidden;
document.addEventListener("visibilitychange", () => { backgrounded ||= document.hidden; });
const digest = async (bytes: Uint8Array | Uint8ClampedArray) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
const hex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
const hash = async (bytes: Uint8Array | Uint8ClampedArray) => hex(await digest(bytes));
async function file(url: string) {
  const response = await originalFetch(url);
  if (!response.ok || response.headers.get("content-type")?.includes("text/html")) throw new Error(`Missing ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function gzip(bytes: Uint8Array, decompress = false) {
  const stream = new Response(bytes).body!;
  return new Uint8Array(await new Response(decompress ? stream.pipeThrough(new DecompressionStream("gzip")) : stream.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
function make(bytes: Uint8Array, type: SplatFileType) {
  return new SplatMesh({ fileBytes: bytes, fileType: type, extSplats: true, enableLod: false, lod: false });
}
function replace(mesh: SplatMesh) {
  if (viewer.gaussian) viewer.scenes.gaussian.remove(viewer.gaussian);
  viewer.gaussian = mesh; viewer.scenes.gaussian.add(mesh);
}
function ready(mesh: SplatMesh) { mesh.maxSh = 3; mesh.updateGenerator(); }
function lock(locked: boolean) {
  for (const id of ["prepare", "run", "show", "orbit", "reset"]) document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = locked;
}
async function source(scene: string) {
  const prep = await (await originalFetch("/.qa/spz-sh8/preparation.json")).json();
  const expected = prep.assets.find((x: { scene: string }) => x.scene === scene);
  const plyGzip = await file(`/.qa/${scene}-gaussians.bin`), spz = await file(`/.qa/spz-sh8/${scene}-sh8.spz`);
  if (await hash(spz) !== expected.candidateSha256 || await hash(new Uint8Array(await readPlyResponse(new Response(plyGzip)))) !== expected.plySha256)
    throw new Error("Source hashes differ");
  return { plyGzip, spz, expected };
}
document.querySelector<HTMLButtonElement>("#prepare")!.onclick = async () => {
  lock(true); releaseManual(); viewer.clear();
  document.querySelector("#assets")!.replaceChildren();
  try {
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: generating AP16`;
      const { plyGzip, spz } = await source(scene);
      const model = make(new Uint8Array(await readPlyResponse(new Response(plyGzip))), SplatFileType.PLY);
      try {
        await model.initialized;
        const raw = encodeAlpha16(model.extSplats!.extArrays[0], model.numSplats, await digest(spz));
        const compressed = await gzip(raw);
        let binary = "";
        for (let offset = 0; offset < compressed.length; offset += 16384) binary += String.fromCharCode(...compressed.subarray(offset, offset + 16384));
        const output = document.createElement("textarea"); output.id = `${scene}-asset`; output.value = btoa(binary);
        const link = document.createElement("a");
        link.href = `data:application/octet-stream;base64,${output.value}`;
        link.download = `${scene}.ap16.bin`; link.textContent = `下载 ${scene}.ap16.bin`;
        document.querySelector("#assets")!.append(link, output);
      } finally { model.dispose(); }
    }
    status.textContent = "Prepared; save both base64 fields before verification";
  } catch (e) { status.textContent = `FAILED: ${e}`; }
  finally { lock(false); }
};
let manual: SplatMesh | undefined;
function releaseManual() {
  if (!manual) return;
  viewer.scenes.gaussian.remove(manual);
  if (viewer.gaussian === manual) viewer.gaussian = undefined;
  manual.dispose(); manual = undefined;
}
async function loadReference(scene: string, bytes: Uint8Array) {
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    return url.pathname === `/scenes/${scene}/gaussians.ply.gz` ? new Response(bytes) : originalFetch(input, init);
  };
  try { await viewer.load(scene); viewer.playing = false; }
  finally { window.fetch = originalFetch; }
}
async function patch(mesh: SplatMesh, alpha: Uint8Array, spz: Uint8Array) {
  const start = performance.now();
  const raw = await gzip(alpha, true), decompressed = performance.now();
  const modelHash = await digest(spz), hashed = performance.now();
  applyAlpha16(raw, mesh.extSplats!.extArrays[0], mesh.numSplats, modelHash);
  mesh.extSplats!.textures[0].needsUpdate = true;
  const patched = performance.now();
  return { alphaGzipMs: decompressed - start, modelHashMs: hashed - decompressed, validatePatchMs: patched - hashed, alphaTotalMs: patched - start };
}
const samples: unknown[] = [], assets: unknown[] = [], comparisons: unknown[] = [];
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  lock(true); releaseManual();
  samples.length = assets.length = comparisons.length = 0;
  document.querySelector("#gallery")!.replaceChildren();
  document.querySelector("#result")!.textContent = "";
  try {
    const prior = await (await originalFetch("/docs/benchmarks/spz-nonsh-2026-10-27.json")).json();
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: checking saved files`;
      const { plyGzip, spz, expected } = await source(scene);
      const alpha = await file(`/.qa/spz-alpha16/${scene}.ap16.bin`), rawAlpha = await gzip(alpha, true);
      await loadReference(scene, plyGzip);
      const original = viewer.gaussian!;
      const expectedRaw = encodeAlpha16(original.extSplats!.extArrays[0], original.numSplats, await digest(spz));
      if (await hash(rawAlpha) !== await hash(expectedRaw)) throw new Error("Saved opacity differs from source");
      assets.push({ scene, count: original.numSplats, plyGzipBytes: plyGzip.length, plyGzipSha256: await hash(plyGzip), plySha256: expected.plySha256,
        spzBytes: spz.length, spzSha256: await hash(spz), alphaRawBytes: rawAlpha.length, alphaRawSha256: await hash(rawAlpha),
        alphaGzipBytes: alpha.length, alphaGzipSha256: await hash(alpha), combinedBytes: spz.length + alpha.length });
      // Runtime, renderer, metadata and Mesh are warm. Inputs are already in memory.
      // Each sample constructs and disposes a fresh Gaussian model; timings are serial.
      const order = ["original", "alpha16", "alpha16", "original", "original", "alpha16", "alpha16", "original"];
      const captured = new Set<string>();
      for (const [index, variant] of order.entries()) {
        status.textContent = `${scene}: ${variant} sample ${index + 1}/8`;
        viewer.setView(viewer.data!.views.find(v => v.heldOut)!);
        let model: SplatMesh | undefined;
        const start = performance.now();
        try {
          const bytes = variant === "original" ? new Uint8Array(await readPlyResponse(new Response(plyGzip))) : spz;
          const readDone = performance.now();
          model = make(bytes, variant === "original" ? SplatFileType.PLY : SplatFileType.SPZ);
          await model.initialized;
          const decoded = performance.now();
          if (model.numSplats !== original.numSplats || model.extSplats!.getNumSh() !== 3) throw new Error("Count/SH mismatch");
          const alphaTiming = variant === "alpha16" ? await patch(model, alpha, spz) : null;
          ready(model); const patched = performance.now();
          replace(model); await viewer.settle(); const settled = performance.now();
          samples.push({ scene, variant, index, plyReadMs: readDone - start, modelInitializeMs: decoded - readDone,
            alphaTiming, postInitializeMs: patched - decoded, settleMs: settled - patched, totalMs: settled - start });
          if (!captured.has(variant)) {
            captured.add(variant);
            for (const [viewIndex, view] of viewer.data!.views.filter(v => v.heldOut).entries()) {
              for (const yaw of viewIndex === 0 ? [0, -0.08, 0.08] : [0]) {
                viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
                const pixels = viewer.pixels("gaussian"), pixelHash = await hash(pixels);
                const previous = prior.comparisons.find((x: { scene: string; variant: string; view: string; yaw: number }) =>
                  x.scene === scene && x.variant === (variant === "original" ? "original" : "opacity") && x.view === view.image_name && x.yaw === yaw);
                const identical = pixelHash === previous?.hash;
                comparisons.push({ scene, variant, view: view.image_name, yaw, size: [viewer.width, viewer.height], hash: pixelHash, matchesPrevious: identical,
                  quality: yaw === 0 ? quality(pixels, await viewer.reference(view), viewer.width, viewer.height) : null });
                if (!identical) throw new Error("Saved-file render differs from diagnostic control");
                if (viewIndex === 0) {
                  let grid = document.querySelector(`#${scene}-yaw${String(yaw).replaceAll(".", "_").replaceAll("-", "m")}`);
                  if (!grid) { grid = document.createElement("div"); grid.id = `${scene}-yaw${String(yaw).replaceAll(".", "_").replaceAll("-", "m")}`; grid.className = "grid"; document.querySelector("#gallery")!.append(grid); }
                  const figure = document.createElement("figure"), label = document.createElement("figcaption"), img = new Image();
                  label.textContent = `${scene} · ${variant === "original" ? "原始 PLY" : "SH8 + AP16"} · yaw ${yaw}`;
                  img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92); figure.append(label, img); grid.append(figure);
                }
              }
            }
          }
        } finally { replace(original); model?.dispose(); }
      }
      viewer.clear();
    }
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify({ createdAt: new Date().toISOString(), baselineCommit: "c5dbc92", spark: "2.4.0",
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) },
      resolution: 768, maxSh: 3, lod: false, backgrounded,
      method: "Saved AP16 gzip + exact SH8 file. Warm renderer/runtime; preloaded memory bytes. Serial fresh model initialization, ABBA ABBA; includes PLY gzip or SPZ decode plus AP16 gzip/hash/patch and sort settlement. Excludes network, metadata/Mesh loading, cold startup, presentation and GPU query time. Quality outside timing, checked against previous direct PLY/restored-opacity diagnostic.",
      assets, samples, comparisons, errors }, null, 2);
    status.textContent = `Complete; samples=${samples.length}; controls=${comparisons.length}; errors=${errors.length}; backgrounded=${backgrounded}`;
  } catch (e) { status.textContent = `FAILED: ${e}`; }
  finally { viewer.clear(); lock(false); }
};
document.querySelector<HTMLButtonElement>("#show")!.onclick = async () => {
  lock(true); releaseManual();
  try {
    const scene = document.querySelector<HTMLSelectElement>("#scene")!.value;
    const variant = document.querySelector<HTMLSelectElement>("#variant")!.value;
    const { plyGzip, spz } = await source(scene);
    await loadReference(scene, plyGzip);
    if (variant === "alpha16") {
      manual = make(spz, SplatFileType.SPZ); await manual.initialized;
      await patch(manual, await file(`/.qa/spz-alpha16/${scene}.ap16.bin`), spz); ready(manual); replace(manual);
    }
    await viewer.settle();
    const models = viewer.scenes.gaussian.children.filter(child => child instanceof SplatMesh).length;
    if (models !== 1) throw new Error(`Unexpected visible model count: ${models}`);
    viewer.playing = true;
    status.textContent = `Viewing ${scene}: ${variant}; models=${models}`;
  } catch (e) { releaseManual(); viewer.clear(); status.textContent = `FAILED: ${e}`; }
  finally { lock(false); }
};
document.querySelector<HTMLButtonElement>("#orbit")!.onclick = () => viewer.orbit(true);
document.querySelector<HTMLButtonElement>("#reset")!.onclick = () => viewer.orbit(false);
window.addEventListener("pagehide", () => { releaseManual(); viewer.dispose(); }, { once: true });
