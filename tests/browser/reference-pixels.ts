import { decodeImage } from "../../src/decode-image";
import type { SceneData } from "../../src/types";
import { read, diff, keep } from "../helpers/reference-pixels";

const output = document.querySelector("#result")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
run.onclick = async () => {
  run.disabled = true;
  const records: object[] = [];
  try {
    for (const scene of ["pipes", "office"]) {
      const data: SceneData = await (await fetch(`/scenes/${scene}/scene.json`)).json();
      for (const view of data.views.filter(v => v.heldOut)) {
        const w = 768, h = Math.round(w * view.height / view.width);
        let control: Uint8ClampedArray | undefined;
        for (let repeat = 0; repeat < 3; repeat++) {
          for (const cpu of [false, true]) for (const originalFirst of [false, true]) {
            output.textContent = `${scene} ${view.image_name} / ${repeat} / ${cpu} / ${originalFirst}`;
            const image = await decodeImage(new Image(), `/scenes/${scene}/${view.url}`);
            let natural, scaled;
            if (originalFirst) {
              natural = read(image, image.naturalWidth, image.naturalHeight, cpu);
              scaled = read(image, w, h, cpu);
            } else {
              scaled = read(image, w, h, cpu);
              natural = read(image, image.naturalWidth, image.naturalHeight, cpu);
            }
            control ??= scaled.data;
            if (scene === "office" && repeat === 0 && !originalFirst && view === data.views[0]) {
              const label = document.createElement("p"); label.textContent = cpu ? "频繁读取画布" : "默认画布";
              document.querySelector("#images")!.append(label, scaled.canvas);
            }
            records.push({scene, view: view.image_name, repeat, cpu, originalFirst,
              naturalSize: [image.naturalWidth, image.naturalHeight], scaledSize: [w, h],
              attributes: scaled.attributes, naturalHash: await keep(natural.data, `${scene}-natural`),
              scaledHash: await keep(scaled.data, `${scene}-scaled`), differenceFromFirst: diff(control, scaled.data)});
            image.removeAttribute("src");
          }
        }
      }
    }
    output.textContent = JSON.stringify({createdAt: new Date().toISOString(), baseline: "0344969", userAgent: navigator.userAgent,
      method: "HTMLImageElement.decode, fresh Canvas2D per read, default smoothing; native-size readback is not an independent raw JPEG decoder. Repeated URLs, uncontrolled browser cache. No models or timing claims.",
      records, errors}, null, 2);
  } catch (error) { output.textContent = JSON.stringify({failed: String(error), records, errors}, null, 2); }
};
