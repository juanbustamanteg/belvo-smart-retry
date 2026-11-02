import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Default: built bundle served by FastAPI on one origin; Vite dev server proxies /api to it.
// Mode "demo": static GitHub Pages build where the API runs in the browser (src/demo/backend.ts).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "demo" ? "/belvo-smart-retry/" : "/",
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { outDir: mode === "demo" ? "dist-demo" : "dist", sourcemap: false },
}));
