import test from "node:test";
import assert from "node:assert/strict";
import { InitializationQueue } from "./helpers/initialization-queue";

test("cancelled admission leaves no job to run and release is idempotent", async () => {
  const queue = new InitializationQueue(), signal = new AbortController().signal;
  const release = await queue.acquire(signal), cancelled = new AbortController();
  const skip = queue.acquire(cancelled.signal), rejected = assert.rejects(skip, {name: "AbortError"});
  cancelled.abort(); await rejected;
  let granted = false;
  const next = queue.acquire(signal).then(free => { granted = true; return free; });
  await Promise.resolve(); assert.equal(granted, false);
  release(); const free = await next;
  release();
  let thirdGranted = false;
  const third = queue.acquire(signal).then(free => { thirdGranted = true; return free; });
  await Promise.resolve(); assert.equal(thirdGranted, false);
  free(); (await third)();
});

test("already aborted requests consume no initialization slot", async () => {
  const queue = new InitializationQueue(), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(queue.acquire(cancelled.signal), {name: "AbortError"});
  (await queue.acquire(new AbortController().signal))();
});
