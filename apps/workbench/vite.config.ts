import { defineConfig } from "vite";

// The page and its harness worker; the harness itself is built by scripts/build-harness.mjs into
// public/harness/ (CellB's builder: Vite can't bundle the Worker project itself).
export default defineConfig({
  base: "./",
  build: { target: "es2024" },
  worker: { format: "es" },
});
