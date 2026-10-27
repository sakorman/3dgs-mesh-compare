import { applyAlpha16, validateAlpha16, validateAlpha16Header } from "./alpha16";

// Experimental AP16 limit, independent of the incoming file's count field.
export const MAX_ALPHA16_BYTES = 8 * 1024 * 1024;
export async function readAlpha16Response(
  response: Response, count: number, modelHash: Uint8Array, signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) { signal?.throwIfAborted(); throw new Error("Missing alpha16 response body"); }
  const source = response.body.getReader();
  let decoded: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    inputController?.error(signal!.reason);
    void source.cancel(signal!.reason).catch(() => {});
    void decoded?.cancel(signal!.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`Alpha16 HTTP ${response.status}`);
    const expectedBytes = 48 + count * 2;
    if (!Number.isInteger(count) || count < 1 || expectedBytes > MAX_ALPHA16_BYTES || modelHash.length !== 32)
      throw new Error("Invalid alpha16 expected size or model hash");
    const prefix: Uint8Array[] = [], magic: number[] = [];
    while (magic.length < 2) {
      const part = await source.read();
      signal?.throwIfAborted();
      if (part.done) throw new Error("Truncated alpha16 response");
      if (!part.value.length) continue;
      prefix.push(part.value);
      for (const byte of part.value) { magic.push(byte); if (magic.length === 2) break; }
    }
    const input = new ReadableStream<Uint8Array>({
      start(controller) { inputController = controller; },
      async pull(controller) {
        try {
          signal?.throwIfAborted();
          const buffered = prefix.shift();
          if (buffered) { controller.enqueue(buffered); return; }
          const part = await source.read();
          signal?.throwIfAborted();
          if (part.done) controller.close(); else controller.enqueue(part.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return source.cancel(reason); },
    }, { highWaterMark: 0 });
    // Fetch can already have decoded Content-Encoding; use actual body bytes.
    const body = magic[0] === 0x1f && magic[1] === 0x8b
      ? input.pipeThrough(new DecompressionStream("gzip"), { signal }) : input;
    decoded = body.getReader();
    const output = new Uint8Array(expectedBytes);
    let offset = 0, headerChecked = false;
    while (true) {
      const part = await decoded.read();
      signal?.throwIfAborted();
      if (part.done) break;
      if (!part.value.length) continue;
      if (part.value.length > expectedBytes - offset) throw new Error("Alpha16 decoded length exceeds expected size");
      output.set(part.value, offset); offset += part.value.length;
      if (!headerChecked && offset >= 48) {
        validateAlpha16Header(output.subarray(0, 48), count, modelHash);
        headerChecked = true;
      }
    }
    if (offset !== expectedBytes) throw new Error("Truncated alpha16 response");
    // EOF is required even at the expected length: gzip CRC/trailer can still fail.
    validateAlpha16(output, count, modelHash);
    signal?.throwIfAborted();
    return output;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await decoded?.cancel().catch(() => {});
    decoded?.releaseLock();
    await source.cancel().catch(() => {});
    source.releaseLock();
  }
}

/** Publish only a complete, validated result; cancellation never partially writes. */
export async function restoreAlpha16Response(
  response: Response, words: Uint32Array, count: number, modelHash: Uint8Array, signal?: AbortSignal,
) {
  const bytes = await readAlpha16Response(response, count, modelHash, signal);
  signal?.throwIfAborted();
  applyAlpha16(bytes, words, count, modelHash);
  return bytes;
}
