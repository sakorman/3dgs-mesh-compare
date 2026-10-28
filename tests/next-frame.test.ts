import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { nextFrame } from "../src/next-frame";

function fixture() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  const frames = {request(fn: FrameRequestCallback) {callbacks.set(++id,fn);return id;},cancel(id:number){callbacks.delete(id);}};
  return {callbacks,frames};
}
test("frame timestamp is preserved and the abort listener is removed",async()=>{
  const f=fixture(), c=new AbortController(), result=nextFrame(c.signal,f.frames);
  f.callbacks.get(1)!(123.5); assert.equal(await result,123.5);
  assert.equal(getEventListeners(c.signal,"abort").length,0);
});
test("abort rejects without a frame and cancels its queued callback",async()=>{
  const f=fixture(), c=new AbortController(), result=nextFrame(c.signal,f.frames);
  const late=f.callbacks.get(1)!, reason=new Error("stop");
  const rejected=assert.rejects(result,e=>e===reason); c.abort(reason); await rejected;
  assert.equal(f.callbacks.size,0); assert.equal(getEventListeners(c.signal,"abort").length,0);
  late(200); await assert.rejects(result,e=>e===reason);
});
test("already aborted input schedules no work",async()=>{
  const f=fixture(), c=new AbortController();c.abort();
  await assert.rejects(nextFrame(c.signal,f.frames),{name:"AbortError"});assert.equal(f.callbacks.size,0);
});
test("a scheduling error removes its abort listener",async()=>{
  const c=new AbortController();
  await assert.rejects(nextFrame(c.signal,{request(){throw new Error("queue failed");},cancel(){}}),/queue failed/);
  assert.equal(getEventListeners(c.signal,"abort").length,0);
});
test("callers without a cancellation signal keep the original timestamp behavior",async()=>{
  const f=fixture(),result=nextFrame(undefined,f.frames);f.callbacks.get(1)!(42);assert.equal(await result,42);
});
