import "./style.css";
import { CompareViewer, nextFrame } from "./viewer";
import { benchmark } from "./benchmark";
import { quality } from "./metrics";
import type { Backend, Quality, SceneData } from "./types";
const isBenchmark = document.documentElement.dataset.mode === "benchmark";
const labMarkup = `  <section class="measurements" aria-label="性能与效果评测">
    <div class="measure-heading"><div><h2>性能与画质实验</h2><p>测量当前设备的渲染性能与留出视角画质。</p></div><div class="measure-actions"><label for="resolution">渲染长边 <select id="resolution"><option>512</option><option selected>768</option><option>1024</option></select></label><button id="quality" disabled>评测留出画质</button><button class="primary" id="bench" disabled>运行性能对比</button><button id="export" disabled title="下载本次实测报告">导出 JSON</button></div></div>
    <div class="table-wrap"><table><thead><tr><th scope="col">指标</th><th scope="col"><i class="dot gs"></i>3DGS</th><th scope="col"><i class="dot mesh"></i>Mesh</th><th scope="col">测量口径</th></tr></thead><tbody>
      <tr><th scope="row">CPU 提交 <small>中位 / P95</small></th><td id="gs-cpu">—</td><td id="mesh-cpu">—</td><td>主线程渲染提交，不含异步排序线程</td></tr>
      <tr><th scope="row">GPU 绘制 <small>中位</small></th><td id="gs-gpu">—</td><td id="mesh-gpu">—</td><td>计时扩展不可用时显示“不可用”</td></tr>
      <tr><th scope="row">帧率 <small>FPS</small></th><td id="gs-fps">—</td><td id="mesh-fps">—</td><td>两组交替单独采样，受屏幕刷新率限制</td></tr>
      <tr><th scope="row">留出画质 <small>PSNR / SSIM</small></th><td id="gs-quality">—</td><td id="mesh-quality">—</td><td>相同尺寸，全图 RGB；未覆盖区域也计入误差</td></tr>
      <tr><th scope="row">模型文件 <small>MiB</small></th><td id="gs-bytes">—</td><td id="mesh-bytes">—</td><td>3DGS 为 gzip PLY；Mesh 为含纹理的 GLB</td></tr>
    </tbody></table></div>
    <div id="quality-details" hidden></div>
    <p class="measurement-note" id="measurement-note">性能测试固定当前拍摄视角，按 AB / BA / AB / BA 顺序采样，每组 160 帧。漫游与线框用于观察，评测时恢复标准状态。</p>
  </section>
  <details class="method"><summary>数据与评测方法 <span>展开说明</span></summary><div class="method-grid"><div><h3>共用照片与相机</h3><p>默认场景为 web-scan 使用的 ETH3D 管道房与办公室。3DGS 与 Mesh 使用相同训练照片；照片条中的蓝点标识留出照片。所有照片参与过上游 COLMAP 位姿求解，因此这不是完全独立的端到端测试。</p></div><div><h3>重建流程</h3><p>3DGS 使用已有 Brush 10,000 步训练结果，保留 SH3。Mesh 从训练照片进行极线校正、SGBM 立体匹配、左右一致性检查、点云融合与 Poisson 表面重建，再按可见性选择训练照片纹理。它是轻量 CPU 基线，可能出现空洞与接缝，不代表调优后的 OpenMVS 等完整流水线。</p></div><div><h3>计时范围</h3><p id="build-times"></p><p>历史 GPU 训练与本次 CPU Mesh 构建不在同一受控条件下，不能据此推导重建速度倍数。浏览器测试使用固定相机和相同分辨率，不包含模型下载、解析与动态排序开销。</p></div><div><h3>数据与代码许可</h3><p>照片及衍生模型：Schöps 等，ETH3D / CVPR 2017，CC BY-NC-SA 4.0，限非商业用途。项目代码使用 MIT。</p><p><a href="https://www.eth3d.net/datasets" target="_blank" rel="noreferrer">ETH3D 数据集 ↗</a>　<a href="https://github.com/sakorman/web-scan" target="_blank" rel="noreferrer">web-scan 来源 ↗</a></p></div></div></details>
  <dialog id="report-dialog"><div class="report-heading"><h2>JSON 评测报告</h2><button id="close-report">关闭</button></div><p>完整报告包含原始样本、相机与逐视角画质，可下载或选择全文复制。</p><textarea id="report-json" readonly aria-label="完整 JSON 报告"></textarea><div class="report-actions"><button id="select-report">选择全文</button><a id="download-report" class="download-report">下载 JSON 文件</a></div></dialog>
`;
const icon =
  '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m16 3 12 7v13l-12 7-12-7V10Z" stroke="currentColor" stroke-width="1.7"/><path d="m4 10 12 7 12-7M16 17v13M16 3v14" stroke="currentColor" stroke-width="1.7"/><circle cx="16" cy="17" r="3.5" fill="currentColor"/></svg>';
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<header><a class="brand" href="./">${icon}<span>重建对照台</span><span class="brand-sub">3DGS × Mesh</span></a><nav class="header-links"><a class="source-link" href="${isBenchmark ? "./" : "./benchmark.html"}">${isBenchmark ? "返回模型对照" : "评测实验"}</a><a class="source-link" href="https://github.com/sakorman/3dgs-mesh-compare" target="_blank" rel="noreferrer">GitHub ↗</a></nav></header>
<main>
  <div class="intro"><div><h1>3DGS 与 Mesh 重建对比</h1><p>选择场景和拍摄视角，查看两种重建结果。</p></div><div class="scene-switch" role="group" aria-label="选择场景"><button data-scene="pipes" class="active" aria-pressed="true">管道房 <span>14 张</span></button><button data-scene="office" aria-pressed="false">办公室 <span>26 张</span></button></div></div>
  <section class="workspace" aria-label="重建效果对照">
    <div class="toolbar"><div class="view-picker"><label for="view">拍摄视角</label><select id="view" disabled></select><span id="split-badge" class="badge">留出视角</span></div><div class="view-tools"><button id="orbit" aria-pressed="false" disabled>自由查看</button><button id="reset" disabled>重置</button><span class="divider"></span><button id="reference" aria-pressed="false" disabled>对照原照片</button><button id="wire" aria-pressed="false" disabled>Mesh 线框</button></div></div>
    <div class="viewports" id="viewports">
      <article class="viewport"><div class="pane-title"><h2><i class="dot gs"></i>3D Gaussian Splatting</h2><span id="gs-count">加载模型…</span></div><div class="surface" id="gs-surface"><img class="reference" alt="当前视角的去畸变原照片" hidden><div class="photo-label" hidden>原照片</div></div><div class="pane-caption"><span>各向异性高斯 · SH3 颜色</span><span id="gs-size">—</span></div></article>
      <article class="viewport"><div class="pane-title"><h2><i class="dot mesh"></i>传统 Mesh</h2><span id="mesh-count">加载模型…</span></div><div class="surface" id="mesh-surface"><img class="reference" alt="当前视角的去畸变原照片" hidden><div class="photo-label" hidden>原照片</div></div><div class="pane-caption"><span>立体匹配 + Poisson · 纹理网格</span><span id="mesh-size">—</span></div></article>
    </div>
    <div class="photo-strip" id="photos" aria-label="输入照片与视角"></div>
    <div class="workspace-footer"><span id="scene-info">正在加载 web-scan 场景…</span><span>相同相机 · 相同画幅 · 同步视角</span></div>
  </section>
  <div class="status-row"><span id="status" role="status" aria-live="polite">正在准备真实重建数据…</span><button id="retry" hidden>重新加载</button><button id="cancel" hidden>取消测试</button></div>
  ${isBenchmark ? labMarkup : ""}
  <footer><span>ETH3D · CC BY-NC-SA 4.0</span><a href="https://github.com/sakorman/3dgs-mesh-compare#数据与重建" target="_blank" rel="noreferrer">数据与方法</a></footer>
