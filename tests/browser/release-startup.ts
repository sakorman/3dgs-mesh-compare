import {PairedModelLoader, hashHex, sha256, type ModelFormat, type PairedSpec} from "../helpers/paired-model";
import type {SceneData} from "../../src/types";
import type {SplatMesh} from "@sparkjsdev/spark";

const params = new URLSearchParams(location.search), scene = params.get("scene") ?? "pipes";
const variant = params.get("variant") ?? "rebuilt", documentIndex = Number(params.get("doc") ?? 0);
const status = document.querySelector("#status")!, button = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [], visibility: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
document.addEventListener("visibilitychange", () => visibility.push(document.visibilityState));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
const hash = async (b: Uint8Array) => hashHex(await sha256(b));
const compiles: {start: number; end?: number; bytes: number}[] = [];
const compile = WebAssembly.compile.bind(WebAssembly);
WebAssembly.compile = async bytes => {
  const row = {start:performance.now(),bytes:bytes.byteLength,end:undefined as number|undefined}; compiles.push(row);
  try { return await compile(bytes); } finally { row.end = performance.now(); }
};
type Call = {name:string; id?:number; start:number; end?:number; error?:boolean};
const workers: {created:number; terminated?:number; calls:Call[]}[] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  row = {created:performance.now(),terminated:undefined as number|undefined,calls:[] as Call[]};
  constructor(url:string|URL, options?:WorkerOptions) {
    super(url,options); workers.push(this.row);
    this.addEventListener("message", e => {
      if (e.data.status !== undefined) return;
      const call = this.row.calls.find(c => c.id !== undefined && c.id === e.data.id);
      if (call) {call.end=performance.now(); call.error=e.data.error !== undefined;}
    });
  }
  override postMessage(message:{name:string;id?:number},options?:Transferable[]|StructuredSerializeOptions) {
    this.row.calls.push({name:message.name,id:message.id,start:performance.now()});
    if(Array.isArray(options)) super.postMessage(message,options); else super.postMessage(message,options);
  }
  override terminate() {this.row.terminated=performance.now(); super.terminate();}
};

