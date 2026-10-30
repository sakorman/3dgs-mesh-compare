// Experimental adapter for the fixed SH3 v3 controls, not a general SPZ loader.
// Native inflate validates gzip CRC/ISIZE before we reuse its trailer. Spark
// still receives gzip, since its bare NGSP branch accepts v4 only.
export async function nativeStoredSpz(source: Uint8Array, count: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error("Invalid control count");
  const rawSize = 16 + count * 65;
  if (source.length < 18 || source[0] !== 31 || source[1] !== 139 || source[2] !== 8 || source[3] !== 0)
    throw new Error("Expected fixed-header gzip control");
  const input = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (input.getUint32(source.length - 4, true) !== rawSize) throw new Error("Unexpected decoded size");

  const blockSize = 65535, blockCount = Math.ceil(rawSize / blockSize);
  const stored = new Uint8Array(18 + rawSize + blockCount * 5);
  stored.set([31, 139, 8, 0, 0, 0, 0, 0, 0, 255]);
  const output = new DataView(stored.buffer);
  for (let block = 0; block < blockCount; block++) {
    const offset = 10 + block * (blockSize + 5);
    const size = Math.min(blockSize, rawSize - block * blockSize);
    stored[offset] = block === blockCount - 1 ? 1 : 0;
    output.setUint16(offset + 1, size, true);
    output.setUint16(offset + 3, size ^ 0xffff, true);
  }

  // Write each native output chunk directly into the stored blocks. No full
  // intermediate raw buffer is retained; Blob/native/Worker copies still exist.
  const reader = new Blob([source]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  let written = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      if (written + value.length > rawSize) throw new Error("Decoded control exceeds bounds");
      let cursor = 0;
      while (cursor < value.length) {
        const block = Math.floor(written / blockSize), within = written % blockSize;
        const size = Math.min(value.length - cursor, blockSize - within);
        stored.set(value.subarray(cursor, cursor + size), 15 + block * (blockSize + 5) + within);
        written += size; cursor += size;
      }
    }
    if (written !== rawSize) throw new Error("Truncated decoded control");
    const header = new DataView(stored.buffer, 15, 16);
    if (header.getUint32(0, true) !== 0x5053474e || header.getUint32(4, true) !== 3 ||
        header.getUint32(8, true) !== count || header.getUint32(12, true) !== 0x00010c03)
      throw new Error("Expected SH3 v3 / 12 fractional bits / antialiased control");
    // Copy only after the native decoder reaches EOF successfully, including CRC.
    stored.set(source.subarray(source.length - 8), stored.length - 8);
    return stored;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
