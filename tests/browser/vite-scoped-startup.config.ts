import {defineConfig, mergeConfig} from "vite";
import httpModel from "./vite-http-model.config";

// Keep dynamic runtime imports from triggering a dependency reload during timing.
export default mergeConfig(httpModel, defineConfig({
  cacheDir: ".qa/scoped-startup/vite-cache",
  optimizeDeps: {
    noDiscovery: true,
    include: ["three", "three/addons/controls/OrbitControls.js",
      "three/addons/loaders/GLTFLoader.js", "three/addons/postprocessing/Pass.js"],
  },
}));
