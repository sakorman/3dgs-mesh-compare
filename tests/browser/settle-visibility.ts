import { CompareViewer } from "../../src/viewer";
import { quality } from "../../src/metrics";
import { hashHex, sha256 } from "../helpers/paired-model";

const run = document.querySelector<HTMLButtonElement>("#run")!, status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const hash = async (pixels: Uint8ClampedArray) => hashHex(await sha256(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)));
let simulatedHidden = false;
const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")!.get!;
Object.defineProperty(document, "hidden", { configurable: true, get: () => simulatedHidden || nativeHidden.call(document) });
const hide = (value: boolean) => { simulatedHidden = value; document.dispatchEvent(new Event("visibilitychange")); };
let viewer: CompareViewer;
const create = () => new CompareViewer(document.querySelector("#left")!, document.querySelector("#right")!);
run.onclick = async () => {
  run.disabled = true; errors.length = 0;
  document.querySelector("#gallery")!.replaceChildren();
  const cases: unknown[] = [], comparisons: unknown[] = [];
  viewer = create(); viewer.playing = false;
  try {
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const baseline = await (await fetch("/docs/benchmarks/settle-visibility-baseline-2026-10-28.json")).json();
    for (const scene of ["pipes", "office"]) {
      status.textContent = `${scene}: loading`;
      let settleEntered!: () => void;
      const entered = new Promise<void>(resolve => { settleEntered = resolve; });
      let settled = false, hiddenDraws = 0;
      const render = viewer.render.bind(viewer);
      viewer.render = kind => { if (simulatedHidden) hiddenDraws++; render(kind); };
      viewer.onProgress = message => {
        if (message.includes("首帧")) { hide(true); settleEntered(); }
      };
      const loading = viewer.load(scene).then(data => { settled = true; return data; });
      await entered;
      status.textContent = `${scene}: simulated hidden, waiting 16 seconds`;
      const start = performance.now(); await pause(16000);
      assert(!settled && Boolean(!viewer.loadTimings) && hiddenDraws === 0, "Hidden settlement drew or finished");
      const hiddenMs = performance.now() - start;
      hide(false); await loading; viewer.playing = false;
      assert(viewer.gaussian && viewer.mesh && viewer.loadTimings?.visibility === "backgrounded", "Scene did not resume");
      cases.push({ scene, kind: "synthetic-hidden-load", hiddenMs, hiddenDraws, success: true, timing: viewer.loadTimings });
      viewer.render = render; viewer.onProgress = () => {};
      const views = viewer.data!.views.filter(v => v.heldOut);
      for (const [index, view] of views.entries()) for (const yaw of index === 0 ? [0, -0.08, 0.08] : [0]) {
        viewer.setView(view); viewer.camera.rotateY(yaw); await viewer.settle();
        const pixels = viewer.pixels("gaussian"), digest = await hash(pixels);
        const expected = prior.comparisons.find((x: { scene: string; variant: string; view: string; yaw: number }) =>
          x.scene === scene && x.variant === "original" && x.view === view.image_name && x.yaw === yaw);
        assert(digest === expected?.hash, "Pixel regression");
        comparisons.push({ scene, view: view.image_name, yaw, hash: digest, matchesPrevious: true,
          quality: yaw === 0 ? quality(pixels, await viewer.reference(view), viewer.width, viewer.height) : null });
        if (index === 0 && yaw === 0) {
          const figure = document.createElement("figure"), img = new Image(), caption = document.createElement("figcaption");
          caption.textContent = `${scene} · 后台等待后恢复 · SH3 / LoD 关闭`; img.src = viewer.renderers.gaussian.domElement.toDataURL("image/jpeg", .92);
          figure.append(caption, img); document.querySelector("#gallery")!.append(figure);
        }
      }
      hide(true);
      const controller = new AbortController();
      const waiting = viewer.settle(controller.signal).then(() => "resolved", e => e.name);
      controller.abort(); assert(await waiting === "AbortError", "Hidden cancellation stalled");
      assert(viewer.gaussian && viewer.mesh, "Caller cancellation discarded scene");
      cases.push({ scene, kind: "hidden-caller-cancel", success: true });
      const clearing = viewer.settle().then(() => "resolved", e => e.name);
      viewer.clear(); assert(await clearing === "AbortError", "Clear did not abort hidden wait");
      assert(!viewer.gaussian && !viewer.mesh && !viewer.data && !viewer.loadTimings, "Clear retained scene");
      cases.push({ scene, kind: "hidden-clear", success: true });
      hide(false);
    }
    const gl = viewer.renderers.gaussian.getContext(), debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    hide(true);
    const disposing = viewer.settle().then(() => "resolved", e => e.name);
    viewer.dispose(); assert(await disposing === "AbortError", "Dispose did not abort hidden wait");
    hide(false); cases.push({ kind: "hidden-dispose", success: true });
    assert(!errors.length, "Browser errors");
    const report = { createdAt: new Date().toISOString(), baselineCommit: "96c45c2", spark: "2.4.0", resolution: 768, maxSh: 3, lod: false,
      userAgent: navigator.userAgent, gpu,
      method: "Real WebGL2 models and frames; document.hidden overridden plus synthetic visibilitychange for controlled 16s pauses. Not native tab suspension or GPU sorting speed measurement. Wall-clock load timings retain background wait. Pixel hashes match original PLY controls.",
      baseline, cases, comparisons, errors };
    document.querySelector("#result")!.textContent = JSON.stringify(report, null, 2);
    document.querySelector("#checks")!.textContent = `两场景各等待 16 秒后恢复；后台绘制 0 次；取消、清理、销毁通过。\n像素一致：${comparisons.length} / ${comparisons.length}；浏览器错误：${errors.length}。`;
    (document.querySelector("#views") as HTMLElement).hidden = true;
    status.textContent = `Complete; lifecycle=${cases.length}; pixels=${comparisons.length}; errors=${errors.length}`;
  } catch (error) { status.textContent = `FAILED: ${error}`; }
  finally { hide(false); viewer.dispose(); run.disabled = false; }
};
window.addEventListener("pagehide", () => viewer?.dispose(), { once: true });
