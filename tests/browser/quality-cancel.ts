import { CompareViewer } from "../../src/viewer";

const params = new URLSearchParams(location.search);
const baseline = params.get("variant") === "baseline";
const scenario = params.get("case") ?? "cancel";
const run = document.querySelector<HTMLButtonElement>("#qa-run")!;
const output = document.querySelector("#qa-result")!;
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
let viewer!: CompareViewer;
const originalLoad = CompareViewer.prototype.load;
CompareViewer.prototype.load = function (id) {
  viewer = this;
  return originalLoad.call(this, id);
};
const baselinePath = "/.qa/quality-main-baseline.ts";
if (baseline) await import(/* @vite-ignore */ baselinePath);
else await import("../../src/main");

run.disabled = false;
output.textContent = `Ready: ${baseline ? "baseline" : "candidate"} / ${scenario}`;
run.onclick = async () => {
  run.disabled = true;
  let entered!: () => void, release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let interrupted = false;
  let pixelsAfterInterrupt = 0;
  let viewChangesAfterDispose = 0;
  let rendersAfterDispose = 0;
  const reference = viewer.reference.bind(viewer);
  const pixels = viewer.pixels.bind(viewer);
  const setView = viewer.setView.bind(viewer);
  const render = viewer.render.bind(viewer);
  viewer.reference = async (view) => {
    const decoded = await reference(view);
    entered();
    await resumed;
    return decoded;
  };
  viewer.pixels = (kind) => {
    if (interrupted) pixelsAfterInterrupt++;
    return pixels(kind);
  };
  viewer.setView = (view) => {
    if (viewer.disposed) viewChangesAfterDispose++;
    return setView(view);
  };
  viewer.render = (kind) => {
    if (viewer.disposed) rendersAfterDispose++;
    return render(kind);
  };
  try {
    const button = document.querySelector<HTMLButtonElement>("#quality")!;
    const handler = button.onclick!;
    let finished: Promise<unknown> | undefined;
    button.onclick = function (event) {
      finished = Promise.resolve(handler.call(this, event));
    };
    button.click();
    await blocked;
    interrupted = true;
    if (scenario === "dispose") {
      // Use the application's permanent-leave handler while reference decode is pending.
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: false }),
      );
    } else {
      document.querySelector<HTMLButtonElement>("#cancel")!.click();
    }
    const disposedBeforeResume = viewer.disposed;
    release();
    await finished;
    const controlsUnlocked = !button.disabled;
    let partialQualityExported = false;
    let loadingExported = false;
    const exportButton = document.querySelector<HTMLButtonElement>("#export")!;
    if (!exportButton.disabled) {
      exportButton.click();
      const exported = JSON.parse(
        document.querySelector<HTMLTextAreaElement>("#report-json")!.value,
      );
      partialQualityExported = exported.quality !== null;
      loadingExported = !!exported.loading;
      document.querySelector<HTMLButtonElement>("#close-report")!.click();
    }
    const reportAbsent =
      document.querySelector("#gs-quality")!.textContent === "—" &&
      document.querySelector<HTMLElement>("#quality-details")!.hidden &&
      !partialQualityExported;
    output.textContent = JSON.stringify(
      {
        variant: baseline ? "baseline" : "candidate",
        scenario,
        passed:
          pixelsAfterInterrupt === 0 &&
          viewChangesAfterDispose === 0 &&
          rendersAfterDispose === 0 &&
          reportAbsent &&
          errors.length === 0 &&
          (scenario === "dispose"
            ? disposedBeforeResume && !viewer.playing && !controlsUnlocked
            : controlsUnlocked),
        pixelsAfterInterrupt,
        viewChangesAfterDispose,
        rendersAfterDispose,
        disposedBeforeResume,
        playing: viewer.playing,
        controlsUnlocked,
        reportAbsent,
        loadingExported,
        status: document.querySelector("#status")!.textContent,
        errors,
      },
      null,
      2,
    );
  } catch (error) {
    output.textContent = "FAILED: " + String(error);
  } finally {
    viewer.dispose();
  }
};