</main>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const button = (id: string) => $<HTMLButtonElement>(id);
const status = (s: string, error = false) => {
  $("status").textContent = s;
  $("status").classList.toggle("error", error);
};
const number = (n: number) => n.toLocaleString("zh-CN");
const mib = (n: number) => (n / 1024 / 1024).toFixed(2);
let viewer: CompareViewer;
let data: SceneData;
let sceneId = "pipes";
let loadRequest = 0;
let viewIndex = 0;
let ready = false;
let controller: AbortController | undefined;
let orbit = false,
  wire = false,
  reference = false;
let perf: Awaited<ReturnType<typeof benchmark>> | undefined;
let qualityReport:
  | {
      resolution: number[];
      views: {
        index: number;
        name: string;
        gaussian: Quality;
        mesh: Quality;
      }[];
      averages: Record<Backend, Quality>;
    }
  | undefined;
const controlIds = [
  "orbit",
  "reset",
  "reference",
  "wire",
  ...(isBenchmark ? ["quality", "bench"] : []),
];
function lock(value: boolean) {
  for (const id of controlIds) button(id).disabled = value || !ready;
  $<HTMLSelectElement>("view").disabled = value || !ready;
  if (isBenchmark) $<HTMLSelectElement>("resolution").disabled = value;
  document
    .querySelectorAll<HTMLButtonElement>("[data-scene]")
    .forEach((b) => (b.disabled = value));
  document
    .querySelectorAll<HTMLButtonElement>("[data-photo]")
    .forEach((b) => (b.disabled = value || !ready));
  if (isBenchmark)
    button("export").disabled = value || (!perf && !qualityReport);
}
function clearResults() {
  if (!isBenchmark) return;
  perf = undefined;
  qualityReport = undefined;
  for (const side of ["gs", "mesh"])
    for (const key of ["cpu", "gpu", "fps", "quality"])
      $(`${side}-${key}`).textContent = "—";
  $("quality-details").hidden = true;
  button("export").disabled = true;
}
function showReference(value: boolean) {
  reference = value;
  document.querySelectorAll<HTMLImageElement>(".reference").forEach((img) => {
    img.src = `${import.meta.env.BASE_URL}scenes/${sceneId}/${data.views[viewIndex].url}`;
    img.hidden = !value;
  });
  document
    .querySelectorAll<HTMLElement>(".photo-label")
    .forEach((l) => (l.hidden = !value));
  button("reference").setAttribute("aria-pressed", String(value));
  button("reference").textContent = value ? "返回重建模型" : "对照原照片";
}
function setOrbit(value: boolean) {
  orbit = value;
  viewer.orbit(value);
  button("orbit").setAttribute("aria-pressed", String(value));
  button("orbit").textContent = value ? "返回拍摄视角" : "自由查看";
  if (value) showReference(false);
}
function setWire(value: boolean) {
  wire = value;
  viewer.wireframe(value);
  button("wire").setAttribute("aria-pressed", String(value));
}
function selectView(index: number) {
  viewIndex = index;
  viewer.setView(data.views[index]);
  setOrbit(false);
  showReference(reference);
  $<HTMLSelectElement>("view").value = String(index);
  $("split-badge").textContent = data.views[index].heldOut
    ? "留出视角"
    : "训练视角";
  $("split-badge").classList.toggle("training", !data.views[index].heldOut);
  document.querySelectorAll<HTMLButtonElement>("[data-photo]").forEach((b) => {
    b.classList.toggle("selected", Number(b.dataset.photo) === index);
    b.setAttribute("aria-pressed", String(Number(b.dataset.photo) === index));
  });
  if (perf) {
    perf = undefined;
    for (const side of ["gs", "mesh"])
      for (const key of ["cpu", "gpu", "fps"])
        $(`${side}-${key}`).textContent = "—";
    button("export").disabled = !qualityReport;
  }
}
async function loadScene(id: string) {
  const request = ++loadRequest;
  sceneId = id;
  ready = false;
  lock(true);
  clearResults();
  button("retry").hidden = true;
  status("正在加载照片与真实三维模型…");
  document.querySelectorAll<HTMLButtonElement>("[data-scene]").forEach((b) => {
    b.classList.toggle("active", b.dataset.scene === id);
    b.setAttribute("aria-pressed", String(b.dataset.scene === id));
  });
  try {
    const loaded = await viewer.load(id);
    if (!loaded) return;
    data = loaded;
    ready = true;
    orbit = false;
    wire = false;
    reference = false;
    $("gs-count").textContent = number(data.gaussian.count) + " 个高斯";
    $("mesh-count").textContent = number(data.mesh.triangles) + " 个三角形";
    $("gs-size").textContent = mib(data.gaussian.bytes) + " MiB";
    $("mesh-size").textContent = mib(data.mesh.bytes) + " MiB";
    if (isBenchmark) {
      $("gs-bytes").textContent = mib(data.gaussian.bytes);
      $("mesh-bytes").textContent = mib(data.mesh.bytes);
    }
    $("scene-info").textContent =
      `${data.source.dataset} · ${data.trainingViews} 张训练 / ${data.evaluationViews} 张留出`;
    if (isBenchmark)
      $("build-times").textContent =
        `重建记录：3DGS 训练与导出 ${data.gaussian.seconds.toFixed(1)} 秒（web-scan 历史任务）；Mesh 构建 ${data.mesh.seconds.toFixed(2)} 秒（CPU）。两者均不含首次 SfM。`;
    const select = $<HTMLSelectElement>("view");
    select.replaceChildren();
    $("photos").replaceChildren();
    data.views.forEach((v, i) => {
      select.add(
        new Option(`照片 ${String(i + 1).padStart(2, "0")}`, String(i)),
      );
      const b = document.createElement("button");
      b.dataset.photo = String(i);
      b.title = `照片 ${i + 1} · ${v.heldOut ? "留出" : "训练"}`;
      b.setAttribute("aria-label", b.title);
      const img = new Image();
      img.src = `${import.meta.env.BASE_URL}scenes/${id}/${v.url}`;
      img.alt = "";
      img.loading = "lazy";
      const label = document.createElement("span");
      label.textContent = String(i + 1).padStart(2, "0");
      b.append(img, label);
      if (v.heldOut) b.classList.add("holdout");
      b.onclick = () => selectView(i);
      $("photos").append(b);
    });
    selectView(data.views.findIndex((v) => v.heldOut));
    setWire(false);
    status("加载完成，可切换照片或自由查看。");
  } catch (e) {
    if (request !== loadRequest) return;
    ready = false;
    viewer.playing = false;
    status(`加载失败：${message(e)}。请重试。`, true);
    button("retry").hidden = false;
  } finally {
    if (request === loadRequest) lock(false);
  }
}
function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function standard() {
  setOrbit(false);
  setWire(false);
  showReference(false);
  viewer.setView(data.views[viewIndex]);
}
function begin() {
  standard();
  lock(true);
  controller = new AbortController();
  button("cancel").hidden = false;
}
function finish() {
  controller = undefined;
  button("cancel").hidden = true;
  lock(false);
  viewer.playing = !viewer.lost;
}
if (isBenchmark) {
  button("bench").onclick = async () => {
    begin();
    perf = undefined;
    for (const side of ["gs", "mesh"])
      for (const key of ["cpu", "gpu", "fps"])
        $(`${side}-${key}`).textContent = "—";
    try {
      perf = await benchmark(viewer, controller!.signal, status);
      for (const kind of ["gaussian", "mesh"] as const) {
        const p = perf[kind],
          side = kind === "gaussian" ? "gs" : "mesh";
        $(`${side}-cpu`).textContent =
          `${p.cpuMedian.toFixed(2)} / ${p.cpuP95.toFixed(2)} ms`;
        $(`${side}-gpu`).textContent =
          p.gpuMedian === null ? "不可用" : p.gpuMedian.toFixed(2) + " ms";
        $(`${side}-fps`).textContent = p.fps.toFixed(1);
      }
      status(
        `性能采样完成 · ${viewer.width} × ${viewer.height} · 每组 160 帧 · 固定照片 ${viewIndex + 1}`,
      );
    } catch (e) {
      for (const side of ["gs", "mesh"])
        for (const key of ["cpu", "gpu", "fps"])
          $(`${side}-${key}`).textContent = "—";
      status(message(e), true);
    } finally {
      finish();
    }
  };
  button("quality").onclick = async () => {
    begin();
    viewer.playing = false;
    qualityReport = undefined;
    for (const side of ["gs", "mesh"]) $(`${side}-quality`).textContent = "—";
    $("quality-details").hidden = true;
    const original = viewIndex;
    const rows: {
      index: number;
      name: string;
      gaussian: Quality;
      mesh: Quality;
    }[] = [];
    try {
      const check = () => {
        if (controller!.signal.aborted) throw new Error("评测已取消");
        if (document.hidden || viewer.lost)
          throw new Error("页面进入后台或显卡上下文丢失，评测已作废");
      };
      const views = data.views
        .map((v, i) => ({ v, i }))
        .filter((x) => x.v.heldOut);
      for (const [n, { v, i }] of views.entries()) {
        check();
        status(`留出画质 ${n + 1}/${views.length} · 照片 ${i + 1}`);
        viewer.setView(v);
        await viewer.settle();
        check();
        const target = await viewer.reference(v);
        const gaussian = quality(
          viewer.pixels("gaussian"),
          target,
          viewer.width,
          viewer.height,
        );
        await nextFrame();
        check();
        const mesh = quality(
          viewer.pixels("mesh"),
          target,
          viewer.width,
          viewer.height,
        );
        rows.push({ index: i, name: v.image_name, gaussian, mesh });
      }
      check();
      const avg = (k: Backend): Quality => ({
        psnr: rows.every((r) => r[k].psnr !== null)
          ? rows.reduce((a, r) => a + r[k].psnr!, 0) / rows.length
          : null,
        ssim: rows.reduce((a, r) => a + r[k].ssim, 0) / rows.length,
        mae: rows.reduce((a, r) => a + r[k].mae, 0) / rows.length,
      });
      qualityReport = {
        resolution: [viewer.width, viewer.height],
        views: rows,
        averages: { gaussian: avg("gaussian"), mesh: avg("mesh") },
      };
      for (const kind of ["gaussian", "mesh"] as const) {
        const q = qualityReport.averages[kind];
        $(`${kind === "gaussian" ? "gs" : "mesh"}-quality`).textContent =
          `${q.psnr?.toFixed(2) ?? "∞"} dB / ${q.ssim.toFixed(4)}`;
      }
      $("quality-details").innerHTML =
        `<strong>${rows.length} 个留出视角 · ${viewer.width} × ${viewer.height}</strong><span>数值为逐视角等权平均。SSIM 使用 11 × 11 高斯窗口，σ = 1.5。</span>`;
      $("quality-details").hidden = false;
      status("留出画质评测完成，逐视角结果可导出。");
    } catch (e) {
      for (const side of ["gs", "mesh"]) $(`${side}-quality`).textContent = "—";
      $("quality-details").hidden = true;
      status(message(e), true);
    } finally {
      viewer.setView(data.views[original]);
      await viewer.settle().catch(() => {});
      finish();
    }
  };
}
button("cancel").onclick = () => controller?.abort();
button("retry").onclick = () => loadScene(sceneId);
button("orbit").onclick = () => {
  setOrbit(!orbit);
  status(
    orbit
      ? "拖动任一视图同步旋转，滚轮缩放，右键平移。"
      : "已返回标定拍摄视角。",
  );
};
button("reset").onclick = () => {
  standard();
  status("已重置为当前拍摄视角。");
};
button("wire").onclick = () => {
  setWire(!wire);
  if (wire) showReference(false);
};
button("reference").onclick = () => {
  if (orbit) setOrbit(false);
  showReference(!reference);
};
$<HTMLSelectElement>("view").onchange = (e) =>
  selectView(Number((e.target as HTMLSelectElement).value));
