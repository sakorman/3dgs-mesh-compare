import { applyAlpha16, encodeAlpha16 } from "../helpers/alpha16";
import { restoreAlpha16Response } from "../helpers/alpha16-stream";
const run = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector("#status")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map(x => x.toString(16).padStart(2, "0")).join("");
const zip = async (bytes: Uint8Array, decode = false) => new Uint8Array(await new Response(
  new Response(bytes).body!.pipeThrough(decode ? new DecompressionStream("gzip") : new CompressionStream("gzip")),
).arrayBuffer());
// Frozen 0595353 path: file() buffers the body, patch() inflates and applies it.
async function baseline(response: Response, words: Uint32Array, count: number, digest: Uint8Array, decodedSize: (n: number) => void) {
  const compressed = new Uint8Array(await response.arrayBuffer());
  const bytes = await zip(compressed, true); decodedSize(bytes.length);
  applyAlpha16(bytes, words, count, digest);
  return bytes;
}
function randomBytes(size: number) {
  const bytes = new Uint8Array(size); let seed = 42;
  for (let i = 0; i < size; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; bytes[i] = seed & 255; }
  return bytes;
}
run.onclick = async () => {
  run.disabled = true;
  try {
    const count = 10000, digest = new Uint8Array(32).fill(7), source = new Uint32Array(count * 4);
    const random = randomBytes(count * 2);
    for (let i = 0; i < count; i++) source[i * 4 + 3] = (random[i * 2] + 256 * random[i * 2 + 1]) % 0x3c01;
    const raw = encodeAlpha16(source, count, digest), compressed = await zip(raw);
    const wrongHeader = randomBytes(256 * 1024); wrongHeader.set(raw.subarray(0, 48)); wrongHeader[0] ^= 1;
    const oversize = randomBytes(256 * 1024); oversize.set(raw);
    const wrongModel = raw.slice(); wrongModel[16] ^= 1;
    const crc = compressed.slice(); crc[crc.length - 8] ^= 1;
    const cases = [
      { name: "wrong-header", bytes: await zip(wrongHeader) },
      { name: "wrong-model", bytes: await zip(wrongModel) },
      { name: "oversize", bytes: await zip(oversize) },
      { name: "cancel", bytes: compressed },
      { name: "valid-gzip", bytes: compressed },
      { name: "http-inflated", bytes: raw },
      { name: "crc-failure", bytes: crc },
    ];
    const comparisons = [];
    for (const sample of cases) for (const variant of ["baseline", "candidate"]) {
      status.textContent = `${sample.name}: ${variant}`;
      const target = new Uint32Array(count * 4).fill(0xaaaa1111);
      const abort = new AbortController(), reason = new Error("cancelled scene");
      let supplied = 0, cancelled = false, closed = false, decodedBytes: number | null = null, error = "";
      const response = new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          if (supplied === sample.bytes.length) { closed = true; c.close(); return; }
          const end = Math.min(supplied + 1024, sample.bytes.length);
          c.enqueue(sample.bytes.subarray(supplied, end)); supplied = end;
          if (sample.name === "cancel" && supplied >= 1024) abort.abort(reason);
          // Asynchronous arrivals make upstream cancellation observable.
          await new Promise(resolve => setTimeout(resolve, 0));
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }), { headers: sample.name === "http-inflated" ? { "Content-Encoding": "gzip" } : {} });
      let bytes: Uint8Array | undefined;
      try {
        bytes = variant === "baseline" ? await baseline(response, target, count, digest, n => { decodedBytes = n; })
          : await restoreAlpha16Response(response, target, count, digest, abort.signal);
      } catch (e) { error = String(e); }
      const changed = target.some(x => x !== 0xaaaa1111);
      const success = ["valid-gzip", "http-inflated"].includes(sample.name);
      const rawEqual = bytes ? await hash(bytes) === await hash(raw) : false;
      const passed = variant === "candidate" ? (success ? !error && rawEqual && changed : !!error && !changed) && !response.body!.locked : null;
      const row = { name: sample.name, variant, inputBytes: sample.bytes.length, suppliedBytes: supplied, cancelled, closed,
        lockReleased: !response.body!.locked, targetChanged: changed, rawEqual, baselineDecodedBytes: decodedBytes, error, passed };
      comparisons.push(row);
      const tr = document.createElement("tr");
      for (const value of [sample.name, variant, supplied.toLocaleString(), String(changed), error || "success"]) { const td = document.createElement("td"); td.textContent = value; tr.append(td); }
      document.querySelector("#rows")!.append(tr);
    }
    const prior = await (await fetch("/docs/benchmarks/spz-alpha16-2026-10-27.json")).json();
    const assets = [];
    for (const asset of prior.assets) {
      status.textContent = `${asset.scene}: saved AP16 input`;
      const encoded = new Uint8Array(await (await fetch(`/.qa/spz-alpha16/${asset.scene}.ap16.bin`)).arrayBuffer());
      if (await hash(encoded) !== asset.alphaGzipSha256) throw new Error("Saved input hash differs");
      const binding = Uint8Array.from(asset.spzSha256.match(/../g).map((x: string) => Number.parseInt(x, 16)));
      const expected = await zip(encoded, true);
      for (const [representation, bytes] of [["gzip", encoded], ["http-inflated", expected]] as const) {
        const target = new Uint32Array(asset.count * 4).fill(0xaaaa1111);
        const decoded = await restoreAlpha16Response(new Response(bytes, { headers: representation === "http-inflated" ? { "Content-Encoding": "gzip" } : {} }), target, asset.count, binding);
        const view = new DataView(expected.buffer); let unchanged = true, alphaEqual = true;
        for (let i = 0; i < target.length; i++) {
          if (i % 4 === 3) { unchanged &&= target[i] >>> 16 === 0xaaaa; alphaEqual &&= (target[i] & 0xffff) === view.getUint16(48 + Math.floor(i / 4) * 2, true); }
          else unchanged &&= target[i] === 0xaaaa1111;
        }
        const rawHash = await hash(decoded);
        assets.push({ scene: asset.scene, representation, count: asset.count, gzipSha256: asset.alphaGzipSha256, rawSha256: rawHash,
          rawBytes: decoded.length, rawMatchesPrevious: rawHash === asset.alphaRawSha256, otherWordsUnchanged: unchanged, opacityBitsEqual: alphaEqual });
      }
    }
    const passed = comparisons.filter(x => x.variant === "candidate").every(x => x.passed) && assets.every(x => x.rawMatchesPrevious && x.otherWordsUnchanged && x.opacityBitsEqual) && !errors.length;
    document.querySelector("#result")!.textContent = JSON.stringify({ createdAt: new Date().toISOString(), baselineCommit: "0595353", userAgent: navigator.userAgent,
      webgl: false, method: "CPU-only synthetic asynchronous 1024-byte chunks, then real saved AP16 bytes. Not a network, speed or peak-memory benchmark. Baseline reproduces old buffering and ignores cancellation; candidate waits for validated EOF before applying.",
      count, expectedDecodedBytes: raw.length, maxDecodedBytes: 8 * 1024 * 1024, comparisons, assets, errors, passed }, null, 2);
    status.textContent = passed ? "Complete: all candidate checks passed" : "FAILED: candidate checks";
  } catch (error) { status.textContent = `FAILED: ${error}`; }
};
