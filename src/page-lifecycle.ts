export type PageLifecycle = {
  interrupt: () => void;
  canRestore: () => boolean;
  restore: () => void;
  dispose: () => void;
  reload: () => void;
};

/** A persisted pagehide freezes a document; it does not destroy the viewer. */
export function bindPageLifecycle(
  actions: PageLifecycle,
  target: EventTarget = window,
): () => void {
  let cached = false;
  const detach = () => {
    target.removeEventListener("pagehide", hide);
    target.removeEventListener("pageshow", show);
  };
  const hide = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) {
      if (!cached) actions.interrupt();
      cached = true;
      return;
    }
    actions.interrupt();
    detach();
    actions.dispose();
  };
  const show = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted || !cached) return;
    cached = false;
    if (actions.canRestore()) actions.restore();
    else actions.reload();
  };
  target.addEventListener("pagehide", hide);
  target.addEventListener("pageshow", show);
  return detach;
}
