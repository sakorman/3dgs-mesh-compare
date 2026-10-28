import { readPlyResponse } from "../../src/model-bytes";
import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
import { hashHex, sha256 } from "../helpers/paired-model";

const button = document.querySelector<HTMLButtonElement>("#run")!, status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
button.onclick = async () => {
  button.disabled = true; errors.length = 0;
  document.querySelector("#gallery")!.replaceChildren();
  const cases: unknown[] = [], files: unknown[] = [], failures: unknown[] = [], comparisons: unknown[] = [];
  try {
    const baselineUrl = "/.qa/ply-size/model-bytes-baseline.ts";
    const oldModule = await import(/* @vite-ignore */ baselineUrl);
    const readers = { baseline: oldModule.readPlyResponse as typeof readPlyResponse, bounded: readPlyResponse };
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const raw = new Uint8Array(1024 * 1024); let seed = 42;
    for (let i = 0; i < raw.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i] = seed & 255; }
    raw.set(new TextEncoder().encode("ply\n"));
    for (const encoding of ["plain", "gzip"] as const) {
      const sourceBytes = encoding === "gzip" ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()) : raw;
      for (const [variant, read] of Object.entries(readers)) {
        let offset = 0, cancelled = false;
        const response = new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset === sourceBytes.length) { controller.close(); return; }
            await new Promise(resolve => setTimeout(resolve, 0));
            if (cancelled) return;
            const end = Math.min(offset + 1024, sourceBytes.length);
            controller.enqueue(sourceBytes.subarray(offset, end)); offset = end;
          }, cancel() { cancelled = true; },
        }, { highWaterMark: 0 }));
        let resultBytes: number | null = null, error: string | null = null;
        try { resultBytes = (await read(response, undefined, 64)).byteLength; }
        catch (reason) { error = String(reason); }
        assert(variant === "baseline" ? resultBytes === raw.length : error?.includes("超出场景记录") && offset < sourceBytes.length && cancelled,
          `Unexpected ${variant}/${encoding}`);
        cases.push({ variant, encoding, expectedBytes: 64, sourceBytes: sourceBytes.length, suppliedBytes: offset, resultBytes, error, cancelled, unlocked: !response.body!.locked });
      }
    }
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: exact bytes`;
      const manifest = await (await fetch(`/scenes/${scene}/scene.json`)).json();
      const a = prior.assets.find((x: { scene: string }) => x.scene === scene);
      for (const mode of ["gzip-file", "http-inflated"]) {
        const url = mode === "gzip-file" ? `/.qa/${scene}-gaussians.bin` : `/scenes/${scene}/${manifest.gaussian.url}`;
        const bytes = new Uint8Array(await readPlyResponse(await fetch(url), undefined, manifest.gaussian.decodedBytes));
        const digest = await hash(bytes); assert(digest === a.plySha256 && bytes.length === manifest.gaussian.decodedBytes, "Decoded bytes changed");
        files.push({ scene, mode, decodedBytes: bytes.length, sha256: digest });
      }
    }
    for (const kind of ["over", "short", "missing"]) {
      status.textContent = `viewer: invalid ${kind}`;
      let error: string | null = null;
      try { await viewer.load(`size-${kind}`); } catch (reason) { error = String(reason); }
      assert(error?.includes("高斯模型") && !viewer.gaussian && !viewer.data && !viewer.loadTimings, "Invalid model attached or kept timings");
      failures.push({ kind, error, gaussianAbsent: !viewer.gaussian, dataAbsent: !viewer.data, timingAbsent: !viewer.loadTimings });
    }
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: recovery and pixels`;
      await viewer.load(scene); viewer.playing = false;
      const views = viewer.data!.views.filter(v => v.heldOut);
      for (const [index, view] of views.entries()) {
        for (const yaw of index === 0 ? [0, -0.08, 0.08] : [0]) {
          viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
          const pixels = viewer.pixels("gaussian"), digest = await hash(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
          const expected = prior.comparisons.find((x: { scene: string; variant: string; view: string; yaw: number }) =>
            x.scene === scene && x.variant === "original" && x.view === view.image_name && x.yaw === yaw);
          assert(digest === expected?.hash, "Pixel regression");
          comparisons.push({ scene, view: view.image_name, yaw, hash: digest, matchesPrevious: true,
            quality: yaw === 0 ? quality(pixels, await viewer.reference(view), viewer.width, viewer.height) : null });
          if (index === 0 && yaw === 0) {
            const figure = document.createElement("figure"), img = new Image(), caption = document.createElement("figcaption");
            caption.textContent = `${scene} · 原始 PLY · 长度检查后`; img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92);
            figure.append(caption, img); document.querySelector("#gallery")!.append(figure);
          }
        }
      }
    }
    assert(!errors.length, "Browser errors");
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const report = { createdAt: new Date().toISOString(), baselineCommit: "5ceb8c5", spark: "2.4.0", resolution: 768, maxSh: 3, lod: false,
      environment: { userAgent: navigator.userAgent, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) },
      method: "Synthetic streamed source counts are bytes supplied to the reader, not network or peak memory. Actual files use gzip-file and HTTP-inflated paths; viewer failures use real HTTP metadata with invalid decoded lengths. No performance or memory benchmark. Pixel checks match prior original PLY controls.", cases, files, failures, comparisons, errors };
    document.querySelector("#result")!.textContent = JSON.stringify(report, null, 2);
    document.querySelector("#checks")!.textContent = JSON.stringify({ cases, files, failures }, null, 2);
    status.textContent = `Complete; boundary cases=${cases.length}; files=${files.length}; failures=${failures.length}; pixels=${comparisons.length}; errors=${errors.length}`;
  } catch (error) { status.textContent = `FAILED: ${error}`; }
  finally { viewer.clear(); button.disabled = false; }
};
window.addEventListener("pagehide", () => viewer.dispose(), { once: true });
