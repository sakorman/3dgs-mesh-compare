import { readPlyResponse } from "../../src/model-bytes";
const baseline =
  new URLSearchParams(location.search).get("variant") === "baseline";
const source = "/.qa/baseline-model-bytes.ts";
const previous = baseline ? await import(/* @vite-ignore */ source) : null;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const result = document.querySelector<HTMLPreElement>("#result")!;
const errors: string[] = [];
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
async function cancellation() {
  const raw = new TextEncoder().encode(
    "ply\nformat binary_little_endian 1.0\nend_header\n",
  );
  const bytes = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  let pulls = 0,
    cancelled = false;
  let blocked!: () => void;
  const waiting = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls === 1) {
          controller.enqueue(bytes.subarray(0, 12));
          return;
        }
        blocked();
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const abort = new AbortController();
  const outcome = readPlyResponse(response, abort.signal).then(
    () => "unexpected success",
    (error) => error.name,
  );
  await waiting;
  abort.abort();
  return {
    error: await outcome,
    sourceCancelled: cancelled,
    readerUnlocked: !response.body!.locked,
    pulls,
  };
}
button.onclick = async () => {
  button.disabled = true;
  const records = [];
  try {
    for (const scene of ["pipes", "office"]) {
      const manifest = await (
        await fetch(`/scenes/${scene}/scene.json`)
      ).json();
      for (const transport of ["http-decoded", "raw-gzip"] as const) {
        result.textContent = `${scene}: ${transport}`;
        const url =
          transport === "http-decoded"
            ? `/scenes/${scene}/gaussians.ply.gz`
            : `/.qa/${scene}-gaussians.bin`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
        const bytes: ArrayBuffer = baseline
          ? await previous.decodePly(await response.arrayBuffer())
          : await readPlyResponse(response);
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        )
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        records.push({
          scene,
          transport,
          encodedBytes: manifest.gaussian.bytes,
          decodedBytes: bytes.byteLength,
          sizeMatches: bytes.byteLength === manifest.gaussian.decodedBytes,
          sha256: digest,
        });
      }
    }
    result.textContent = JSON.stringify(
      {
        variant: baseline ? "baseline" : "candidate",
        records,
        cancellation: baseline ? null : await cancellation(),
        errors,
      },
      null,
      2,
    );
  } catch (error) {
    result.textContent = JSON.stringify(
      { failed: String(error), records, errors },
      null,
      2,
    );
  } finally {
    button.disabled = false;
  }
};
