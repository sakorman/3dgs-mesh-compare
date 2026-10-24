import test from "node:test";
import assert from "node:assert/strict";
import { LoadScope } from "../src/load-scope";

test("cancelling releases adopted resources once and aborts outstanding requests", () => {
  const scope = new LoadScope();
  let disposed = 0,
    aborted = 0;
  const resource = {};
  scope.signal.addEventListener("abort", () => aborted++);
  scope.own(resource, () => disposed++);
  scope.own(resource, () => disposed++);
  assert.equal(disposed, 0);
  scope.cancel();
  scope.cancel();
  assert.equal(disposed, 1);
  assert.equal(aborted, 1);
});

test("a non-cancellable parser completing late disposes its result before adoption", async () => {
  const scope = new LoadScope();
  let disposed = 0,
    attached = false;
  let complete!: (value: object) => void;
  const parsing = new Promise<object>((resolve) => {
    complete = resolve;
  });
  const result = parsing.then((resource) => {
    scope.own(resource, () => disposed++);
    attached = true;
  });
  const rejection = assert.rejects(result, { name: "AbortError" });
  scope.cancel();
  complete({});
  await rejection;
  assert.equal(disposed, 1);
  assert.equal(attached, false);
});

test("cancellation checkpoint prevents stale metadata from replacing a newer scene", async () => {
  const scope = new LoadScope();
  let metadata = "new";
  let complete!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const result = pending.then((value) => {
    scope.check();
    metadata = value;
  });
  const rejection = assert.rejects(result, { name: "AbortError" });
  scope.cancel();
  complete("old");
  await rejection;
  assert.equal(metadata, "new");
});

test("late cleanup from an old load never releases the newer load's resources", () => {
  const old = new LoadScope(),
    current = new LoadScope();
  let oldDisposals = 0,
    newDisposals = 0;
  old.own({}, () => oldDisposals++);
  old.cancel();
  current.own({}, () => newDisposals++);
  old.cancel();
  assert.throws(() => old.own({}, () => oldDisposals++), {
    name: "AbortError",
  });
  assert.equal(oldDisposals, 2);
  assert.equal(newDisposals, 0);
  current.check();
  current.cancel();
  assert.equal(newDisposals, 1);
});

test("late adoption of an already released resource cannot dispose it twice", () => {
  const scope = new LoadScope(),
    resource = {};
  let disposed = 0;
  scope.own(resource, () => disposed++);
  scope.cancel();
  assert.throws(() => scope.own(resource, () => disposed++), {
    name: "AbortError",
  });
  assert.equal(disposed, 1);
});
