import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/local-models.ts",
    "src/webllm.ts",
    "src/code-engines.ts",
    "src/pyodide.ts",
    "src/wasmer.ts",
  ],
  unbundle: true,
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
