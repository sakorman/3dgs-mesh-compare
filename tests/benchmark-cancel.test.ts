import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { benchmark } from "../src/benchmark";
import type { CompareViewer } from "../src/viewer";

function fixture(t: TestContext, available = true) {
  const old = new Map<string, PropertyDescriptor | undefined>();
  const frames = new Map<number, FrameRequestCallback>(), queries = new Set<object>();
  let id=0, now=0, draws=0, created=0, deleted=0, settlementSignal:AbortSignal|undefined;
  for(const [key,value] of Object.entries({document:{hidden:false},
    requestAnimationFrame:(fn:FrameRequestCallback)=>{frames.set(++id,fn);return id;},
    cancelAnimationFrame:(id:number)=>{frames.delete(id);}})) {
    old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  t.after(()=>{for(const [key,value] of old) if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);});
  const gl={QUERY_RESULT_AVAILABLE:1, QUERY_RESULT:2,
    getExtension:()=>({TIME_ELAPSED_EXT:3,GPU_DISJOINT_EXT:4}), getParameter:()=>false,
    createQuery(){const q={};queries.add(q);created++;return q;},beginQuery(){},endQuery(){},
    getQueryParameter:(_:object,key:number)=>key===1?available:1000000,
    deleteQuery(q:object){assert(queries.delete(q));deleted++;},
  };
  const renderer={getContext:()=>gl,info:{render:{calls:1,triangles:2}}};
  const viewer={renderers:{gaussian:renderer,mesh:renderer},width:768,height:504,lost:false,disposed:false,playing:true,
    async settle(signal?:AbortSignal){settlementSignal=signal;},render(){draws++;}};
  const controller=new AbortController();
  const start=()=>benchmark(viewer as unknown as CompareViewer,controller.signal,()=>{});
  const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
  const tick=async()=>{now+=16;for(const [id,fn] of [...frames]){frames.delete(id);fn(now);}await flush();};
  return {viewer,controller,frames,queries,start,flush,tick,draws:()=>draws,created:()=>created,deleted:()=>deleted,settlementSignal:()=>settlementSignal};
}
test("cancellation reaches settlement and the initial sampling wait",async t=>{
  const f=fixture(t), done=f.start();await f.flush();
  assert.equal(f.settlementSignal(),f.controller.signal);assert.equal(f.frames.size,1);
  const rejected=assert.rejects(done,/测试已取消/);f.controller.abort();await rejected;
  assert.equal(f.frames.size,0);assert.equal(f.draws(),0);
});
for(const disposed of [false,true]) test(`cancel mid-sample cleans queries without another frame (disposed=${disposed})`,async t=>{
  const f=fixture(t),done=f.start();await f.flush();
  for(let i=0;i<13;i++)await f.tick();
  assert.equal(f.draws(),13);assert.equal(f.queries.size,1);
  const rejected=assert.rejects(done,/测试已取消/);f.viewer.disposed=disposed;f.controller.abort();await rejected;
  assert.equal(f.frames.size,0);assert.equal(f.queries.size,0);assert.equal(f.created(),f.deleted());assert.equal(f.draws(),13);
  assert.equal(f.viewer.playing,!disposed);
});
test("cancellation during final query collection cannot publish a partial report",async t=>{
  const f=fixture(t,false),done=f.start();await f.flush();
  while(f.draws()<416)await f.tick();await f.tick();
  assert(f.queries.size>0);assert.equal(f.frames.size,1);
  const rejected=assert.rejects(done,/测试已取消/);f.controller.abort();await rejected;
  assert.equal(f.frames.size+f.queries.size,0);assert.equal(f.created(),f.deleted());
});
test("normal sampling retains AB/BA rounds, 160 samples per backend and cleans queries",async t=>{
  const f=fixture(t),done=f.start();let ended=false;void done.finally(()=>{ended=true;});await f.flush();
  for(let i=0;!ended&&i<500;i++)await f.tick();
  assert(ended);const report=await done;
  assert.equal(report.gaussian.samples.length,160);assert.equal(report.mesh.samples.length,160);
  assert.equal(report.protocol.warmup,12);assert.equal(report.protocol.samplesPerRound,40);
  assert.equal(f.frames.size+f.queries.size,0);assert.equal(f.created(),320);assert.equal(f.created(),f.deleted());
});
