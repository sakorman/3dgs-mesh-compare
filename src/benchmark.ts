import type { CompareViewer } from "./viewer";
import { nextFrame } from "./next-frame";
import { summarize } from "./metrics";
import type { Backend, Sample } from "./types";
type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
class GpuTimer {
  gl: WebGL2RenderingContext;
  ext: TimerExt | null;
  pending: { q: WebGLQuery; sample: Sample }[] = [];
  disjoint = false;
  private active: WebGLQuery | null = null;
  constructor(viewer: CompareViewer, kind: Backend) {
    this.gl = viewer.renderers[kind].getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }
  begin() {
    if (!this.ext || this.disjoint || this.pending.length > 32) return null;
    const q = this.gl.createQuery();
    if (!q) return null;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
    return q;
  }
  end(q: WebGLQuery | null, sample: Sample) {
    if (q && this.ext) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.active = null;
      this.pending.push({ q, sample });
    }
  }
  poll() {
    if (!this.ext) return;
    if (this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) this.disjoint = true;
    this.pending = this.pending.filter(({ q, sample }) => {
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE))
        return true;
      if (!this.disjoint)
        sample.gpuMs = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) / 1e6;
      this.gl.deleteQuery(q);
      return false;
    });
  }
  dispose() {
    // A failed draw has no sample, but its open query still belongs to this timer.
    if (this.active && this.ext) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active);
      this.active = null;
    }
    this.pending.forEach(({ q }) => this.gl.deleteQuery(q));
    this.pending = [];
  }
}
export async function benchmark(
  viewer: CompareViewer,
  signal: AbortSignal,
  progress: (s: string) => void,
) {
  const samples: Record<Backend, Sample[]> = { gaussian: [], mesh: [] };
  const timers = {
    gaussian: new GpuTimer(viewer, "gaussian"),
    mesh: new GpuTimer(viewer, "mesh"),
  };
  const order: Backend[][] = [
    ["gaussian", "mesh"],
    ["mesh", "gaussian"],
    ["gaussian", "mesh"],
    ["mesh", "gaussian"],
  ];
  const check = () => {
    if (signal.aborted) throw new Error("测试已取消");
    if (document.hidden) throw new Error("页面进入后台，本次测试已作废");
    if (viewer.lost) throw new Error("显卡上下文丢失，本次测试已作废");
    if (viewer.disposed) throw new Error("查看器已释放，本次测试已作废");
  };
  viewer.playing = false;
  try {
    check();
    await viewer.settle(signal);
    // Static, frozen photo camera. Sorting has settled before both backends run.
    for (let round = 0; round < order.length; round++)
      for (const kind of order[round]) {
        progress(
          `第 ${round + 1}/4 轮 · ${kind === "gaussian" ? "3DGS" : "Mesh"} 单独采样`,
        );
        let previous = await nextFrame(signal);
        for (let frame = -12; frame < 40; frame++) {
          check();
          timers[kind].poll();
          const q = frame >= 0 ? timers[kind].begin() : null,
            start = performance.now();
          viewer.render(kind);
          const cpu = performance.now() - start;
          if (frame >= 0) {
            const info = viewer.renderers[kind].info.render;
            const sample = {
              cpuMs: cpu,
              intervalMs: 0,
              gpuMs: null,
              draws: info.calls,
              triangles: info.triangles,
            };
            samples[kind].push(sample);
            timers[kind].end(q, sample);
          }
          const now = await nextFrame(signal);
          check();
          if (frame >= 0)
            samples[kind][samples[kind].length - 1].intervalMs = now - previous;
          previous = now;
        }
      }
    for (
      let i = 0;
      i < 30 && (timers.gaussian.pending.length || timers.mesh.pending.length);
      i++
    ) {
      check();
      await nextFrame(signal);
      check();
      timers.gaussian.poll();
      timers.mesh.poll();
    }
    check();
    for (const kind of ["gaussian", "mesh"] as const)
      if (timers[kind].disjoint) samples[kind].forEach((s) => (s.gpuMs = null));
    return {
      gaussian: summarize(samples.gaussian),
      mesh: summarize(samples.mesh),
      protocol: {
        order,
        warmup: 12,
        samplesPerRound: 40,
        camera: "static calibrated photo; sort settled",
        resolution: [viewer.width, viewer.height],
        devicePixelRatio: 1,
        antialias: false,
        background: "#000000",
        gpuDisjoint: {
          gaussian: timers.gaussian.disjoint,
          mesh: timers.mesh.disjoint,
        },
        note: "Main-thread submit CPU excludes asynchronous sort worker. FPS is refresh-rate limited. No moving-camera benchmark.",
      },
    };
  } catch (error) {
    // Keep the same user-facing cancellation/context message for every wait.
    check();
    throw error;
  } finally {
    timers.gaussian.dispose();
    timers.mesh.dispose();
    viewer.playing = !viewer.lost && !viewer.disposed;
  }
}