if (isBenchmark)
  $<HTMLSelectElement>("resolution").onchange = (e) => {
    viewer.setSize(Number((e.target as HTMLSelectElement).value));
    clearResults();
    status(
      `渲染尺寸已改为 ${viewer.width} × ${viewer.height}，请重新运行评测。`,
    );
  };
document
  .querySelectorAll<HTMLButtonElement>("[data-scene]")
  .forEach((b) => (b.onclick = () => loadScene(b.dataset.scene!)));
if (isBenchmark)
  button("export").onclick = () => {
    const report = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      scene: sceneId,
      source: data.source,
      models: { gaussian: data.gaussian, mesh: data.mesh },
      camera: { index: viewIndex, ...data.views[viewIndex] },
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        screenRefreshRate: "unknown",
        devicePixelRatio: devicePixelRatio,
        drawingPixelRatio: 1,
      },
      performance: perf ?? null,
      quality: qualityReport ?? null,
      limitations: data.limitations,
    };
    const json = JSON.stringify(report, null, 2);
    const dialog = $<HTMLDialogElement>("report-dialog");
    const textarea = $<HTMLTextAreaElement>("report-json");
    textarea.value = json;
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const link = $<HTMLAnchorElement>("download-report");
    link.href = url;
    link.download = `${sceneId}-comparison-${Date.now()}.json`;
    button("close-report").onclick = () => dialog.close();
    button("select-report").onclick = () => {
      textarea.focus();
      textarea.select();
    };
    dialog.addEventListener("close", () => URL.revokeObjectURL(url), {
      once: true,
    });
    dialog.showModal();
  };
window.addEventListener("resize", () => {
  if (controller) controller.abort();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) controller?.abort();
});
try {
  viewer = new CompareViewer($("gs-surface"), $("mesh-surface"));
  viewer.onProgress = status;
  viewer.onError = (s) => {
    controller?.abort();
    ready = false;
    lock(false);
    status(s, true);
  };
  await loadScene("pipes");
} catch (e) {
  status("无法启动 WebGL2：" + message(e), true);
  button("retry").hidden = true;
  lock(true);
}
window.addEventListener("pagehide", () => viewer?.dispose(), { once: true });
