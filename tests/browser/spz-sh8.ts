import { quality } from "../../src/metrics";
import type { CompareViewer } from "../../src/viewer";
import type { SceneData } from "../../src/types";
const modulePath = "/.qa/spz-viewer.ts";
const Viewer = (await import(/* @vite-ignore */ modulePath)).CompareViewer;
const viewer: CompareViewer = new Viewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
const originalFetch = window.fetch.bind(window);
const status = document.querySelector("#status")!;
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const hash = async (bytes: Uint8Array | Uint8ClampedArray) => [...new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
)].map(x => x.toString(16).padStart(2, "0")).join("");
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
let backgrounded = document.hidden;
document.addEventListener("visibilitychange", () => { backgrounded ||= document.hidden; });
type Input = { data: SceneData; gzip: Uint8Array; spz: Uint8Array; sh8: Uint8Array; metadata: Uint8Array; mesh: Uint8Array };
const inputs = new Map<string, Input>();
let selectedFormat = "ply";
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const match = url.pathname.match(/\/scenes\/(pipes|office)(-spz)?\/([^/]+)$/);
  const source = match && inputs.get(match[1]);
  if (match && source) {
    init?.signal?.throwIfAborted();
    if (match[3] === "scene.json") return new Response(source.metadata);
    if (match[3] === source.data.gaussian.url)
      return new Response(selectedFormat === "ply" ? source.gzip : selectedFormat === "sh8" ? source.sh8 : source.spz);
    if (match[3] === source.data.mesh.url) return new Response(source.mesh);
  }
  return originalFetch(input, init);
};
async function bytes(path: string) {
  const response = await originalFetch(path);
  if (!response.ok || response.headers.get("content-type")?.includes("text/html"))
    throw new Error(`Missing experiment input: ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function load(scene: string, format: string) {
  selectedFormat = format;
  await viewer.load(scene + (format === "ply" ? "" : "-spz"));
  viewer.playing = false;
}
type Capture = { scene: string; format: string; view: string; yaw: number; size: number[]; hash: string; quality: ReturnType<typeof quality> | null; pixels: Uint8ClampedArray; image: string };
const labels: Record<string, string> = { ply: "原始 PLY", spz: "SPZ3 · SH 5/4 位", sh8: "SPZ3 · SH 8 位" };
const assets: unknown[] = [], comparisons: unknown[] = [];
button("run").onclick = async () => {
  button("run").disabled = true;
  try {
    const preparation = JSON.parse(new TextDecoder().decode(await bytes("/.qa/spz-sh8/preparation.json")));
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: checking input hashes`;
      const metadata = await bytes(`/scenes/${scene}/scene.json`);
      const data: SceneData = JSON.parse(new TextDecoder().decode(metadata));
      const gzip = await bytes(`/.qa/${scene}-gaussians.bin`);
      const spz = await bytes(`/.qa/${scene}-candidate.spz`);
      const sh8 = await bytes(`/.qa/spz-sh8/${scene}-sh8.spz`);
      const mesh = await bytes(`/scenes/${scene}/${data.mesh.url}`);
      const expected = preparation.assets.find((a: { scene: string }) => a.scene === scene);
      if (await hash(spz) !== expected.sourceSpzSha256 || await hash(sh8) !== expected.candidateSha256 || expected.count !== data.gaussian.count)
        throw new Error("Input hash or count mismatch");
      inputs.set(scene, { data, gzip, spz, sh8, metadata, mesh });
      assets.push({ scene, count: data.gaussian.count, gzipBytes: gzip.length, gzipSha256: await hash(gzip), manifestSha256: await hash(metadata), spzBytes: spz.length, spzSha256: await hash(spz), sh8Bytes: sh8.length, sh8Sha256: await hash(sh8) });
      const captures: Capture[] = [];
      for (const format of ["ply", "spz", "sh8"]) {
        status.textContent = `${scene}: ${format}`;
        await load(scene, format);
        if (viewer.gaussian!.extSplats!.numSplats !== data.gaussian.count || viewer.gaussian!.extSplats!.getNumSh() !== 3)
          throw new Error("Decoded count or SH degree mismatch");
        for (const [index, view] of data.views.filter(v => v.heldOut).entries()) {
          for (const yaw of index === 0 ? [0, -0.08, 0.08] : [0]) {
            viewer.setView(view);
            viewer.camera.rotateY(yaw);
            await viewer.settle();
            const pixels = viewer.pixels("gaussian");
            const reference = yaw === 0 ? await viewer.reference(view) : null;
            captures.push({ scene, format, view: view.image_name, yaw, size: [viewer.width, viewer.height],
              hash: await hash(pixels), quality: reference ? quality(pixels, reference, viewer.width, viewer.height) : null,
              pixels, image: viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92) });
          }
        }
      }
      for (const capture of captures) {
        const base = captures.find(x => x.format === "ply" && x.view === capture.view && x.yaw === capture.yaw)!;
        const { pixels, image, ...row } = capture;
        comparisons.push({ ...row, betweenRenders: capture.format === "ply" ? null : quality(pixels, base.pixels, base.size[0], base.size[1]) });
      }
      for (const yaw of [0, -.08, .08]) {
        const title = document.createElement("h2");
        title.textContent = `${scene} · yaw ${yaw}`;
        const pair = document.createElement("div");
        pair.className = "pair"; pair.id = `${scene}-${yaw}`;
        for (const c of captures.filter(c => c.view === data.views.find(v => v.heldOut)!.image_name && c.yaw === yaw)) {
          const figure = document.createElement("figure"), label = document.createElement("figcaption"), img = new Image();
          label.textContent = labels[c.format]; img.src = c.image;
          figure.append(label, img); pair.append(figure);
        }
        document.querySelector("#gallery")!.append(title, pair);
      }
    }
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify({
      createdAt: new Date().toISOString(), baselineCommit: "e52b11d", viewerCommit: "db828fa", spark: "2.4.0",
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) },
      resolution: 768, maxSh: 3, lod: false, backgrounded, method: "Serial quality-only file comparison: PLY, original SPZ3, SH8 SPZ3. No load or frame timing samples.",
      preparation, assets, comparisons, errors,
    }, null, 2);
    viewer.clear();
    for (const id of ["show", "orbit", "reset"]) button(id).disabled = false;
    status.textContent = `Complete; captures=${comparisons.length}; errors=${errors.length}; backgrounded=${backgrounded}`;
  } catch (e) { status.textContent = "FAILED: " + String(e); viewer.clear(); }
};
button("show").onclick = async () => {
  for (const id of ["show", "orbit", "reset"]) button(id).disabled = true;
  try {
    const scene = document.querySelector<HTMLSelectElement>("#scene")!.value;
    const format = document.querySelector<HTMLSelectElement>("#format")!.value;
    await load(scene, format); viewer.playing = true;
    status.textContent = `Viewing ${scene} ${format}`;
    for (const id of ["show", "orbit", "reset"]) button(id).disabled = false;
  } catch (e) { status.textContent = "FAILED: " + String(e); button("show").disabled = false; }
};
button("orbit").onclick = () => viewer.orbit(true);
button("reset").onclick = () => viewer.orbit(false);
window.addEventListener("pagehide", () => { viewer.dispose(); window.fetch = originalFetch; }, { once: true });
