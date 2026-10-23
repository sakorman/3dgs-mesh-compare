import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { applyView } from "./camera";
import { decodePly } from "./model-bytes";
import { RenderScheduler } from "./render-scheduler";
import type { Backend, SceneData, View } from "./types";
export const nextFrame = () =>
  new Promise<number>((resolve) => requestAnimationFrame(resolve));
export class CompareViewer {
  camera = new THREE.PerspectiveCamera(60, 1, 0.005, 200);
  renderers: Record<Backend, THREE.WebGLRenderer>;
  scenes = { gaussian: new THREE.Scene(), mesh: new THREE.Scene() };
  spark: SparkRenderer;
  gaussian?: SplatMesh;
  mesh?: THREE.Group;
  controls: OrbitControls[] = [];
  data?: SceneData;
  view?: View;
  width = 768;
  height = 504;
  private previewEnabled = true;
  private preview?: RenderScheduler;
  get playing() {
    return this.previewEnabled;
  }
  set playing(enabled: boolean) {
    this.previewEnabled = enabled;
    this.updatePreviewState();
  }
  private updatePreviewState = () => {
    this.preview?.setEnabled(
      this.previewEnabled && !document.hidden && !this.lost && !this.disposed,
    );
  };
  disposed = false;
  lost = false;
  onError = (s: string) => {};
  onProgress = (s: string) => {};
  private loadVersion = 0;
  constructor(left: HTMLElement, right: HTMLElement) {
    const make = (parent: HTMLElement, label: string) => {
      const r = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: true,
      });
      r.setPixelRatio(1);
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.setClearColor(0x000000, 1);
      r.domElement.setAttribute("aria-label", label);
      r.domElement.tabIndex = 0;
      parent.prepend(r.domElement);
      r.domElement.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.lost = true;
        this.playing = false;
        this.onError("显卡上下文丢失，请刷新页面重新加载。");
      });
      return r;
    };
    this.renderers = {
      gaussian: make(left, "3DGS 三维视图"),
      mesh: make(right, "Mesh 三维视图"),
    };
    this.spark = new SparkRenderer({
      renderer: this.renderers.gaussian,
      enableLod: false,
      sortRadial: false,
      onDirty: () => this.preview?.invalidate(),
    });
    this.scenes.gaussian.add(this.spark);
    this.preview = new RenderScheduler(() => {
      this.render("gaussian");
      this.render("mesh");
    });
    document.addEventListener("visibilitychange", this.updatePreviewState);
    this.updatePreviewState();
  }
  async load(id: string) {
    const version = ++this.loadVersion;
    this.playing = false;
    this.clear();
    const base = `${import.meta.env.BASE_URL}scenes/${id}/`;
    const response = await fetch(base + "scene.json");
    if (!response.ok) throw new Error("无法读取场景信息");
    const data: SceneData = await response.json();
    this.data = data;
    this.setView(data.views.find((v) => v.heldOut) ?? data.views[0]);
    const results = await Promise.allSettled([
      (async () => {
        this.onProgress("正在加载完整高斯模型…");
        const res = await fetch(base + data.gaussian.url);
        if (!res.ok || !res.body) throw new Error("高斯模型下载失败");
        const bytes = await decodePly(await res.arrayBuffer());
        this.onProgress("正在解析高斯模型与纹理…");
        const g = new SplatMesh({
          fileBytes: bytes,
          fileType: SplatFileType.PLY,
          enableLod: false,
          lod: false,
          extSplats: true,
        });
        try {
          await g.initialized;
        } catch (e) {
          g.dispose();
          throw e;
        }
        g.maxSh = 3;
        g.updateGenerator();
        return g;
      })(),
      new GLTFLoader().loadAsync(base + data.mesh.url).then((g) => g.scene),
    ]);
    if (
      version !== this.loadVersion ||
      this.disposed ||
      results.some((r) => r.status === "rejected")
    ) {
      results.forEach((r) => {
        if (r.status === "fulfilled") {
          if (r.value instanceof SplatMesh) r.value.dispose();
          else this.disposeMesh(r.value);
        }
      });
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return;
    }
    this.gaussian = (results[0] as PromiseFulfilledResult<SplatMesh>).value;
    this.mesh = (results[1] as PromiseFulfilledResult<THREE.Group>).value;
    this.scenes.gaussian.add(this.gaussian);
    this.scenes.mesh.add(this.mesh);
    this.onProgress("正在准备首帧与高斯排序…");
    await this.settle();
    this.preview?.invalidate();
    this.playing = true;
    return data;
  }
  private disposeMesh(mesh: THREE.Group) {
    mesh.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        materials.forEach((m) => {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        });
      }
    });
  }
  clear() {
    if (this.gaussian) {
      this.scenes.gaussian.remove(this.gaussian);
      this.gaussian.dispose();
      this.gaussian = undefined;
    }
    if (this.mesh) {
      this.scenes.mesh.remove(this.mesh);
      this.disposeMesh(this.mesh);
      this.mesh = undefined;
    }
    this.preview?.invalidate();
  }
  setSize(width: number) {
    this.width = width;
    this.height = Math.round(
      (width * (this.view?.height ?? 1051)) / (this.view?.width ?? 1600),
    );
    for (const r of Object.values(this.renderers)) {
      r.setSize(this.width, this.height, false);
      r.domElement.parentElement!.style.aspectRatio = `${this.width}/${this.height}`;
    }
    this.preview?.invalidate();
  }
  setView(view: View) {
    this.view = view;
    this.controls.forEach((c) => c.dispose());
    this.controls = [];
    applyView(this.camera, view);
    this.setSize(this.width);
    this.preview?.invalidate();
  }
  orbit(enabled: boolean) {
    if (!enabled) {
      if (this.view) this.setView(this.view);
      return;
    }
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      this.camera.quaternion,
    );
    const target = this.camera.position.clone().addScaledVector(forward, 0.6);
    this.controls.forEach((c) => c.dispose());
    this.controls = Object.values(this.renderers).map((renderer) => {
      const control = new OrbitControls(this.camera, renderer.domElement);
      control.target = target; // Both canvases share the pan/orbit pivot.
      control.enableDamping = false;
      control.minDistance = 0.02;
      control.maxDistance = 10;
      control.addEventListener("change", () => {
        this.preview?.invalidate();
      });
      control.update();
      return control;
    });
  }
  wireframe(enabled: boolean) {
    this.mesh?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(
          (m) => ((m as THREE.MeshBasicMaterial).wireframe = enabled),
        );
      }
    });
    this.preview?.invalidate();
  }
  render(kind: Backend) {
    this.renderers[kind].render(this.scenes[kind], this.camera);
  }
  async settle() {
    // Keep submitting frames while Spark's asynchronous readback/sort completes.
    // Awaiting update() before the first frame can stall a hidden/offscreen context.
    this.render("gaussian");
    const start = performance.now();
    let quiet = 0;
    while (quiet < 4) {
      if (performance.now() - start > 15000)
        throw new Error("高斯排序未就绪，请重试");
      await nextFrame();
      this.render("gaussian");
      quiet = this.spark.sorting || this.spark.sortDirty ? 0 : quiet + 1;
    }
    this.render("mesh");
  }
  pixels(kind: Backend) {
    this.render(kind);
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(this.renderers[kind].domElement, 0, 0);
    return ctx.getImageData(0, 0, this.width, this.height).data;
  }
  async reference(view: View) {
    const image = new Image();
    image.src = `${import.meta.env.BASE_URL}scenes/${this.data!.id}/${view.url}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, this.width, this.height);
    return ctx.getImageData(0, 0, this.width, this.height).data;
  }
  dispose() {
    this.disposed = true;
    this.loadVersion++;
    this.preview?.dispose();
    document.removeEventListener("visibilitychange", this.updatePreviewState);
    this.clear();
    this.controls.forEach((c) => c.dispose());
    this.spark.dispose();
    Object.values(this.renderers).forEach((r) => r.dispose());
  }
}
