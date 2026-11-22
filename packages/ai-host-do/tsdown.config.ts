import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/browser.ts"],
  unbundle: true,
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
