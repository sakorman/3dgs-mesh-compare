import { benchmark as fixed } from "../../src/benchmark";
import { CompareViewer } from "../../src/viewer";
import type { Backend } from "../../src/types";
import { hashHex, sha256 } from "../helpers/paired-model";

const baseline = new URLSearchParams(location.search).get("variant") === "baseline";
const baselinePath = "/.qa/benchmark-query/benchmark-before.ts";
const measure: typeof fixed = baseline ? (await import(/* @vite-ignore */ baselinePath)).benchmark : fixed;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector("#status")!;
const output = document.querySelector("#result")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
const kinds = ["gaussian", "mesh"] as const;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
button.onclick = async () => {
  button.disabled = true;
  const viewer = new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
  const records: object[] = [], pixels: object[] = [], retries: object[] = [];
  const tracked = kinds.map(kind => {
    const gl = viewer.renderers[kind].getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    assert(ext, "Timer extension required for this fixture");
    const create = gl.createQuery.bind(gl), remove = gl.deleteQuery.bind(gl);
    const live = new Set<WebGLQuery>();
    let created = 0, deleted = 0, skipNext = false;
    Object.defineProperty(gl, "createQuery", {configurable: true, writable: true, value: () => {
      if (skipNext) { skipNext = false; return null; }
      const q = create();
      if (q) { live.add(q); created++; }
      return q;
    }});
    gl.deleteQuery = q => { if (q && live.delete(q)) deleted++; remove(q); };
    const active = (): WebGLQuery | null => gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY);
    return {kind, gl, ext, live, active, count: () => ({created, deleted}),
      skip: () => {skipNext = true;},
      cleanup: () => {if(active()) gl.endQuery(ext.TIME_ELAPSED_EXT);for(const q of live) gl.deleteQuery(q);},
      restore: () => {gl.createQuery = create;gl.deleteQuery = remove;}};
  });
  const capture = async () => {
    const rows: {view: string; kind: Backend; hash: string}[] = [];
    viewer.playing = false;
    for (const view of viewer.data!.views.filter(v => v.heldOut)) {
      viewer.setView(view); await viewer.settle();
      for (const kind of kinds) {
        const rgba = viewer.pixels(kind);
        rows.push({view: view.image_name, kind, hash: hashHex(await sha256(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)))});
      }
    }
    return rows;
  };
  try {
    for (const scene of ["pipes", "office"]) {
      status.textContent = scene + ": loading";
      await viewer.load(scene);
      const before = await capture();
      viewer.setView(viewer.data!.views.find(v => v.heldOut)!);
      await viewer.settle();
      for (const failedKind of kinds) {
        status.textContent = scene + ": fail " + failedKind;
        const target = tracked.find(x => x.kind === failedKind)!;
        const counts = target.count();
        const render = viewer.render.bind(viewer), settle = viewer.settle.bind(viewer);
        const failure = new Error("controlled render failure");
        let draws = 0, sampling = false, rejected = false, activeAtFailure = false;
        viewer.settle = async signal => {await settle(signal);sampling = true;};
        viewer.render = kind => {
          render(kind);
          if (sampling && kind === failedKind && ++draws === 14) {
            activeAtFailure = target.active() !== null;
            throw failure;
          }
        };
        try { await measure(viewer, new AbortController().signal, () => {}); }
        catch (error) {assert(error === failure, "Original error changed");rejected = true;}
        finally {viewer.playing = false;viewer.render = render;viewer.settle = settle;}
        const activeAfter = target.active() !== null;
        const remaining = target.live.size;
        const glError = target.gl.getError();
        const after = target.count();
        // Probe the native GL state before any fixture cleanup.
        const probe = target.gl.createQuery()!;
        target.gl.beginQuery(target.ext.TIME_ELAPSED_EXT, probe);
        const retryBeginError = target.gl.getError();
        const probeStarted = target.active() === probe;
        if (probeStarted) target.gl.endQuery(target.ext.TIME_ELAPSED_EXT);
        target.gl.deleteQuery(probe);
        const row = {scene, failedKind, rejected, activeAtFailure, activeAfter, remaining,
          allocated: after.created - counts.created, deleted: after.deleted - counts.deleted,
          glError, retryBeginError, probeStarted};
        records.push(row);
        if (!baseline) assert(rejected && activeAtFailure && !activeAfter && !remaining && glError === 0 && retryBeginError === 0 && probeStarted, "Query cleanup failed");
        // Baseline leaks are cleaned only after recording the native probe.
        for (const t of tracked) t.cleanup();
      }
      if (!baseline) for (const skipAllocation of [false, true]) {
        status.textContent = scene + ": retry " + (skipAllocation ? "without first query" : "normal");
        if (skipAllocation) tracked[0].skip();
        const report = await measure(viewer, new AbortController().signal, s => {status.textContent = scene + ": " + s;});
        viewer.playing = false;
        const row = {scene, skipAllocation, samples: kinds.map(kind => ({
          kind, count: report[kind].samples.length,
          gpuSamples: report[kind].samples.filter(s => s.gpuMs !== null).length,
          firstGpuMs: report[kind].samples[0].gpuMs,
        })), disjoint: report.protocol.gpuDisjoint,
          resources: tracked.map(t => ({kind:t.kind,active:!!t.active(),remaining:t.live.size,glError:t.gl.getError(),...t.count()}))};
        retries.push(row);
        assert(row.samples.every(s => s.count === 160), "Incomplete retry");
        assert(row.resources.every(r => !r.active && !r.remaining && r.created === r.deleted && r.glError === 0), "Retry leaked resources or raised GL error");
        if (skipAllocation) assert(row.samples[0].firstGpuMs === null, "Missing allocation produced GPU time");
        if (!Object.values(row.disjoint).some(Boolean)) assert(row.samples.every(s => s.gpuSamples === (skipAllocation && s.kind === "gaussian" ? 159 : 160)), "Missing GPU samples");
      }
      const after = await capture();
      for (let i = 0; i < before.length; i++) {
        assert(before[i].hash === after[i].hash, "Pixels changed");
        pixels.push({scene, ...before[i], afterHash: after[i].hash, matches: true});
      }
    }
    status.textContent = baseline ? "Baseline recorded" : "PASS";
    output.textContent = JSON.stringify({createdAt:new Date().toISOString(),variant:baseline?"baseline":"fixed",
      baselineCommit:"6dd9941fed6d8c7700027ba8a0597cdbdd61e37f",userAgent:navigator.userAgent,
      method:"Real WebGL2 and unchanged full-SH3 models at 768px. Controlled throw after the second measured draw; native CURRENT_QUERY and retry beginQuery checked before fixture cleanup. Query counts cover application allocations, not GPU memory. Timing values are diagnostics, not speed comparisons.",
      records,retries,pixels,errors},null,2);
  } catch (error) {status.textContent = "FAILED"; output.textContent = JSON.stringify({error:String(error),records,retries,pixels,errors},null,2);}
  finally {for(const t of tracked){t.cleanup();t.restore();} viewer.dispose();}
};
