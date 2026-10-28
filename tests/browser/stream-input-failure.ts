import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { readPlyResponse } from "../../src/model-bytes";
const events: string[] = [];
window.addEventListener("unhandledrejection", event => {
  events.push(String(event.reason));
  if (String(event.reason).includes("Intentional stream input failure")) event.preventDefault();
});
const run = document.querySelector<HTMLButtonElement>("#run")!, status = document.querySelector("#status")!;
run.onclick = async () => {
  run.disabled = true;
  try {
    status.textContent = "读取原始 PLY…";
    const manifest = await (await fetch("/scenes/pipes/scene.json")).json();
    const bytes = new Uint8Array(await readPlyResponse(await fetch(`/scenes/pipes/${manifest.gaussian.url}`), undefined, manifest.gaussian.decodedBytes));
    let requested = 0, failureAt = 0, fail!: () => void;
    const failed = new Promise<void>(resolve => { fail = resolve; });
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (++requested === 1) controller.enqueue(bytes.slice(0, 1048576));
      else { failureAt = performance.now(); controller.error(new Error("Intentional stream input failure")); fail(); }
    } }, {highWaterMark:0});
    const model = new SplatMesh({stream, streamLength:bytes.length,fileType:SplatFileType.PLY,extSplats:true,enableLod:false,lod:false});
    let state = "pending", reason: string | null = null;
    void model.initialized.then(() => {state="resolved";}, error => {state="rejected";reason=String(error);});
    await failed;
    await new Promise(resolve => setTimeout(resolve, 1000));
    const report = {createdAt:new Date().toISOString(),spark:"2.4.0",scene:"pipes",chunkBytes:1048576,readRequests:requested,
      observedAfterFailureMs:performance.now()-failureAt,initializationState:state,reason,streamLocked:stream.locked,unhandledRejections:events,
      method:"Fresh isolated document; one valid PLY prefix then an intentional source error. Observed initialization for 1 second after injection; not a proof of infinite hang. Close this tab to terminate its Worker context."};
    document.querySelector("#result")!.textContent=JSON.stringify(report,null,2);
    status.textContent=`Complete; initialized=${state}; readerLocked=${stream.locked}; unhandled=${events.length}`;
    if (state !== "pending") model.dispose();
  } catch(error) {status.textContent=`FAILED: ${error}`;}
};
