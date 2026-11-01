/** Serial admission for non-interruptible decoders. Cancelled waiters own no slot. */
export class InitializationQueue {
  private busy = false;
  private waiters = new Set<() => void>();

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        this.waiters.delete(grant);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const grant = () => {
        this.waiters.delete(grant);
        signal.removeEventListener("abort", abort);
        this.busy = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          const next = this.waiters.values().next().value;
          if (next) next(); else this.busy = false;
        });
      };
      if (this.busy) {
        this.waiters.add(grant);
        signal.addEventListener("abort", abort, {once: true});
      } else grant();
    });
  }
}
