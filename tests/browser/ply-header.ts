import { readPlyResponse } from "../../src/model-bytes";
const baseline =
  new URLSearchParams(location.search).get("variant") === "baseline";
const path = "/.qa/header-baseline.ts";
const read: typeof readPlyResponse = baseline
  ? (await import(/* @vite-ignore */ path)).readPlyResponse
  : readPlyResponse;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const result = document.querySelector("#result")!;
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) =>
  errors.push(String(e.reason)),
);
const compress = async (bytes: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
run.onclick = async () => {
  run.disabled = true;
  const rows = [];
  try {
    const invalid = new Uint8Array(1024 * 1024);
    let seed = 42;
    for (let i = 0; i < invalid.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      invalid[i] = seed & 255;
    }
    invalid.set(new TextEncoder().encode("<html>"));
    for (const gzip of [false, true]) {
      const bytes = gzip ? await compress(invalid) : invalid;
      let offset = 0,
        cancelled = false,
        closed = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset === bytes.length) {
              closed = true;
              controller.close();
              return;
            }
            const end = Math.min(offset + 1024, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
            // Model asynchronous network arrivals, not an already buffered response.
            await new Promise((resolve) => setTimeout(resolve, 0));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      let error = "";
      try {
        await read(response);
      } catch (reason) {
        error = String(reason);
      }
      rows.push({
        gzip,
        inputBytes: bytes.length,
        suppliedBytes: offset,
        cancelled,
        closed,
        lockReleased: !response.body!.locked,
        error,
        passed:
          error.includes("无效") &&
          cancelled &&
          offset < bytes.length / 4 &&
          !response.body!.locked,
      });
    }
    const raw = new TextEncoder().encode(
      "ply\nformat binary_little_endian 1.0\nend_header\n123456789",
    );
    const valid = [];
    for (const gzip of [false, true]) {
      const bytes = gzip ? await compress(raw) : raw;
      let offset = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.length) controller.close();
            else controller.enqueue(bytes.subarray(offset, ++offset));
          },
        }),
      );
      const decoded = new Uint8Array(await read(response));
      valid.push({
        gzip,
        bytesMatch:
          decoded.length === raw.length &&
          decoded.every((v, i) => v === raw[i]),
      });
    }
    result.textContent = JSON.stringify(
      {
        variant: baseline ? "baseline" : "candidate",
        userAgent: navigator.userAgent,
        rows,
        valid,
        errors,
        passed:
          rows.every((r) => r.passed) &&
          valid.every((r) => r.bytesMatch) &&
          !errors.length,
      },
      null,
      2,
    );
  } catch (error) {
    result.textContent = "FAILED: " + String(error);
  }
};
