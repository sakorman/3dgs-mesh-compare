type ImageDecoder = Pick<HTMLImageElement, "src" | "decode" | "removeAttribute">;

/** Preserve the browser's image decode path while allowing its caller to stop waiting. */
export async function decodeImage<T extends ImageDecoder>(
  image: T,
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (success: boolean, reason?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (success) resolve(image);
      else {
        image.removeAttribute("src");
        reject(reason);
      }
    };
    const abort = () => finish(false, signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      image.src = url;
      if (!settled) {
        // Keep both handlers attached: native decode may reject after cancellation.
        image.decode().then(() => finish(true), error => finish(false, error));
      }
    } catch (error) {
      finish(false, error);
    }
  });
}
