import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { decodeImage } from "../src/decode-image";

function fixture() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const image = {
    src: "", calls: 0, removals: 0,
    decode() { this.calls++; return pending; },
    removeAttribute(name: string) { assert.equal(name, "src"); this.src = ""; this.removals++; },
  };
  return {image, resolve, reject};
}
test("decoded image identity and source are preserved, listener removed", async () => {
  const f = fixture(), c = new AbortController();
  const result = decodeImage(f.image, "photo.jpg", c.signal);
  f.resolve(); assert.equal(await result, f.image);
  assert.equal(f.image.src, "photo.jpg"); assert.equal(f.image.removals, 0);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
  c.abort(); assert.equal(f.image.removals, 0);
});
test("already aborted input starts no image request or decode", async () => {
  const f = fixture(), c = new AbortController(); c.abort();
  await assert.rejects(decodeImage(f.image, "photo.jpg", c.signal), {name: "AbortError"});
  assert.equal(f.image.src, ""); assert.equal(f.image.calls, 0);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
});
test("abort detaches source without waiting for decode, ignores late success", async () => {
  const f = fixture(), c = new AbortController(), reason = new Error("cancel");
  const result = decodeImage(f.image, "photo.jpg", c.signal);
  const rejected = assert.rejects(result, e => e === reason);
  c.abort(reason); await rejected;
  assert.equal(f.image.src, ""); assert.equal(f.image.removals, 1);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
  f.resolve(); await Promise.resolve(); assert.equal(f.image.removals, 1);
});
test("late decoder rejection after abort remains handled", async () => {
  const f = fixture(), c = new AbortController();
  const result = decodeImage(f.image, "photo.jpg", c.signal);
  const rejected = assert.rejects(result, {name: "AbortError"}); c.abort(); await rejected;
  f.reject(new Error("late decode failure")); await new Promise(r => setImmediate(r));
  assert.equal(f.image.removals, 1);
});
test("normal decode failure keeps its reason and cleans source and listener", async () => {
  const f = fixture(), c = new AbortController(), reason = new Error("invalid image");
  const result = decodeImage(f.image, "photo.jpg", c.signal);
  const rejected = assert.rejects(result, e => e === reason); f.reject(reason); await rejected;
  assert.equal(f.image.src, ""); assert.equal(f.image.removals, 1);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
});
test("synchronous decode errors clean the abort listener", async () => {
  const f = fixture(), c = new AbortController();
  f.image.decode = () => { throw new Error("decode unavailable"); };
  await assert.rejects(decodeImage(f.image, "photo.jpg", c.signal), /decode unavailable/);
  assert.equal(f.image.removals, 1); assert.equal(getEventListeners(c.signal, "abort").length, 0);
});
test("abort during source assignment does not start decoding", async () => {
  const f = fixture(), c = new AbortController();
  Object.defineProperty(f.image, "src", {get: () => "", set: value => { if (value) c.abort(); }});
  await assert.rejects(decodeImage(f.image, "photo.jpg", c.signal), {name: "AbortError"});
  assert.equal(f.image.calls, 0); assert.equal(f.image.removals, 1);
});
test("source assignment failure is rejected and cleaned", async () => {
  const f = fixture(), c = new AbortController();
  Object.defineProperty(f.image, "src", {get: () => "", set: value => { if (value) throw new Error("blocked source"); }});
  await assert.rejects(decodeImage(f.image, "photo.jpg", c.signal), /blocked source/);
  assert.equal(f.image.calls, 0); assert.equal(getEventListeners(c.signal, "abort").length, 0);
});
test("callers without a signal keep normal image decoding", async () => {
  const f = fixture(), result = decodeImage(f.image, "photo.jpg");
  f.resolve(); assert.equal(await result, f.image); assert.equal(f.image.src, "photo.jpg");
});
