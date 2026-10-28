import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
const source = JSON.parse(readFileSync("public/scenes/pipes/scene.json", "utf8"));
export default defineConfig({
  server: { host: "127.0.0.1", port: 5181, strictPort: true },
  plugins: [{ name: "ply-size-failures", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const match = /^\/scenes\/size-(over|short|missing)\/scene\.json$/.exec(request.url ?? "");
      if (!match) return next();
      const data = structuredClone(source); data.id = `size-${match[1]}`;
      // Relative traversal keeps CompareViewer's scene base resolution intact.
      data.gaussian.url = "../pipes/" + source.gaussian.url;
      data.mesh.url = "../pipes/" + source.mesh.url;
      if (match[1] === "missing") delete data.gaussian.decodedBytes;
      else data.gaussian.decodedBytes = match[1] === "over" ? 1048576 : source.gaussian.decodedBytes + 1;
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(data));
    });
  } }],
});
