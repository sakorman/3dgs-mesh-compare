/** Experimental input: each transferred chunk owns its buffer; the source stays intact. */
export function ownedChunkStream(input: Uint8Array, chunkBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("Invalid chunk size");
  let source: Uint8Array | undefined = input, offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!source || offset === source.length) {
        source = undefined; controller.close(); return;
      }
      const end = Math.min(offset + chunkBytes, source.length);
      controller.enqueue(source.slice(offset, end));
      offset = end;
    },
    cancel() { source = undefined; },
  }, { highWaterMark: 0 });
}
