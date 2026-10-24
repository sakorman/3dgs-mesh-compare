import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { applyView } from "./camera";
import { decodePly } from "./model-bytes";
import { RenderScheduler } from "./render-scheduler";
import { disposeMeshResources } from "./mesh-resources";
import { LoadScope } from "./load-scope";
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
  private currentLoad?: LoadScope;
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
        this.currentLoad?.cancel();
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
    if (this.disposed || this.lost) return;
    this.playing = false;
    this.clear();
    const load = new LoadScope();
    this.currentLoad = load;
    const base = `${import.meta.env.BASE_URL}scenes/${id}/`;
    const progress = (message: string) => {
      load.check();
      this.onProgress(message);
      load.check();
    };
    try {
      const response = await fetch(base + "scene.json", {
        signal: load.signal,
      });
      if (!response.ok) throw new Error("无法读取场景信息");
      const data: SceneData = await response.json();
      load.check();
      this.data = data;
      this.setView(data.views.find((v) => v.heldOut) ?? data.views[0]);

      const [gaussian, mesh] = await Promise.all([
        (async () => {
          progress("正在加载完整高斯模型…");
          const res = await fetch(base + data.gaussian.url, {
            signal: load.signal,
          });
          if (!res.ok) throw new Error("高斯模型下载失败");
          const raw = await res.arrayBuffer();
          load.check();
          const bytes = await decodePly(raw);
          progress("正在解析高斯模型与纹理…");
          const g = new SplatMesh({
            fileBytes: bytes,
            fileType: SplatFileType.PLY,
            enableLod: false,
            lod: false,
            extSplats: true,
          });
          try {
            await g.initialized;
          } catch (error) {
            g.dispose();
            throw error;
          }
          load.own(g, (resource) => {
            this.scenes.gaussian.remove(resource);
            if (this.gaussian === resource) this.gaussian = undefined;
            resource.dispose();
          });
          g.maxSh = 3;
          g.updateGenerator();
          return g;
        })(),
        (async () => {
          const res = await fetch(base + data.mesh.url, {
            signal: load.signal,
          });
          if (!res.ok) throw new Error("Mesh 模型下载失败");
          const bytes = await res.arrayBuffer();
          load.check();
          const gltf = await new GLTFLoader().parseAsync(bytes, base);
          return load.own(gltf.scene, (resource) => {
            this.scenes.mesh.remove(resource);
            if (this.mesh === resource) this.mesh = undefined;
            disposeMeshResources(resource);
          });
        })(),
      ]);
      load.check();
      this.gaussian = gaussian;
      this.mesh = mesh;
      this.scenes.gaussian.add(gaussian);
      this.scenes.mesh.add(mesh);
      progress("正在准备首帧与高斯排序…");
      await this.settle(load.signal);
      load.check();
      this.playing = true;
      return data;
    } catch (error) {
      const obsolete =
        load.signal.aborted || load !== this.currentLoad || this.disposed;
      // Dispose only this load's resources, never a newer scene's objects.
      load.cancel();
      if (this.currentLoad === load) {
        this.currentLoad = undefined;
        this.data = undefined;
        this.view = undefined;
      }
      if (!obsolete) throw error;
    }
  }
  clear() {
    const load = this.currentLoad;
    this.currentLoad = undefined;
    load?.cancel();
    this.data = undefined;
    this.view = undefined;
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
  async settle(signal?: AbortSignal) {
    const load = this.currentLoad;
    const check = () => {
      signal?.throwIfAborted();
      if (this.disposed || this.lost || load !== this.currentLoad) {
        throw new DOMException("场景已取消或不可用", "AbortError");
      }
    };
    check();
    // Keep submitting frames while Spark's asynchronous readback/sort completes.
    // Awaiting update() before the first frame can stall a hidden/offscreen context.
    this.render("gaussian");
    const start = performance.now();
    let quiet = 0;
    while (quiet < 4) {
      if (performance.now() - start > 15000)
        throw new Error("高斯排序未就绪，请重试");
      await nextFrame();
      check();
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
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.preview?.dispose();
    document.removeEventListener("visibilitychange", this.updatePreviewState);
    this.clear();
    this.controls.forEach((c) => c.dispose());
    this.spark.dispose();
    Object.values(this.renderers).forEach((r) => r.dispose());
  }
}
