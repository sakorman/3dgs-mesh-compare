import type { FrameQueue } from "./render-scheduler";

/** Cancellation must not wait for a frame from a suspended document. */
export function nextFrame(
  signal?: AbortSignal,
  frames: FrameQueue = {
    request: callback => requestAnimationFrame(callback),
    cancel: handle => cancelAnimationFrame(handle),
  },
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let handle: number | undefined;
    const abort = () => {
      if (handle !== undefined) frames.cancel(handle);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      handle = frames.request(time => {
        handle = undefined;
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(signal.reason);
        else resolve(time);
      });
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      reject(error);
    }
  });
}
