import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { CompareViewer } from "../../src/viewer";
import { readPlyResponse } from "../../src/model-bytes";
import { quality } from "../../src/metrics";
import { hashHex, sha256 } from "../helpers/paired-model";
import { ownedChunkStream } from "../helpers/owned-chunk-stream";

type Mode = "fileBytes" | "stream";
const run = document.querySelector<HTMLButtonElement>("#run")!, status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const hash = async (bytes: Uint8Array) => hashHex(await sha256(bytes));
const median = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b), i = sorted.length / 2; return (sorted[i-1] + sorted[i]) / 2; };
const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
viewer.playing = false;
let active: SplatMesh | undefined;
let control: SplatMesh | undefined;
function release() { if (!active) return; viewer.scenes.gaussian.remove(active); if (viewer.gaussian === active) viewer.gaussian = undefined; active.dispose(); active = undefined; }
const make = (bytes: Uint8Array, mode: Mode) => new SplatMesh({
  ...(mode === "fileBytes" ? { fileBytes: bytes } : { stream: ownedChunkStream(bytes), streamLength: bytes.length }),
  fileType: SplatFileType.PLY, extSplats: true, enableLod: false, lod: false,
});
const originalPost = Worker.prototype.postMessage;
let trace: { name: string; bytes: number; detached: boolean }[] | undefined;
function beginTrace() {
  trace = [];
  Worker.prototype.postMessage = function(message, options) {
    const data = message as { name?: string; args?: { fileBytes?: Uint8Array; chunk?: Uint8Array } };
    const buffer = data.name === "loadExtSplats" ? data.args?.fileBytes : data.name === "nextChunk" ? data.args?.chunk : undefined;
    const bytes = buffer?.byteLength;
    originalPost.call(this, message, options as StructuredSerializeOptions);
    if (buffer && bytes) trace!.push({ name: data.name!, bytes, detached: buffer.byteLength === 0 });
  };
}
function endTrace() { Worker.prototype.postMessage = originalPost; const result = trace!; trace = undefined; return result; }
run.onclick = async () => {
  run.disabled = true; errors.length = 0;
  for (const selector of ["#summary", "#gallery", "#result"]) document.querySelector(selector)!.replaceChildren();
  (document.querySelector("#views") as HTMLElement).hidden = false;
  const samples: {scene: string; mode: Mode; index: number; initializeMs: number; settleMs: number; totalMs: number}[] = [];
  const transfers: {scene: string; mode: Mode; inputBytes: number; messages: {name: string; bytes: number; detached: boolean}[]}[] = [];
  const comparisons: unknown[] = [], assets: unknown[] = [], attributes: unknown[] = [];
  let created = 0, disposed = 0;
  let backgrounded = document.hidden;
  const visibility = () => { backgrounded ||= document.hidden; };
  document.addEventListener("visibilitychange", visibility);
  try {
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: prepare baseline`;
      await viewer.load(scene); viewer.playing = false;
      const baseline = viewer.gaussian!; control = baseline;
      const views = viewer.data!.views.filter(v => v.heldOut), manifest = viewer.data!;
      const bytes = new Uint8Array(await readPlyResponse(await fetch(`/scenes/${scene}/${manifest.gaussian.url}`), undefined, manifest.gaussian.decodedBytes));
      const expected = prior.assets.find((x: {scene: string}) => x.scene === scene);
      assert(await hash(bytes) === expected.plySha256, "Source hash mismatch");
      assets.push({ scene, decodedBytes: bytes.length, sha256: expected.plySha256, count: baseline.numSplats });
      const checkPixels = async (mode: Mode, viewIndex: number, yaw: number, sample: number | null) => {
        const view = views[viewIndex]; viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
        const rgba = viewer.pixels("gaussian"), digest = await hash(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
        const control = prior.comparisons.find((x: {scene: string; variant: string; view: string; yaw: number}) => x.scene === scene && x.variant === "original" && x.view === view.image_name && x.yaw === yaw);
        assert(digest === control?.hash, "Pixel mismatch");
        comparisons.push({scene, mode, sample, view: view.image_name, yaw, hash: digest, matchesOriginal: true,
          quality: sample === null && yaw === 0 ? quality(rgba, await viewer.reference(view), viewer.width, viewer.height) : null });
      };
      let baselineAttributes: string[] | undefined;
      const order: Mode[] = ["fileBytes", "stream", "fileBytes", "stream", "stream", "fileBytes", "fileBytes", "stream", "stream", "fileBytes"];
      for (const [index, mode] of order.entries()) {
        status.textContent = `${scene}: ${mode} ${index < 2 ? "warmup / transfer trace" : `sample ${index-1}/8`}`;
        viewer.setView(views[0]);
        const instrumented = index < 2;
        if (instrumented) beginTrace();
        let traceResult: ReturnType<typeof endTrace> | undefined;
        const start = performance.now(); const model = make(bytes, mode); created++;
        try { await model.initialized; } catch (error) { model.dispose(); disposed++; throw error; }
        finally { if (instrumented) traceResult = endTrace(); }
        const initialized = performance.now();
        active = model;
        assert(model.numSplats === baseline.numSplats && model.extSplats!.getNumSh() === 3, "Count/SH mismatch");
        model.maxSh = 3; model.updateGenerator(); viewer.scenes.gaussian.remove(baseline);
        viewer.gaussian = model; viewer.scenes.gaussian.add(model);
        await viewer.settle(); const settled = performance.now();
        if (instrumented) {
          assert(traceResult!.every(m => m.detached) && traceResult!.reduce((sum,m) => sum + m.bytes, 0) === bytes.length, "Transfer count mismatch");
          assert(mode === "fileBytes" ? traceResult!.length === 1 : traceResult!.every(m => m.bytes <= 1024*1024), "Transfer bound mismatch");
          transfers.push({scene, mode, inputBytes: bytes.length, messages: traceResult!});
          const digests = await Promise.all(model.extSplats!.extArrays.map(a => hash(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))));
          if (mode === "fileBytes") baselineAttributes = digests;
          else assert(JSON.stringify(digests) === JSON.stringify(baselineAttributes), "Decoded attribute mismatch");
          attributes.push({scene, mode, sha256: digests});
          for (const [viewIndex] of views.entries()) for (const yaw of viewIndex === 0 ? [0,-.08,.08] : [0]) await checkPixels(mode, viewIndex, yaw, null);
          viewer.setView(views[0]); await viewer.settle();
          const figure = document.createElement("figure"), caption = document.createElement("figcaption"), img = new Image();
          caption.textContent = `${scene} · ${mode === "stream" ? "1MiB 分块" : "完整输入"}`;
          img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92); figure.append(caption,img); document.querySelector("#gallery")!.append(figure);
        } else {
          assert(!backgrounded, "Backgrounded timing sample");
          samples.push({scene, mode, index:index-2, initializeMs: initialized-start, settleMs:settled-initialized, totalMs:settled-start});
          await checkPixels(mode, 0, 0, index-2);
        }
        release(); disposed++; viewer.gaussian = baseline; viewer.scenes.gaussian.add(baseline); await viewer.settle();
      }
      assert(await hash(bytes) === expected.plySha256, "Input buffer changed/detached");
      viewer.clear(); control = undefined;
    }
    assert(created === disposed && !errors.length, "Leaked model or browser error");
    const summary = [];
    for (const scene of ["pipes", "office"]) for (const mode of ["fileBytes", "stream"] as Mode[]) {
      const group = samples.filter(s => s.scene === scene && s.mode === mode), transfer = transfers.find(t => t.scene === scene && t.mode === mode)!;
      const row = {scene, mode, initializeMs:median(group.map(s=>s.initializeMs)), totalMs:median(group.map(s=>s.totalMs)), maxInputTransferBytes:Math.max(...transfer.messages.map(m=>m.bytes))}; summary.push(row);
      const tr = document.createElement("tr"); for (const value of [scene,mode,row.initializeMs.toFixed(2),row.totalMs.toFixed(2),(row.maxInputTransferBytes/1048576).toFixed(2)]) { const td = document.createElement("td"); td.textContent=value; tr.append(td); } document.querySelector("#summary")!.append(tr);
    }
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const report = {createdAt:new Date().toISOString(),baselineCommit:"29414b4",spark:"2.4.0",resolution:768,maxSh:3,lod:false,
      environment:{userAgent:navigator.userAgent,gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),backgrounded},
      method:"Preloaded validated decoded PLY; warm renderer/WASM; fresh model per sample, serial ABBAABBA. Two instrumented warmups per scene excluded from timing. No network, gzip, cold startup, peak memory, GPU query or presentation measurement. Stream copies owned 1MiB chunks; total input bytes unchanged. Four quiet frames and Mesh submission define total endpoint.",
      chunkBytes:1048576, assets, summary, samples, transfers, attributes, comparisons, created, disposed, errors};
    document.querySelector("#result")!.textContent = JSON.stringify(report,null,2);
    (document.querySelector("#views") as HTMLElement).hidden=true;
    status.textContent=`Complete; samples=${samples.length}; pixels=${comparisons.length}; disposed=${disposed}/${created}; errors=${errors.length}`;
  } catch(error) { status.textContent=`FAILED: ${error}`; }
  finally {
    Worker.prototype.postMessage = originalPost; release();
    if (control) { viewer.gaussian = control; viewer.scenes.gaussian.add(control); }
    viewer.clear(); control = undefined;
    document.removeEventListener("visibilitychange", visibility); run.disabled = false;
  }
};
window.addEventListener("pagehide",()=>{release();viewer.dispose();},{once:true});
