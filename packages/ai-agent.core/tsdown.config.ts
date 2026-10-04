import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/models/index.ts", "src/runtime/index.ts", "src/state/index.ts", "src/tools/index.ts"],
  unbundle: true,
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // `.js` / `.d.ts` to match the `exports` of package.json.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
