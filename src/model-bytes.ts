/** Static hosts differ: Fetch may have already decoded HTTP Content-Encoding.
 * Inspect the first two body bytes without buffering the full compressed file.
 */
export async function readPlyResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("高斯模型文件格式无效");
  const reader = response.body.getReader();
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    inputController?.error(signal!.reason);
    void reader.cancel(signal!.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const prefix: Uint8Array[] = [];
    const magic: number[] = [];
    // Headers can cross network chunks, including single-byte chunks.
    while (magic.length < 2) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) throw new Error("高斯模型文件格式无效");
      if (!part.value.byteLength) continue;
      prefix.push(part.value);
      for (const byte of part.value) {
        magic.push(byte);
        if (magic.length === 2) break;
      }
    }
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        inputController = controller;
        for (const chunk of prefix) controller.enqueue(chunk);
        prefix.length = 0;
      },
      async pull(controller) {
        try {
          signal?.throwIfAborted();
          const part = await reader.read();
          signal?.throwIfAborted();
          if (part.done) controller.close();
          else controller.enqueue(part.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    const body =
      magic[0] === 0x1f && magic[1] === 0x8b
        ? input.pipeThrough(new DecompressionStream("gzip"), { signal })
        : input;
    const decoded = await new Response(body).arrayBuffer();
    signal?.throwIfAborted();
    if (
      new TextDecoder().decode(
        new Uint8Array(decoded, 0, Math.min(4, decoded.byteLength)),
      ) !== "ply\n"
    ) {
      throw new Error("高斯模型文件格式无效");
    }
    return decoded;
  } catch (error) {
    // Some browsers report an interrupted Response body as a generic TypeError.
    // Preserve the caller's cancellation reason across stream implementations.
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    // On malformed data or a downstream error, stop the original body as well.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Compatibility entry point for callers that already hold an ArrayBuffer. */
export function decodePly(raw: ArrayBuffer): Promise<ArrayBuffer> {
  return readPlyResponse(new Response(raw));
}
