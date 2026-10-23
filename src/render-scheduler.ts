export type FrameQueue = {
  request: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
};

/** Coalesces invalidations; a paused preview never competes with manual sampling. */
export class RenderScheduler {
  private pending: number | null = null;
  private dirty = false;
  private enabled = true;
  private disposed = false;

  constructor(
    private readonly draw: () => void,
    private readonly frames: FrameQueue = {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    },
  ) {}

  invalidate = () => {
    if (this.disposed) return;
    this.dirty = true;
    if (!this.enabled || this.pending !== null) return;
    this.pending = this.frames.request(() => {
      this.pending = null;
      if (!this.enabled || this.disposed || !this.dirty) return;
      // Clear before drawing: synchronous and asynchronous Spark callbacks may
      // invalidate again while the new camera/sort is being processed.
      this.dirty = false;
      this.draw();
    });
  };

  setEnabled(enabled: boolean) {
    if (this.disposed) return;
    this.enabled = enabled;
    if (enabled) this.invalidate();
    else this.cancelPending();
  }

  private cancelPending() {
    if (this.pending !== null) this.frames.cancel(this.pending);
    this.pending = null;
  }

  dispose() {
    this.disposed = true;
    this.dirty = false;
    this.cancelPending();
  }
}
