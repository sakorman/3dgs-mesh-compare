import { defineConfig } from "vite";

// Local static-browser regression build; not part of the deployed site.
export default defineConfig({
  base: "/",
  build: {
    target: "es2022",
    outDir: ".qa/history-build",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        lifecycle: "tests/browser/page-lifecycle.html",
        away: "tests/browser/history-away.html",
        "page-baseline": ".qa/page-main-baseline.ts",
      },
      output: { entryFileNames: "assets/[name].js" },
    },
  },
});
