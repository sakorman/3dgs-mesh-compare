import test from "node:test";
import assert from "node:assert/strict";
import { settleFrames, type SettleEnvironment } from "../src/settle-frames";

export function fixture(hidden = false) {
  let now = 0, id = 0, draws = 0, busy = false;
  const events = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { fn: () => void; at: number }>();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const env: SettleEnvironment = {
    visibility: {
      get hidden() { return hidden; },
      addEventListener(type: string, fn: EventListenerOrEventListenerObject | null) { if (fn) listeners.add(fn); events.addEventListener(type, fn); },
      removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null) { if (fn) listeners.delete(fn); events.removeEventListener(type, fn); },
    },
    now: () => now,
    request(fn) { frames.set(++id, fn); return id; }, cancel(id) { frames.delete(id); },
    timer(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimer(id) { timers.delete(id); },
  };
  const controller = new AbortController();
  const start = () => settleFrames(() => { draws++; return busy; }, controller.signal, env);
  const advance = (ms: number) => { now += ms; for (const [key, t] of [...timers]) if (t.at <= now) { timers.delete(key); t.fn(); } };
  const tick = () => { advance(16); for (const [key, fn] of [...frames]) { frames.delete(key); fn(now); } };
  return { env, controller, frames, timers, listeners, start, advance, tick,
    hide(value: boolean) { hidden = value; events.dispatchEvent(new Event("visibilitychange")); },
    frameBeforeTimer(ms: number) { now += ms; for (const [key, fn] of [...frames]) { frames.delete(key); fn(now); } },
    busy(value: boolean) { busy = value; }, draws: () => draws,
    clean() { assert.equal(frames.size + timers.size + listeners.size, 0); },
  };
}

test("visible settlement primes and requires four consecutive quiet frames", async () => {
  const f = fixture(), done = f.start();
  f.tick(); f.tick(); f.busy(true); f.tick(); f.busy(false);
  for (let i = 0; i < 3; i++) f.tick();
  assert.equal(f.frames.size, 1); f.tick(); await done; f.clean();
});
test("hidden start and long background pause neither draw nor exhaust visible budget", async () => {
  const f = fixture(true), done = f.start();
  f.advance(20000); f.tick(); assert.equal(f.draws(), 0); assert.equal(f.timers.size, 0);
  f.hide(false); f.tick(); f.tick(); f.hide(true);
  const before = f.draws(); f.advance(20000); f.tick(); assert.equal(f.draws(), before);
  f.hide(false); for (let i = 0; i < 4; i++) f.tick(); await done; f.clean();
});
test("repeated background intervals preserve rather than reset the visible timeout", async () => {
  const f = fixture(); f.busy(true); const done = f.start();
  f.advance(8000); f.hide(true); f.advance(20000); f.hide(false); f.advance(6999);
  assert.equal(f.timers.size, 1);
  const rejected = assert.rejects(done, /高斯排序未就绪/); f.advance(1); await rejected; f.clean();
});
test("visible stalled animation frames still time out", async () => {
  const f = fixture(), done = f.start(), rejected = assert.rejects(done, /高斯排序未就绪/);
  f.advance(15000); await rejected; assert.equal(f.draws(), 0); f.clean();
});
for (const hidden of [false, true]) test(`abort without another frame cleans up (hidden=${hidden})`, async () => {
  const f = fixture(hidden), done = f.start(), rejected = assert.rejects(done, { name: "AbortError" });
  f.controller.abort(); await rejected; f.clean(); f.hide(false); f.tick(); assert.equal(f.draws(), 0);
});
test("already aborted input schedules nothing", async () => {
  const f = fixture(); f.controller.abort(); await assert.rejects(f.start(), { name: "AbortError" }); f.clean();
});
test("draw failure rejects and removes all scheduled work", async () => {
  const f = fixture(); const done = settleFrames(() => { throw new Error("draw failed"); }, f.controller.signal, f.env);
  const rejected = assert.rejects(done, /draw failed/); f.tick(); await rejected; f.clean();
});

test("a late frame before the deadline timer also clears the timer", async () => {
  const f = fixture(), done = f.start(), rejected = assert.rejects(done, /高斯排序未就绪/);
  f.frameBeforeTimer(15001); await rejected; f.clean();
});
