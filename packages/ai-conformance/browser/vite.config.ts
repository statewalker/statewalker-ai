import { defineConfig } from "vite";

// The page and worker the browser runner loads; built once per run (src/browser-deployment.ts).
export default defineConfig({
  root: import.meta.dirname,
  logLevel: "warn",
  build: { target: "es2024", emptyOutDir: true, sourcemap: false },
  worker: { format: "es" },
});
