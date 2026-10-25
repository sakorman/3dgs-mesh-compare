import test from "node:test";
import assert from "node:assert/strict";
import { bindPageLifecycle } from "../src/page-lifecycle";
function fixture() {
  const target = new EventTarget();
  const calls: string[] = [];
  let usable = true;
  const detach = bindPageLifecycle(
    {
      interrupt: () => calls.push("interrupt"),
      canRestore: () => usable,
      restore: () => calls.push("restore"),
      dispose: () => calls.push("dispose"),
      reload: () => calls.push("reload"),
    },
    target,
  );
  const event = (type: "pagehide" | "pageshow", persisted: boolean) => {
    const e = new Event(type);
    Object.defineProperty(e, "persisted", { value: persisted });
    target.dispatchEvent(e);
  };
  return {
    calls,
    event,
    detach,
    unavailable: () => {
      usable = false;
    },
  };
}
test("a cached page retains its viewer and restores it on every history return", () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.event("pagehide", true);
    f.event("pageshow", true);
  }
  assert.deepEqual(f.calls, ["interrupt", "restore", "interrupt", "restore"]);
});
test("a real unload interrupts and disposes once, then detaches listeners", () => {
  const f = fixture();
  f.event("pagehide", false);
  f.event("pagehide", false);
  f.event("pageshow", true);
  assert.deepEqual(f.calls, ["interrupt", "dispose"]);
});
test("incomplete or lost cached viewers reload instead of reviving disposed resources", () => {
  const f = fixture();
  f.unavailable();
  f.event("pagehide", true);
  f.event("pageshow", true);
  assert.deepEqual(f.calls, ["interrupt", "reload"]);
});
test("initial pageshow does not restart a fresh page", () => {
  const f = fixture();
  f.event("pageshow", false);
  f.event("pageshow", true);
  assert.deepEqual(f.calls, []);
});
test("duplicate persisted events do not restore twice", () => {
  const f = fixture();
  f.event("pagehide", true);
  f.event("pagehide", true);
  f.event("pageshow", true);
  f.event("pageshow", true);
  assert.deepEqual(f.calls, ["interrupt", "restore"]);
});
test("explicit teardown removes both lifecycle handlers", () => {
  const f = fixture();
  f.detach();
  f.event("pagehide", true);
  f.event("pageshow", true);
  f.event("pagehide", false);
  assert.deepEqual(f.calls, []);
});
