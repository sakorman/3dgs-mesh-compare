import { CompareViewer } from "../../src/viewer";
import { hashHex, sha256 } from "../helpers/paired-model";

const baseline = new URLSearchParams(location.search).get("variant") === "baseline";
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const output = document.querySelector("#qa-result")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
let viewer!: CompareViewer;
const load = CompareViewer.prototype.load;
CompareViewer.prototype.load = function(id) { viewer = this; return load.call(this, id); };
const baselinePath = "/.qa/benchmark-cancel/main-before.ts";
if (baseline) await import(/* @vite-ignore */ baselinePath);
else await import("../../src/main");
run.disabled = false;
output.textContent = `Ready: ${baseline ? "baseline" : "fixed"}`;
run.onclick = async () => {
  run.disabled = true;
  const records: object[] = [], pixels: object[] = [];
  const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
  const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
  try {
    const prior = await (await fetch("/docs/benchmarks/stream-input-2026-10-28.json")).json();
    for (const scene of ["pipes", "office"]) {
      if (viewer.data?.id !== scene) {
        document.querySelector<HTMLButtonElement>(`[data-scene="${scene}"]`)!.click();
        while (document.querySelector<HTMLButtonElement>("#bench")!.disabled) await new Promise(r => setTimeout(r, 20));
      }
      for (const scenario of ["settle", "first-frame", "sample-hidden", ...(scene === "office" ? ["sample-dispose"] : [])]) {
        output.textContent = `${scene}: ${scenario}`;
        let held = scenario === "settle", id = -1, entered!: () => void;
        const blocked = new Promise<void>(resolve => {entered=resolve;});
        const frames = new Map<number, FrameRequestCallback>();
        window.requestAnimationFrame = callback => {
          if (!held) return request(callback);
          const handle = --id; frames.set(handle, callback); entered(); return handle;
        };
        window.cancelAnimationFrame = handle => { if (!frames.delete(handle)) cancel(handle); };
        const settle = viewer.settle.bind(viewer), render = viewer.render.bind(viewer);
        let sampling = false, draws = 0, interrupted = false, lateDraws = 0;
        viewer.settle = async signal => { await settle(signal); sampling = true; if (scenario === "first-frame") held = true; };
        viewer.render = kind => {
          if (interrupted) lateDraws++;
          render(kind);
          if (sampling && ++draws === 13 && scenario.startsWith("sample-")) held = true;
        };
        const gl = viewer.renderers.gaussian.getContext() as WebGL2RenderingContext, create = gl.createQuery.bind(gl), remove = gl.deleteQuery.bind(gl);
        const live = new Set<WebGLQuery>(); let allocated = 0, deleted = 0;
        gl.createQuery = () => { const q = create(); if(q) {live.add(q);allocated++;} return q; };
        gl.deleteQuery = q => { if(q && live.delete(q)) deleted++; remove(q); };
        const button = document.querySelector<HTMLButtonElement>("#bench")!, handler = button.onclick!;
        let finished!: Promise<unknown>, ended = false;
        button.onclick = function(event) { finished = Promise.resolve(handler.call(this,event)).finally(() => {ended=true;viewer.playing=false;}); };
        button.click();
        await blocked;
        interrupted = true;
        if (scenario === "sample-hidden") {
          Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});
          document.dispatchEvent(new Event("visibilitychange"));
        } else if (scenario === "sample-dispose") {
          window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:false}));
        } else document.querySelector<HTMLButtonElement>("#cancel")!.click();
        await new Promise(r => setTimeout(r,80));
        const row = {scene,scenario,endedWithoutFrame:ended,heldFrames:frames.size,allocatedQueries:allocated,
          deletedQueries:deleted,remainingQueries:live.size,lateDraws,controlsUnlocked:!button.disabled,
          cancelledStatus:document.querySelector("#status")!.textContent,disposed:viewer.disposed,
          performanceAbsent:["gs-cpu","gs-gpu","gs-fps","mesh-cpu","mesh-gpu","mesh-fps"].every(id=>document.getElementById(id)!.textContent==="—")};
        records.push(row);
        window.requestAnimationFrame=request; window.cancelAnimationFrame=cancel; held=false;
        for(const fn of frames.values()) request(fn); frames.clear(); await finished;
        viewer.settle=settle; viewer.render=render; gl.createQuery=create; gl.deleteQuery=remove; button.onclick=handler;
        if(hidden) Object.defineProperty(document,"hidden",hidden); else delete (document as {hidden?:boolean}).hidden;
        document.dispatchEvent(new Event("visibilitychange"));
        if(!baseline && (!row.endedWithoutFrame || row.remainingQueries || !row.performanceAbsent || row.heldFrames || (scenario==="sample-hidden" && row.lateDraws))) throw new Error(`Failed ${scene}/${scenario}`);
        if(!viewer.disposed) {
          viewer.playing=false;
          for(const view of viewer.data!.views.filter(v=>v.heldOut)) {
            viewer.setView(view); await viewer.settle();
            const rgba=viewer.pixels("gaussian"), hash=hashHex(await sha256(new Uint8Array(rgba.buffer,rgba.byteOffset,rgba.byteLength)));
            const expected=prior.comparisons.find((x:{scene:string;mode:string;view:string;yaw:number})=>x.scene===scene&&x.mode==="fileBytes"&&x.view===view.image_name&&x.yaw===0);
            if(hash!==expected?.hash) throw new Error("Pixel mismatch");
            pixels.push({scene,scenario,view:view.image_name,hash,matchesOriginal:true});
          }
          viewer.playing=true;
        }
      }
    }
    output.textContent=JSON.stringify({createdAt:new Date().toISOString(),variant:baseline?"baseline":"fixed",baselineCommit:"8190435",method:"Real models and WebGL2; animation callbacks held by fixture, synthetic visibility/pagehide. 80ms observation; not native background throttling, GPU speed or memory measurement.",records,pixels,errors},null,2);
  } catch(error) {output.textContent=`FAILED: ${error}\n${JSON.stringify({records,pixels,errors},null,2)}`;}
  finally { window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;if(hidden)Object.defineProperty(document,"hidden",hidden);else delete (document as {hidden?:boolean}).hidden; viewer.dispose(); }
};
