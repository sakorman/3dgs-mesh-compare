/** Static hosts differ: Fetch may have already decoded HTTP Content-Encoding.
 * Inspect the first two body bytes without buffering the full compressed file.
 */
export async function readPlyResponse(
  response: Response,
  signal?: AbortSignal,
  expectedBytes?: number,
): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("高斯模型文件格式无效");
  const reader = response.body.getReader();
  let validationError: Error | undefined;
  const rejectData = (message = "高斯模型文件格式无效") => {
    validationError = new Error(message);
    // Stop the source immediately instead of waiting for errors to cross gzip pipes.
    void reader.cancel(validationError).catch(() => {});
    throw validationError;
  };
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    inputController?.error(signal!.reason);
    void reader.cancel(signal!.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    // Content-Length can describe gzip bytes; use the manifest's decoded size.
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 4))
      rejectData("高斯模型长度配置无效");
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
    const signature = [0x70, 0x6c, 0x79, 0x0a];
    let checked = 0;
    let decodedBytes = 0;
    const validated = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          // Reject wrong responses before buffering the rest of the decoded model.
          for (let i = 0; i < chunk.length && checked < signature.length; i++) {
            if (chunk[i] !== signature[checked++]) rejectData();
          }
          // Reject an oversized chunk before the result collector retains it.
          if (expectedBytes !== undefined && chunk.byteLength > expectedBytes - decodedBytes)
            rejectData("高斯模型解压后长度超出场景记录");
          decodedBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          if (checked < signature.length) rejectData();
          if (expectedBytes !== undefined && decodedBytes !== expectedBytes)
            rejectData("高斯模型解压后长度与场景记录不符");
        },
      }),
      { signal },
    );
    const decoded = await new Response(validated).arrayBuffer();
    signal?.throwIfAborted();
    return decoded;
  } catch (error) {
    // Some browsers turn stream errors into a generic Response TypeError.
    // Preserve cancellation and header validation reasons for the caller.
    signal?.throwIfAborted();
    throw validationError ?? error;
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
