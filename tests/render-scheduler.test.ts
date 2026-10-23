import test from "node:test";
import assert from "node:assert/strict";
import { RenderScheduler } from "../src/render-scheduler";
function fixture(draw: () => void) {
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const scheduler = new RenderScheduler(draw, {
    request: (callback) => {
      pending.set(++id, callback);
      return id;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
  });
  const tick = () => {
    const entries = [...pending.entries()];
    for (const [key, fn] of entries) {
      pending.delete(key);
      fn(0);
    }
  };
  return { scheduler, pending, tick };
}
test("many changes coalesce, then idle preview stops requesting frames", () => {
  let draws = 0;
  const f = fixture(() => draws++);
  for (let i = 0; i < 100; i++) f.scheduler.invalidate();
  assert.equal(f.pending.size, 1);
  f.tick();
  assert.equal(draws, 1);
  assert.equal(f.pending.size, 0);
  f.tick();
  assert.equal(draws, 1);
});
test("invalidation during drawing and delayed sort completion both produce another frame", async () => {
  let draws = 0;
  const f = fixture(() => {
    if (++draws === 1) f.scheduler.invalidate();
  });
  f.scheduler.invalidate();
  f.tick();
  assert.equal(f.pending.size, 1);
  f.tick();
  assert.equal(draws, 2);
  assert.equal(f.pending.size, 0);
  await Promise.resolve();
  f.scheduler.invalidate();
  f.tick();
  assert.equal(draws, 3);
});
test("pausing cancels preview work and retains async changes until resuming", () => {
  let draws = 0;
  const f = fixture(() => draws++);
  f.scheduler.invalidate();
  f.scheduler.setEnabled(false);
  f.scheduler.invalidate();
  assert.equal(f.pending.size, 0);
  f.tick();
  assert.equal(draws, 0);
  f.scheduler.setEnabled(true);
  f.tick();
  assert.equal(draws, 1);
  assert.equal(f.pending.size, 0);
});
test("resume repaints even if canvas changed outside the preview", () => {
  let draws = 0;
  const f = fixture(() => draws++);
  f.scheduler.invalidate();
  f.tick();
  f.scheduler.setEnabled(false);
  f.scheduler.setEnabled(true);
  f.tick();
  assert.equal(draws, 2);
});
test("disposal cancels queued frames and ignores late worker callbacks", () => {
  let draws = 0;
  const f = fixture(() => draws++);
  f.scheduler.invalidate();
  f.scheduler.dispose();
  f.scheduler.invalidate();
  f.scheduler.setEnabled(true);
  f.tick();
  assert.equal(draws, 0);
  assert.equal(f.pending.size, 0);
});
