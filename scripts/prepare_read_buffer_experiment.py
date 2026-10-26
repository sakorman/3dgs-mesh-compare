"""Prepare isolated decoder variants; does not modify the application loader."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[1]
git_root = subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], cwd=root, text=True
).strip()
if Path(git_root) != root:
    raise RuntimeError("Run from the comparison repository")

source = subprocess.check_output(
    ["git", "show", "fc35fbd:src/model-bytes.ts"], cwd=root, text=True
)
signature = "signal?: AbortSignal,"
collection = "    const decoded = await new Response(validated).arrayBuffer();"
assert source.count(signature) == 1 and source.count(collection) == 1
candidate = source.replace(signature, signature + "\n  expectedBytes?: number,")
candidate = candidate.replace(collection, '''    if (expectedBytes === undefined) return await new Response(validated).arrayBuffer();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error("模型大小无效");
    const output = new Uint8Array(expectedBytes);
    const decodedReader = validated.getReader();
    let offset = 0;
    try {
      while (true) {
        const part = await decodedReader.read();
        signal?.throwIfAborted();
        if (part.done) break;
        if (part.value.byteLength > output.byteLength - offset) throw new Error("模型大小不匹配");
        output.set(part.value, offset);
        offset += part.value.byteLength;
      }
      if (offset !== output.byteLength) throw new Error("模型大小不匹配");
    } finally {
      await decodedReader.cancel().catch(() => {});
      decodedReader.releaseLock();
    }
    const decoded = output.buffer;''')
scratch = root / ".qa"
scratch.mkdir(exist_ok=True)
(scratch / "read-buffer-baseline.ts").write_text(source)
(scratch / "read-buffer-candidate.ts").write_text(candidate)
for scene in ("pipes", "office"):
    original = root / "public" / "scenes" / scene / "gaussians.ply.gz"
    link = scratch / f"{scene}-gaussians.bin"
    if not link.exists():
        os.link(original, link)
    elif not os.path.samefile(original, link):
        raise RuntimeError(f"Existing fixture is not the expected model: {link.name}")
print("Prepared baseline/candidate modules and raw gzip links in .qa")