button.onclick = async () => {
  button.disabled=true;
  let viewer:import("../../src/viewer").CompareViewer|undefined, loader:PairedModelLoader<SplatMesh>|undefined;
  const samples:object[]=[], controls:object[]=[], attributes:object[]=[];
  const resources:{model:SplatMesh;disposed:number}[]=[];
  try {
    assert(["pipes","office"].includes(scene) && ["rebuilt","scoped"].includes(variant) && !document.hidden,"Invalid state");
    status.textContent="读取清单与相机（计时外）";
    const manifest=await (await fetch("/manifest.json")).json();
    const build=manifest.variants.find((v:{variant:string})=>v.variant===variant);
    const prior=await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const oldAttrs=await (await fetch("/docs/benchmarks/sh-scoped-2026-10-31.json")).json();
    const expectedAttrs=oldAttrs.experiments.find((e:{prefix:string})=>e.prefix==="scoped-spz")
      .documents.find((d:{scene:string})=>d.scene===scene).attributeControls[0].attributes;
    const asset=prior.assets.find((a:{scene:string})=>a.scene===scene);
    const data:SceneData=await (await fetch(`/scenes/${scene}/scene.json`)).json();
    const views=data.views.filter(v=>v.heldOut), run=crypto.randomUUID();
    const url=(kind:string,digest:string)=>`/__model_http/${run}/shared/${scene}/${kind}?sha256=${digest}&sample=first`;
    const spec:PairedSpec={count:asset.count,spzSha256:asset.spzSha256,alphaRawSha256:asset.alphaRawSha256,plySha256:asset.plySha256,
      spzUrl:url("spz",asset.spzSha256),alphaUrl:url("alpha",asset.alphaRawSha256),plyUrl:url("ply",asset.plySha256)};
    assert(Number(workers.length)===0 && Number(compiles.length)===0,"Runtime already initialized");
    performance.clearResourceTimings();
    status.textContent="首次导入运行时与 HTTP 加载";
    const start=performance.now();
    const runtimeUrl=build.url+"?run="+run;
    const runtime: typeof import("../../src/viewer") & typeof import("@sparkjsdev/spark") & {initialization:Promise<unknown>} =
      await import(/* @vite-ignore */ runtimeUrl);
    const imported=performance.now(); await runtime.initialization; const ready=performance.now();
    viewer=new runtime.CompareViewer(document.querySelector("#left")!,document.querySelector("#right")!);
    viewer.playing=false; viewer.data=data; viewer.setView(views[0]); const constructed=performance.now();
    loader=new PairedModelLoader({
      fetch:(url,signal)=>fetch(url,{signal}),
      create(bytes,format:ModelFormat) {
        assert(format==="spz","Unexpected fallback");
        const model=new runtime.SplatMesh({fileBytes:bytes,fileType:runtime.SplatFileType.SPZ,extSplats:true,enableLod:false,lod:false});
        resources.push({model,disposed:0}); return model;
      },
      initialized:model=>model.initialized,
      attributes:model=>({count:model.numSplats,sh:model.extSplats!.getNumSh(),words:model.extSplats!.extArrays[0]}),
      prepare(model) {model.extSplats!.textures[0].needsUpdate=true;model.maxSh=3;model.updateGenerator();},
      publish(model) {viewer!.gaussian=model;viewer!.scenes.gaussian.add(model);},
      dispose(model) {viewer!.scenes.gaussian.remove(model);if(viewer!.gaussian===model)viewer!.gaussian=undefined;
        model.dispose();resources.find(r=>r.model===model)!.disposed++;}
    });
    for(let index=0;index<2;index++) {
      if(index) {loader.clear();viewer.setView(views[0]);status.textContent="同页运行时与 HTTP 缓存复用";}
      const workersBefore=workers.length, loadStart=performance.now();
      const result=await loader.load(spec), loaded=performance.now();
      await viewer.settle(); const end=performance.now();
      samples.push({index,state:index?"warm-runtime-cache-hit":"first-runtime-cache-miss",loadStart,loadMs:loaded-loadStart,
        settleMs:end-loaded,totalMs:end-(index?loadStart:start),modelWaitMs:end-loadStart,
        runtimeImportMs:index?0:imported-start,wasmReadyWaitMs:index?0:ready-imported,
        constructMs:index?0:constructed-ready,newWorkers:workers.length-workersBefore,phases:result.phases});
      assert(!document.hidden && visibility.length===0,"Visibility changed");
      const ext=viewer.gaussian!.extSplats!;
      const arrays=[...ext.extArrays,ext.extra.sh1!,ext.extra.sh2!,ext.extra.sh3a!,ext.extra.sh3b!];
      const row=[];
      for(const a of arrays) row.push({bytes:a.byteLength,sha256:await hash(new Uint8Array(a.buffer,a.byteOffset,a.byteLength))});
      assert(JSON.stringify(row)===JSON.stringify(expectedAttrs),"Attribute mismatch");attributes.push({index,buffers:row});
      for(const [i,view] of (index?views:views.slice(0,1)).entries()) for(const yaw of index&&i===0?[0,-.08,.08]:[0]) {
        viewer.setView(view);viewer.camera.rotateY(yaw);await viewer.settle();
        const p=viewer.pixels("gaussian"), digest=await hash(new Uint8Array(p.buffer,p.byteOffset,p.byteLength));
        const previous=prior.comparisons.find((c:{scene:string;variant:string;view:string;yaw:number})=>
          c.scene===scene && c.variant==="alpha16" && c.view===view.image_name && c.yaw===yaw);
        assert(digest===previous.hash,"Pixel mismatch");controls.push({index,view:view.image_name,yaw,hash:digest});
        if(index===1&&i===0&&yaw===0) {
          const img=new Image();img.src=viewer.renderers.gaussian.domElement.toDataURL("image/png");
          img.alt=scene+" "+variant+" SH3";document.querySelector("#gallery")!.append(img);
        }
      }
    }
    const network=await (await fetch(`/__model_http/${run}/records`,{cache:"no-store"})).json();
    const timings=performance.getEntriesByType("resource").filter(e=>e.name.includes(run)||e.name.includes("/assets/"))
      .map(e=>(e as PerformanceResourceTiming).toJSON());
    assert(network.length===2 && network.every((r:{status:number;finished:boolean;closed:boolean})=>r.status===200&&r.finished&&r.closed),"Cache/network mismatch");
    assert(compiles.length===1 && compiles[0].bytes===build.wasmBytes && compiles[0].end!==undefined,"Expected one selected WASM compile");
    assert(workers.flatMap(w=>w.calls).filter(c=>c.name==="loadExtSplats").length===2,"Decode count mismatch");
    const gl=viewer.renderers.gaussian.getContext(), debug=gl.getExtension("WEBGL_debug_renderer_info");
    const environment={userAgent:navigator.userAgent,gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),visibility};
    loader.dispose();viewer.dispose();
    assert(resources.length===2&&resources.every(r=>r.disposed===1)&&errors.length===0,"Cleanup or browser errors");
    const report={createdAt:new Date().toISOString(),baseline:"2cc5134",
      scene,variant,documentIndex,manifest,asset,resolution:[viewer.width,viewer.height],environment,
      samples,controls,attributes,compiles,workers,network,timings,disposedModels:resources.length,errors,
      method:"New document and selected static minified Vite bundle, gzip level 6, code no-store and shared Three.js chunk. No development transformation or source maps. One selected main WASM compile; matching bindings in main/worker. No input preloading. First interval includes dynamic import/WASM readiness, viewer construction, shared 5MiB/s HTTP model pair with 40ms server hold, initialization and settled draw submission. Second sample same runtime and exact cached URLs. Browser process/JIT/shader caches not reset; no navigation-cold, public-CDN, GPU time, memory peak or screen-presentation claim."};
    document.querySelector("#result")!.textContent=JSON.stringify(report,null,2);
    const saved=await fetch("/__release_result",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(report)});
    assert(saved.status===201,"Result persistence failed: "+await saved.text());
    const first=samples[0] as {totalMs:number},warm=samples[1] as {totalMs:number};
    document.querySelector("#summary")!.textContent=`${scene} · ${variant}：首次 ${first.totalMs.toFixed(1)}ms；缓存复用 ${warm.totalMs.toFixed(1)}ms；属性与画面一致。`;
    status.textContent=`Complete; compile=1; models=2; pixels=${controls.length}`;
  } catch(error) {
    document.querySelector("#result")!.textContent=JSON.stringify({failed:String(error),samples,controls,attributes,compiles,workers,errors},null,2);
    status.textContent="FAILED: "+error;
  } finally {loader?.dispose();viewer?.dispose();WebAssembly.compile=compile;}
};
