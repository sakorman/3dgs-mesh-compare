import { hashHex, sha256 } from "./paired-model";

export const hash = (data: Uint8ClampedArray) => sha256(new Uint8Array(data)).then(hashHex);
const unique = new Map<string, Uint8ClampedArray>();
export function read(image: HTMLImageElement, w: number, h: number, cpu: boolean) {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const ctx = cpu ? canvas.getContext("2d", {willReadFrequently: true})! : canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return {data, canvas, attributes: ctx.getContextAttributes()};
}
export function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let changed = 0, max = 0, sum = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) changed++; max = Math.max(max, d); sum += d; }
  return {changedChannels: changed, maxAbsolute: max, meanAbsolute: sum / a.length};
}
export async function keep(data: Uint8ClampedArray, label: string) {
  const digest = await hash(data);
  if (!unique.has(digest)) {
    unique.set(digest, data);
    const link = document.createElement("a");
    link.textContent = `${label} ${digest}`; link.download = `${digest}.rgba`;
    link.href = URL.createObjectURL(new Blob([new Uint8Array(data)]));
    document.querySelector("#files")!.append(link);
  }
  return digest;
}
