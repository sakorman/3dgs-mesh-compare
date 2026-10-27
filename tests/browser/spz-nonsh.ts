import { ExtSplats, SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { CompareViewer } from "../../src/viewer";
import { readPlyResponse } from "../../src/model-bytes";
import { restoreAttributes, type Attribute } from "../helpers/ext-attributes";
import { quality } from "../../src/metrics";

const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const status = document.querySelector("#status")!;
const originalFetch = window.fetch.bind(window);
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
let backgrounded = document.hidden;
document.addEventListener("visibilitychange", () => { backgrounded ||= document.hidden; });
const hash = async (bytes: Uint8Array | Uint8ClampedArray) => [...new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
)].map(x => x.toString(16).padStart(2, "0")).join("");
const inputs = new Map<string, { gzip: Uint8Array; spz: Uint8Array }>();
let manualClone: SplatMesh | undefined;
function releaseManual() {
  if (!manualClone) return;
  viewer.scenes.gaussian.remove(manualClone);
  if (viewer.gaussian === manualClone) viewer.gaussian = undefined;
  manualClone.dispose();
  manualClone = undefined;
}
const fields: Attribute[] = ["position", "color", "opacity", "scale", "rotation"];
// Raw arrays are copied, never the source's texture or uniform ownership.
function cloneAttributes(base: ExtSplats, source: ExtSplats, fields: readonly Attribute[]) {
  const extra: { sh1?: Uint32Array; sh2?: Uint32Array; sh3a?: Uint32Array; sh3b?: Uint32Array } = {};
  for (const key of ["sh1", "sh2", "sh3a", "sh3b"] as const) {
    if (!base.extra[key]) throw new Error(`Missing ${key}`);
    extra[key] = base.extra[key]!.slice();
  }
  return new SplatMesh({
    extSplats: new ExtSplats({
      extArrays: restoreAttributes(base.extArrays, source.extArrays, base.numSplats, fields),
      numSplats: base.numSplats,
      extra,
    }),
    enableLod: false,
    lod: false,
  });
}
function replace(mesh: SplatMesh) {
  if (viewer.gaussian) viewer.scenes.gaussian.remove(viewer.gaussian);
  viewer.gaussian = mesh;
  viewer.scenes.gaussian.add(mesh);
}
type Capture = {
  scene: string; variant: string; view: string; yaw: number; size: number[];
  hash: string; quality: ReturnType<typeof quality> | null;
  pixels: Uint8ClampedArray; image: string;
};
async function capture(scene: string, variant: string) {
  const captures: Capture[] = [];
  for (const [index, view] of viewer.data!.views.filter(v => v.heldOut).entries()) {
    for (const yaw of index === 0 ? [0, -0.08, 0.08] : [0]) {
      viewer.setView(view);
      viewer.camera.rotateY(yaw);
      await viewer.settle();
      const pixels = viewer.pixels("gaussian");
      const reference = yaw === 0 ? await viewer.reference(view) : null;
      captures.push({
        scene, variant, view: view.image_name, yaw, size: [viewer.width, viewer.height],
        hash: await hash(pixels),
        quality: reference ? quality(pixels, reference, viewer.width, viewer.height) : null,
        pixels, image: viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", 0.92),
      });
    }
  }
  return captures;
}
const labels: Record<string, string> = {
  original: "原始 PLY", sh8: "SPZ3 / SH8", position: "仅恢复位置", color: "仅恢复 DC 颜色",
  opacity: "仅恢复不透明度", scale: "仅恢复尺度", rotation: "仅恢复旋转", all: "恢复全部非 SH 属性",
};
const assets: unknown[] = [], controls: unknown[] = [], comparisons: unknown[] = [];
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  document.querySelector<HTMLButtonElement>("#run")!.disabled = true;
  for (const id of ["show", "orbit", "reset"]) document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = true;
  releaseManual();
  try {
    const prep = await (await originalFetch("/.qa/spz-sh8/preparation.json")).json();
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: checking inputs`;
      const gzipResponse = await originalFetch(`/.qa/${scene}-gaussians.bin`);
      if (!gzipResponse.ok) throw new Error("Run scripts/prepare_spz_experiment.py first");
      const gzip = new Uint8Array(await gzipResponse.arrayBuffer());
      const ply = new Uint8Array(await readPlyResponse(new Response(gzip)));
      const cached = await originalFetch(`/.qa/spz-sh8/${scene}-sh8.spz`);
      if (!cached.ok || cached.headers.get("content-type")?.includes("text/html")) throw new Error("Missing SH8 candidate");
      const spz = new Uint8Array(await cached.arrayBuffer());
      const spzHash = await hash(spz);
      const expected = prep.assets.find((x: { scene: string }) => x.scene === scene);
      if (spzHash !== expected.candidateSha256 || await hash(ply) !== expected.plySha256) throw new Error("Input hashes differ");
      inputs.set(scene, { gzip, spz });
      window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname === `/scenes/${scene}/gaussians.ply.gz`) {
          init?.signal?.throwIfAborted();
          return new Response(gzip);
        }
        return originalFetch(input, init);
      };
      await viewer.load(scene);
      viewer.playing = false;
      const original = viewer.gaussian!;
      const candidate = new SplatMesh({ fileBytes: spz, fileType: SplatFileType.SPZ, extSplats: true, enableLod: false, lod: false });
      let clone: SplatMesh | undefined;
      try {
        await candidate.initialized;
        candidate.maxSh = 3;
        candidate.updateGenerator();
        const a = original.extSplats!, b = candidate.extSplats!;
        if (!a || !b || a.numSplats !== b.numSplats || a.numSplats !== viewer.data!.gaussian.count || a.getNumSh() !== 3 || b.getNumSh() !== 3)
          throw new Error("Count or SH mismatch");
        // Ensure per-index positions differ only by the configured fixed-point rounding.
        let maxPositionAxisError = 0;
        for (let i = 0; i < a.numSplats; i++) {
          // Spark reuses a scratch result across getSplat calls.
          const ac = a.getSplat(i).center.clone(), bc = b.getSplat(i).center;
          maxPositionAxisError = Math.max(maxPositionAxisError, Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y), Math.abs(ac.z - bc.z));
        }
        if (maxPositionAxisError > 1 / 8192 + 1e-6) throw new Error("Per-index position alignment failed");
        assets.push({ scene, count: a.numSplats, maxPositionAxisError, gzipSha256: await hash(gzip), plySha256: await hash(ply), spzSha256: spzHash, spzBytes: spz.length });
        status.textContent = `${scene}: direct controls`;
        const directOriginal = await capture(scene, "directOriginal");
        replace(candidate);
        const directSpz = await capture(scene, "directSpz");
        const captures: Capture[] = [];
        for (const [variant, base, restored] of [
          ["original", a, []], ["sh8", b, []],
          ...fields.map(field => [field, b, [field]] as const), ["all", b, fields],
        ] as const) {
          status.textContent = `${scene}: ${variant}`;
          clone = cloneAttributes(base, a, restored);
          await clone.initialized;
          clone.maxSh = 3;
          clone.updateGenerator();
          replace(clone);
          const group = await capture(scene, variant);
          if (variant === "original" || variant === "sh8") {
            const direct = variant === "original" ? directOriginal : directSpz;
            for (const [i, c] of group.entries()) {
              const equal = c.hash === direct[i].hash;
              controls.push({ scene, variant, view: c.view, yaw: c.yaw, directHash: direct[i].hash, cloneHash: c.hash, equal });
              if (!equal) throw new Error("Clone control pixels differ");
            }
          }
          captures.push(...group);
          replace(original);
          clone.dispose();
          clone = undefined;
        }
        for (const c of captures) {
          const baseline = directOriginal.find(x => x.view === c.view && x.yaw === c.yaw)!;
          comparisons.push({
            scene, variant: c.variant, view: c.view, yaw: c.yaw, size: c.size, hash: c.hash, quality: c.quality,
            betweenRenders: c.variant === "original" ? null : quality(c.pixels, baseline.pixels, c.size[0], c.size[1]),
          });
        }
        for (const yaw of [0, -0.08, 0.08]) {
          const title = document.createElement("h2");
          title.textContent = `${scene} · yaw ${yaw}`;
          const grid = document.createElement("div");
          grid.className = "grid";
          grid.id = `${scene}-${yaw}`;
          for (const c of captures.filter(c => c.view === directOriginal[0].view && c.yaw === yaw)) {
            const figure = document.createElement("figure"), label = document.createElement("figcaption"), img = new Image();
            label.textContent = labels[c.variant];
            img.src = c.image;
            figure.append(label, img);
            grid.append(figure);
          }
          document.querySelector("#gallery")!.append(title, grid);
        }
      } finally {
        replace(original);
        clone?.dispose();
        candidate.dispose();
      }
      viewer.clear();
      window.fetch = originalFetch;
    }
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify({
      createdAt: new Date().toISOString(), baselineCommit: "1010002", spark: "2.4.0",
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) },
      resolution: 768, maxSh: 3, lod: false, backgrounded,
      method: "Serial quality-only SH8 attribution: restore each non-SH field using exact decoded bit masks, hold SH8 fixed. Original and SH8 clones must match direct controls. No new compressed format or timing result.",
      assets, controls, comparisons, errors,
    }, null, 2);
    document.querySelector<HTMLButtonElement>("#show")!.disabled = false;
    status.textContent = `Complete; controls=${controls.length}; errors=${errors.length}; backgrounded=${backgrounded}`;
  } catch (e) {
    status.textContent = "FAILED: " + String(e);
  } finally {
    window.fetch = originalFetch;
    viewer.clear();
  }
};
window.addEventListener("pagehide", () => { releaseManual(); viewer.dispose(); window.fetch = originalFetch; }, { once: true });

document.querySelector<HTMLButtonElement>("#show")!.onclick = async () => {
  const show = document.querySelector<HTMLButtonElement>("#show")!;
  for (const id of ["show", "orbit", "reset", "run"]) document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = true;
  releaseManual();
  try {
    const scene = document.querySelector<HTMLSelectElement>("#scene")!.value;
    const variant = document.querySelector<HTMLSelectElement>("#variant")!.value;
    if (!inputs.has(scene)) {
      const prep = await (await originalFetch("/.qa/spz-sh8/preparation.json")).json();
      const expected = prep.assets.find((x: { scene: string }) => x.scene === scene);
      const gzip = new Uint8Array(await (await originalFetch(`/.qa/${scene}-gaussians.bin`)).arrayBuffer());
      const spz = new Uint8Array(await (await originalFetch(`/.qa/spz-sh8/${scene}-sh8.spz`)).arrayBuffer());
      if (await hash(spz) !== expected.candidateSha256 || await hash(new Uint8Array(await readPlyResponse(new Response(gzip)))) !== expected.plySha256)
        throw new Error("Input hashes differ");
      inputs.set(scene, { gzip, spz });
    }
    const input = inputs.get(scene)!;
    window.fetch = async (url, init) => {
      const path = new URL(url instanceof Request ? url.url : String(url), location.href).pathname;
      return path === `/scenes/${scene}/gaussians.ply.gz` ? new Response(input.gzip) : originalFetch(url, init);
    };
    await viewer.load(scene);
    viewer.playing = false;
    if (variant !== "original") {
      const original = viewer.gaussian!;
      const candidate = new SplatMesh({ fileBytes: input.spz, fileType: SplatFileType.SPZ, extSplats: true, enableLod: false, lod: false });
      try {
        await candidate.initialized;
        const restored = variant === "all" ? fields : variant === "sh8" ? [] : [variant as Attribute];
        manualClone = cloneAttributes(candidate.extSplats!, original.extSplats!, restored);
        await manualClone.initialized;
        manualClone.maxSh = 3; manualClone.updateGenerator(); replace(manualClone);
      } finally { candidate.dispose(); }
    }
    await viewer.settle();
    const visibleModels = viewer.scenes.gaussian.children.filter(child => child instanceof SplatMesh).length;
    if (visibleModels !== 1) throw new Error(`Expected one visible model, found ${visibleModels}`);
    viewer.playing = true;
    status.textContent = `Viewing ${scene}: ${labels[variant]}; models=${visibleModels}`;
    for (const id of ["orbit", "reset"]) document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = false;
  } catch (e) { releaseManual(); viewer.clear(); status.textContent = `FAILED: ${e}`; }
  finally { window.fetch = originalFetch; show.disabled = false; }
};
document.querySelector<HTMLButtonElement>("#orbit")!.onclick = () => viewer.orbit(true);
document.querySelector<HTMLButtonElement>("#reset")!.onclick = () => viewer.orbit(false);
