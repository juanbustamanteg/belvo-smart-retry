import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev only: Vite on 127.0.0.1:5173 proxies /api to the FastAPI server on 127.0.0.1:8000.
// Normal launch serves the built bundle from FastAPI on one origin.
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8000" } },
  build: { outDir: "dist", sourcemap: false },
});
