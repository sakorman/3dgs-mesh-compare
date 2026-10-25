import "../../src/style.css";
import { CompareViewer } from "../../src/viewer";
const params = new URLSearchParams(location.search);
const baseline = params.get("variant") === "baseline";
const early = params.get("case") === "early";
const output = document.querySelector<HTMLPreElement>("#qa-state")!;
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const instance = crypto.randomUUID();
const errors: string[] = [];
const events: { type: string; persisted: boolean; native: boolean }[] = [];
let viewer: CompareViewer | undefined,
  disposals = 0,
  loads = 0;
const originalLoad = CompareViewer.prototype.load;
const originalDispose = CompareViewer.prototype.dispose;
CompareViewer.prototype.load = function (id) {
  viewer = this;
  loads++;
  return originalLoad.call(this, id);
};
CompareViewer.prototype.dispose = function () {
  disposals++;
  return originalDispose.call(this);
};
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
const state = () => ({
  variant: baseline ? "baseline" : "candidate",
  instance,
  loads,
  disposals,
  disposed: viewer?.disposed,
  hasModels: !!viewer?.gaussian && !!viewer?.mesh,
  events,
  errors,
});
window.addEventListener("pagehide", (e) => {
  events.push({
    type: "pagehide",
    persisted: e.persisted,
    native: e.isTrusted,
  });
  if (e.isTrusted)
    sessionStorage.setItem(
      "page-lifecycle-probe",
      JSON.stringify({ instance, persisted: e.persisted }),
    );
});
window.addEventListener("pageshow", (e) => {
  events.push({
    type: "pageshow",
    persisted: e.persisted,
    native: e.isTrusted,
  });
  queueMicrotask(() => {
    output.textContent = JSON.stringify(
      {
        ...state(),
        previousNativeHide: sessionStorage.getItem("page-lifecycle-probe"),
      },
      null,
      2,
    );
  });
});
let resume!: () => void, entered!: () => void;
const blocked = new Promise<void>((resolve) => {
  entered = resolve;
});
const released = new Promise<void>((resolve) => {
  resume = resolve;
});
const originalFetch = window.fetch;
if (early)
  window.fetch = async (input, init) => {
    if (String(input).endsWith("/pipes/scene.json")) {
      entered();
      await released;
    }
    return originalFetch(input, init);
  };
const baselineModule = import.meta.env.PROD
  ? "/assets/page-baseline.js"
  : "/.qa/page-main-baseline.ts";
const starting = baseline
  ? import(/* @vite-ignore */ baselineModule)
  : import("../../src/main");
if (early) {
  await blocked;
  window.dispatchEvent(
    new PageTransitionEvent("pagehide", { persisted: false }),
  );
  const disposedBeforeResponse = viewer?.disposed === true;
  resume();
  await starting;
  window.fetch = originalFetch;
  output.textContent = JSON.stringify(
    {
      ...state(),
      case: "early-unload",
      passed: disposedBeforeResponse && !viewer?.gaussian && !viewer?.mesh,
      disposedBeforeResponse,
    },
    null,
    2,
  );
  viewer?.dispose();
} else {
  await starting;
  output.textContent = JSON.stringify({ ...state(), ready: true }, null, 2);
  run.disabled = false;
  run.onclick = async () => {
    const current = viewer!;
    const gaussian = current.gaussian,
      mesh = current.mesh;
    const beforeLoads = loads;
    for (let i = 0; i < 2; i++) {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const restored =
      !current.disposed &&
      current.gaussian === gaussian &&
      current.mesh === mesh &&
      loads === beforeLoads;
    const result = {
      ...state(),
      case: "synthetic-cached-return",
      restored,
      modelsReused: current.gaussian === gaussian && current.mesh === mesh,
      extraLoads: loads - beforeLoads,
    };
    output.textContent = JSON.stringify(result, null, 2);
  };
}
