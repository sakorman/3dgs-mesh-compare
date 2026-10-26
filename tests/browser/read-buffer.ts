export {};
type Reader = (
  response: Response,
  signal?: AbortSignal,
  size?: number,
) => Promise<ArrayBuffer>;
const basePath = "/.qa/read-buffer-baseline.ts",
  candidatePath = "/.qa/read-buffer-candidate.ts";
const readers: Record<string, Reader> = {
  baseline: (await import(/* @vite-ignore */ basePath)).readPlyResponse,
  candidate: (await import(/* @vite-ignore */ candidatePath)).readPlyResponse,
};
const run = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
window.addEventListener("error", (e) => errors.push(e.message));
const hash = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
function source(bytes: Uint8Array) {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 65536, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      },
      { highWaterMark: 0 },
    ),
  );
}
run.onclick = async () => {
  run.disabled = true;
  const rows = [];
  try {
    for (const scene of ["pipes", "office"]) {
      status.textContent = `Preparing ${scene}`;
      const manifest = await (
        await fetch(`/scenes/${scene}/scene.json`)
      ).json();
      const packed = new Uint8Array(
        await (await fetch(`/.qa/${scene}-gaussians.bin`)).arrayBuffer(),
      );
      if (packed[0] !== 31 || packed[1] !== 139)
        throw new Error("Raw gzip fixture was HTTP-decoded");
      const plain = new Uint8Array(await readers.baseline(source(packed)));
      const expectedHash = await hash(plain.buffer);
      for (const encoding of ["plain", "gzip"]) {
        const input = encoding === "plain" ? plain : packed;
        for (const variant of ["baseline", "candidate"])
          await readers[variant](source(input), undefined, plain.byteLength);
        for (const [pass, variant] of [
          "baseline",
          "candidate",
          "candidate",
          "baseline",
          "baseline",
          "candidate",
          "candidate",
          "baseline",
        ].entries()) {
          status.textContent = `${scene} / ${encoding} / ${variant} / ${pass + 1}`;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const start = performance.now();
          const decoded = await readers[variant](
            source(input),
            undefined,
            manifest.gaussian.decodedBytes,
          );
          const elapsedMs = performance.now() - start;
          const digest = await hash(decoded);
          rows.push({
            scene,
            encoding,
            variant,
            pass: pass + 1,
            elapsedMs,
            inputBytes: input.byteLength,
            decodedBytes: decoded.byteLength,
            sha256: digest,
            bytesMatch:
              digest === expectedHash &&
              decoded.byteLength === manifest.gaussian.decodedBytes,
          });
          document.querySelector("#result")!.textContent = JSON.stringify(
            { rows, errors, userAgent: navigator.userAgent },
            null,
            2,
          );
          document.querySelector("#summary")!.textContent = JSON.stringify(
            rows.map(({ sha256, ...r }) => r),
            null,
            2,
          );
        }
      }
    }
    status.textContent = `Complete; rows=${rows.length}; errors=${errors.length}`;
  } catch (error) {
    status.textContent = "FAILED: " + String(error);
  }
};
