/** Owns the resources and cancellation signal for one scene load. */
export class LoadScope {
  private readonly controller = new AbortController();
  private readonly releases = new Map<object, () => void>();
  private readonly released = new WeakSet<object>();
  readonly signal = this.controller.signal;

  check() {
    this.signal.throwIfAborted();
  }

  own<T extends object>(resource: T, dispose: (resource: T) => void): T {
    const release = () => {
      if (this.released.has(resource)) return;
      this.released.add(resource);
      dispose(resource);
    };
    if (this.signal.aborted) {
      // Parsing may finish after its fetch was cancelled. Do not attach it.
      release();
      this.check();
    }
    if (!this.releases.has(resource)) this.releases.set(resource, release);
    return resource;
  }

  cancel() {
    if (this.signal.aborted) return;
    this.controller.abort();
    for (const release of this.releases.values()) release();
    this.releases.clear();
  }
}
