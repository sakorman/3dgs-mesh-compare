import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 3200,
    rollupOptions: {
      input: { main: "index.html", benchmark: "benchmark.html" },
    },
  },
  server: { port: 5178, strictPort: true },
});
