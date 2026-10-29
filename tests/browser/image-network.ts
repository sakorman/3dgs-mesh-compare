import { decodeImage } from "../../src/decode-image";

const output = document.querySelector("#result")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const server = "http://127.0.0.1:5191";
const state = async () => (await fetch(`${server}/__qa/state.json`)).json();
const errors: string[] = [];
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.addEventListener("error", e => errors.push(e.message));
button.onclick = async () => {
  button.disabled = true;
  const records: object[] = [];
  try {
    for (const scene of ["pipes", "office"]) {
      output.textContent = `Waiting for ${scene} partial JPEG`;
      const data = await (await fetch(`/scenes/${scene}/scene.json`)).json();
      const view = data.views.find((v: {heldOut: boolean}) => v.heldOut);
      const path = `/scenes/${scene}/${view.url}`;
      const image = new Image(), c = new AbortController();
      let nativeState = "pending", outcome = "pending";
      const nativeDecode = image.decode.bind(image);
      image.decode = () => nativeDecode().then(() => {nativeState = "fulfilled";}, e => {nativeState = e.name; throw e;});
      const pending = decodeImage(image, server + path, c.signal).then(() => {outcome = "fulfilled";}, e => {outcome = e.name;});
      const until = performance.now() + 10000;
      while (!(await state())[path]?.sentBytes) {
        if (performance.now() > until) throw new Error("Partial JPEG did not arrive");
        await pause(20);
      }
      const nativeBefore = nativeState;
      c.abort();
      await Promise.race([pending, pause(1000).then(() => {if (outcome === "pending") throw new Error("Abort still pending");})]);
      await pause(150);
      const request = (await state())[path];
      const sourceDetached = !image.hasAttribute("src");
      const retry = await decodeImage(new Image(), path);
      const row = {scene, nativeBefore, outcome, sourceDetached, nativeAfter: nativeState, request,
        retryDimensions: [retry.naturalWidth, retry.naturalHeight]};
      records.push(row);
      if (nativeBefore !== "pending" || outcome !== "AbortError" || !sourceDetached || !retry.naturalWidth) throw new Error(`Failed ${scene}`);
    }
    output.textContent = JSON.stringify({createdAt: new Date().toISOString(), records, errors,
      method: "Native Image.decode; real HTTP JPEG stalled after 1024 bytes; 150ms server-close observation. No bandwidth or cancellation latency claim."},null,2);
  } catch (error) { output.textContent = JSON.stringify({failed:String(error),records,errors},null,2); }
};
