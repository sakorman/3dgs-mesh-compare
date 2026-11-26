import "../../src/main";

const result = document.querySelector<HTMLElement>("#qa-result")!;
const toggle = document.querySelector<HTMLButtonElement>("#reference")!;
const images = Array.from(document.querySelectorAll<HTMLImageElement>(".reference"));
const layers = document.querySelectorAll<HTMLElement>(".reference, .photo-label");
const right = images[1];

function check(ok: boolean, message: string) {
  if (!ok) throw new Error(message);
}

async function waitFor(condition: () => boolean) {
  const until = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > until) throw new Error("Timed out waiting for the reference overlay");
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

const hidden = () => Array.from(layers).every(layer => layer.hidden);
const visible = () => Array.from(layers).every(layer => !layer.hidden);
const decode = right.decode.bind(right);

try {
  // Let the left image finish while the right pane's decode remains outstanding.
  let resolveRight!: () => void;
  let rejectRight!: (error: Error) => void;
  right.decode = () => new Promise<void>((resolve, reject) => {
    resolveRight = resolve;
    rejectRight = reject;
  });
  toggle.click();
  await images[0].decode();
  check(hidden(), "One decoded pane exposed a partial comparison");
  resolveRight();
  await waitFor(visible);

  const view = document.querySelector<HTMLSelectElement>("#view")!;
  view.value = "1";
  view.dispatchEvent(new Event("change"));
  await images[0].decode();
  check(hidden(), "Previous reference remained visible after a view change");
  const rejectObsolete = rejectRight;
  toggle.click();
  right.decode = decode;
  toggle.click();
  await waitFor(visible);
  rejectObsolete(new Error("Obsolete reference failed"));
  await new Promise(resolve => setTimeout(resolve, 0));
  check(visible() && images.every(img => img.currentSrc.endsWith("/01.jpg")),
    "Late failure affected the new reference");

  toggle.click();
  right.decode = () => Promise.reject(new Error("Current reference failed"));
  toggle.click();
  await waitFor(() => toggle.getAttribute("aria-pressed") === "false");
  check(hidden() && images.every(img => !img.hasAttribute("src")),
    "Failed reference retained an image or label");
  check(document.querySelector("#status")!.textContent!.includes("重试"),
    "Reference failure did not explain how to retry");
  right.decode = decode;
  toggle.click();
  await waitFor(visible);
  result.textContent = "PASS";
} catch (error) {
  result.textContent = String(error);
  throw error;
} finally {
  right.decode = decode;
}
