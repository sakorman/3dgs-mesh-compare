import { transcodeSpz, SplatFileType } from "@sparkjsdev/spark";
import { readPlyResponse } from "../../src/model-bytes";
import { quality } from "../../src/metrics";
import type { CompareViewer } from "../../src/viewer";
import type { SceneData } from "../../src/types";
const modulePath = "/.qa/spz-viewer.ts";
const Viewer = (await import(/* @vite-ignore */ modulePath)).CompareViewer;
const viewer: CompareViewer = new Viewer(
  document.querySelector("#left")!,
  document.querySelector("#right")!,
);
viewer.playing = false;
const originalFetch = window.fetch.bind(window);
const status = document.querySelector("#status")!;
const button = (id: string) =>
  document.querySelector<HTMLButtonElement>(`#${id}`)!;
const scenes = ["pipes", "office"];
type Input = {
  data: SceneData;
  gzip: Uint8Array;
  spz: Uint8Array;
  mesh: Uint8Array;
  metadata: Uint8Array;
};
const inputs = new Map<string, Input>();
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
let backgrounded = document.hidden;
document.addEventListener("visibilitychange", () => {
  backgrounded ||= document.hidden;
});
const hash = async (bytes: Uint8Array | Uint8ClampedArray) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const blob64 = (bytes: Uint8Array) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  });
function response(bytes: Uint8Array) {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 65536, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      },
      { highWaterMark: 0 },
    ),
  );
}
window.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.href,
  );
  const match = url.pathname.match(/\/scenes\/(pipes|office)(-spz)?\/([^/]+)$/);
  const source = match && inputs.get(match[1]);
  if (match && source) {
    init?.signal?.throwIfAborted();
    if (match[3] === "scene.json") return response(source.metadata);
    if (match[3] === source.data.gaussian.url)
      return response(match[2] ? source.spz : source.gzip);
    if (match[3] === source.data.mesh.url) return response(source.mesh);
  }
  return originalFetch(input, init);
};
const assetReport: Record<string, unknown>[] = [];
button("prepare").onclick = async () => {
  button("prepare").disabled = true;
  try {
    const saved: Record<string, string> = {};
    for (const scene of scenes) {
      status.textContent = `Preparing ${scene}`;
      const metadata = new Uint8Array(
        await (
          await originalFetch(`/scenes/${scene}/scene.json`)
        ).arrayBuffer(),
      );
      const data: SceneData = JSON.parse(new TextDecoder().decode(metadata));
      const gzip = new Uint8Array(
        await (
          await originalFetch(`/.qa/${scene}-gaussians.bin`)
        ).arrayBuffer(),
      );
      if (gzip[0] !== 31 || gzip[1] !== 139)
        throw new Error("Expected raw gzip bytes");
      const ply = new Uint8Array(await readPlyResponse(response(gzip)));
      const mesh = new Uint8Array(
        await (
          await originalFetch(`/scenes/${scene}/${data.mesh.url}`)
        ).arrayBuffer(),
      );
      const start = performance.now();
      const converted = await transcodeSpz({
        inputs: [{ fileBytes: ply, fileType: SplatFileType.PLY }],
        maxSh: 3,
        fractionalBits: 12,
        opacityThreshold: 0,
        version: 3,
      });
      const conversionMs = performance.now() - start;
      const spz = new Uint8Array(converted.fileBytes);
      const unpacked = await new Response(
        response(spz).body!.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
      const header = new DataView(unpacked);
      const version = header.getUint32(4, true),
        count = header.getUint32(8, true),
        sh = header.getUint8(12),
        bits = header.getUint8(13);
      if (
        header.getUint32(0, true) !== 0x5053474e ||
        version !== 3 ||
        count !== data.gaussian.count ||
        sh !== 3 ||
        bits !== 12
      )
        throw new Error("Unexpected SPZ header/count/SH");
      inputs.set(scene, { data, gzip, spz, mesh, metadata });
      assetReport.push({
        scene,
        gzipBytes: gzip.length,
        decodedPlyBytes: ply.length,
        spzBytes: spz.length,
        spzVersion: version,
        count,
        shDegree: sh,
        fractionalBits: bits,
        conversionMs,
        gzipSha256: await hash(gzip),
        plySha256: await hash(ply),
        spzSha256: await hash(spz),
        manifestSha256: await hash(metadata),
      });
      saved[scene] = await blob64(spz);
    }
    document.querySelector<HTMLTextAreaElement>("#assets")!.value =
      JSON.stringify(saved);
    button("run").disabled = false;
    status.textContent = "Prepared; ready for serial comparison";
  } catch (e) {
    status.textContent = "FAILED: " + String(e);
  }
};
type Capture = {
  scene: string;
  format: string;
  view: string;
  yaw: number;
  size: number[];
  hash: string;
  quality: ReturnType<typeof quality> | null;
  pixels: Uint8ClampedArray;
  image: string;
};
const captures: Capture[] = [];
async function capture(scene: string, format: string) {
  for (const [i, view] of viewer
    .data!.views.filter((v) => v.heldOut)
    .entries()) {
    for (const yaw of i === 0 ? [0, -0.08, 0.08] : [0]) {
      viewer.setView(view);
      viewer.camera.rotateY(yaw);
      await viewer.settle();
      const pixels = viewer.pixels("gaussian");
      const reference = yaw === 0 ? await viewer.reference(view) : null;
      captures.push({
        scene,
        format,
        view: view.image_name,
        yaw,
        size: [viewer.width, viewer.height],
        hash: await hash(pixels),
        quality: reference
          ? quality(pixels, reference, viewer.width, viewer.height)
          : null,
        pixels,
        image: viewer.renderers.gaussian.domElement.toDataURL(
          "image/jpeg",
          0.92,
        ),
      });
    }
  }
}
const rows: unknown[] = [];
const qualityOnly = new URLSearchParams(location.search).has("qualityOnly");
if (qualityOnly) button("run").textContent = "仅检查画质与截图";
button("run").onclick = async () => {
  button("run").disabled = true;
  try {
    for (const scene of scenes) {
      for (const format of qualityOnly ? [] : ["ply", "spz"]) {
        await viewer.load(scene + (format === "spz" ? "-spz" : ""));
        viewer.playing = false;
      }
      const order = qualityOnly
        ? []
        : ["ply", "spz", "spz", "ply", "ply", "spz", "spz", "ply"];
      for (const [index, format] of order.entries()) {
        status.textContent = `${scene}: ${index + 1}/8 ${format}`;
        await viewer.load(scene + (format === "spz" ? "-spz" : ""));
        viewer.playing = false;
        rows.push({
          scene,
          format,
          sequence: index + 1,
          trace: viewer.loadTimings,
        });
      }
      // Quality/readback is performed after all timed loads for this scene.
      for (const format of ["ply", "spz"]) {
        await viewer.load(scene + (format === "spz" ? "-spz" : ""));
        viewer.playing = false;
        await capture(scene, format);
      }
    }
    const comparisons = captures
      .filter((c) => c.format === "ply")
      .map((a) => {
        const b = captures.find(
          (c) =>
            c.scene === a.scene &&
            c.format === "spz" &&
            c.view === a.view &&
            c.yaw === a.yaw,
        )!;
        return {
          scene: a.scene,
          view: a.view,
          yaw: a.yaw,
          size: a.size,
          baseline: { hash: a.hash, quality: a.quality },
          candidate: { hash: b.hash, quality: b.quality },
          betweenRenders: quality(b.pixels, a.pixels, a.size[0], a.size[1]),
        };
      });
    const gl = viewer.renderers.gaussian.getContext(),
      debug = gl.getExtension("WEBGL_debug_renderer_info");
    document.querySelector("#result")!.textContent = JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        baselineCommit: "db828fa",
        spark: "2.4.0",
        inputs: "prefetched in-memory model bytes, 64KiB chunks",
        order: qualityOnly
          ? "quality captures only; no timing samples"
          : "ABBAABBA per scene; one warmup per format; quality afterwards",
        resolution: 768,
        lod: false,
        maxSh: 3,
        backgrounded,
        environment: {
          userAgent: navigator.userAgent,
          gpu: debug
            ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
        },
        assets: assetReport,
        rows,
        comparisons,
        errors,
      },
      null,
      2,
    );
    for (const scene of scenes) {
      const selected = captures.filter(
        (c) =>
          c.scene === scene &&
          c.view ===
            inputs.get(scene)!.data.views.find((v) => v.heldOut)!.image_name,
      );
      for (const yaw of [0, -0.08, 0.08]) {
        const title = document.createElement("h2");
        title.textContent = `${scene} · yaw ${yaw}`;
        const pair = document.createElement("div");
        pair.className = "pair";
        pair.id = `${scene}-${yaw}`;
        for (const c of selected.filter((c) => c.yaw === yaw)) {
          const figure = document.createElement("figure"),
            label = document.createElement("figcaption"),
            img = new Image();
          label.textContent =
            c.format === "ply" ? "gzip PLY 基线" : "SPZ3 候选";
          img.src = c.image;
          figure.append(label, img);
          pair.append(figure);
        }
        document.querySelector("#gallery")!.append(title, pair);
      }
    }
    viewer.clear();
    for (const id of ["show", "orbit", "reset"]) button(id).disabled = false;
    status.textContent = `Complete; errors=${errors.length}; backgrounded=${backgrounded}`;
  } catch (e) {
    status.textContent = "FAILED: " + String(e);
  }
};
button("show").onclick = async () => {
  const scene = document.querySelector<HTMLSelectElement>("#scene")!.value;
  const format = document.querySelector<HTMLSelectElement>("#format")!.value;
  await viewer.load(scene + (format === "spz" ? "-spz" : ""));
  status.textContent = `Viewing ${scene} ${format}`;
};
button("orbit").onclick = () => viewer.orbit(true);
button("reset").onclick = () => viewer.orbit(false);
window.addEventListener(
  "pagehide",
  () => {
    viewer.dispose();
    window.fetch = originalFetch;
  },
  { once: true },
);
