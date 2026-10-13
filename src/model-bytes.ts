/** Static hosts differ: Vite sets Content-Encoding:gzip while Pages may not.
 * Fetch automatically decodes HTTP gzip. Inspect the payload before inflating.
 */
export async function decodePly(raw: ArrayBuffer): Promise<ArrayBuffer> {
  const magic = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
  const decoded =
    magic[0] === 0x1f && magic[1] === 0x8b
      ? await new Response(
          new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer()
      : raw;
  if (
    new TextDecoder().decode(
      new Uint8Array(decoded, 0, Math.min(4, decoded.byteLength)),
    ) !== "ply\n"
  )
    throw new Error("高斯模型文件格式无效");
  return decoded;
}
