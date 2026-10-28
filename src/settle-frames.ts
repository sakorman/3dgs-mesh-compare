export type SettleEnvironment = {
  visibility: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  now: () => number;
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
  timer: (callback: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
};

/** Wait for four quiet frames; only visible time consumes the timeout budget. */
export function settleFrames(
  draw: () => boolean,
  signal: AbortSignal,
  env: SettleEnvironment = {
    visibility: document,
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
    timer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (id) => window.clearTimeout(id),
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame: number | null = null, timer: number | null = null;
    let activeSince: number | null = null, remaining = 15000;
    let quiet = 0, primed = false, finished = false;
    const cancelWork = () => {
      if (frame !== null) env.cancel(frame);
      if (timer !== null) env.clearTimer(timer);
      frame = timer = null;
    };
    const cleanup = () => {
      finished = true;
      cancelWork();
      env.visibility.removeEventListener("visibilitychange", visibility);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(signal.reason);
    const elapsed = () => activeSince === null ? 0 : env.now() - activeSince;
    const timeout = () => {
      if (timer !== null) env.clearTimer(timer);
      timer = null;
      if (finished) return;
      // A visibility event may be queued behind the timer.
      if (env.visibility.hidden) { visibility(); return; }
      const left = remaining - elapsed();
      if (left > 0) timer = env.timer(timeout, left);
      else fail(new Error("高斯排序未就绪，请重试"));
    };
    const tick = () => {
      frame = null;
      if (finished) return;
      if (env.visibility.hidden) { visibility(); return; }
      if (remaining - elapsed() <= 0) { timeout(); return; }
      try {
        signal.throwIfAborted();
        const busy = draw();
        if (finished) return;
        if (env.visibility.hidden) { visibility(); return; }
        quiet = !primed || busy ? 0 : quiet + 1;
        primed = true;
        if (quiet >= 4) { cleanup(); resolve(); }
        else frame = env.request(tick);
      } catch (error) { fail(error); }
    };
    const visibility = () => {
      if (finished) return;
      if (env.visibility.hidden) {
        remaining -= elapsed();
        activeSince = null;
        quiet = 0;
        cancelWork();
      } else if (activeSince === null) {
        activeSince = env.now();
        timer = env.timer(timeout, Math.max(0, remaining));
        frame = env.request(tick);
      }
    };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    env.visibility.addEventListener("visibilitychange", visibility);
    visibility();
  });
}
