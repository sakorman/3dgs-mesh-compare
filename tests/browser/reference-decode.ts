import { decodeImage } from "../../src/decode-image";
import { read, keep, diff } from "../helpers/reference-pixels";
import { hashHex, sha256 } from "../helpers/paired-model";

const output = document.querySelector("#result")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
interface Control {
  scene: string; view: string; width: number; height: number; sourceUrl: string; sourceSha256: string;
  png: string; pngSha256: string; raw: string; rgbaSha256: string;
}
async function checkedBytes(url: string, expected: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hashHex(await sha256(bytes)) !== expected) throw new Error(`Digest mismatch: ${url}`);
  return bytes;
}
run.onclick = async () => {
  run.disabled = true;
  const records: object[] = [];
  try {
    const manifest: {records: Control[]} = await (await fetch("/.qa/reference-decode/manifest.json")).json();
    for (const control of manifest.records) {
      const base = "/.qa/reference-decode/";
      const canonical = new Uint8ClampedArray(await checkedBytes(base + control.raw, control.rgbaSha256));
      for (const format of ["jpeg", "png"]) {
        const url = format === "jpeg" ? control.sourceUrl : base + control.png;
        await checkedBytes(url, format === "jpeg" ? control.sourceSha256 : control.pngSha256);
        for (let repeat = 0; repeat < 3; repeat++) {
          // Discard a decoded image before the last retry; this is not a network stall test.
          if (repeat === 2) {
            const discarded = await decodeImage(new Image(), url);
            discarded.removeAttribute("src");
          }
          for (const readFrequently of [false, true]) {
            output.textContent = `${control.scene} ${control.view} / ${format} / ${repeat} / ${readFrequently}`;
            const image = await decodeImage(new Image(), url);
            const natural = read(image, image.naturalWidth, image.naturalHeight, readFrequently);
            const width = 768, height = Math.round(width * control.height / control.width);
            const scaled = read(image, width, height, readFrequently);
            const naturalHash = await keep(natural.data, "natural"), scaledHash = await keep(scaled.data, "scaled");
            if (format === "png" && naturalHash !== control.rgbaSha256) throw new Error("PNG native-size readback differs from control");
            records.push({scene: control.scene, view: control.view, format, repeat, readFrequently,
              naturalSize: [image.naturalWidth, image.naturalHeight], scaledSize: [width, height],
              attributes: natural.attributes, canonicalHash: control.rgbaSha256, naturalHash, scaledHash,
              naturalDifference: diff(canonical, natural.data)});
            image.removeAttribute("src");
          }
        }
      }
    }
    output.textContent = JSON.stringify({createdAt: new Date().toISOString(), baseline: "08e1507", userAgent: navigator.userAgent,
      method: "Hash-checked JPEG and independently decoded RGB PNG; natural read first, then default-smoothing resize. Three repeats, last follows source detach/retry. Warm/uncontrolled browser cache; no rendering or timing benchmark.", records, errors}, null, 2);
  } catch (error) { output.textContent = JSON.stringify({failed: String(error), records, errors}, null, 2); }
};
