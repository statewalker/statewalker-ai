import { defineConfig } from "vitest/config";

const runtime = process.env.CONFORMANCE_RUNTIME ?? "node";
const browser = runtime === "browser";
// CellD and workerd: a process per deployment, reached over HTTP.
const processes = runtime === "celld" || runtime === "workerd";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The nightly scenarios (slow, costly or needing a provider key) run in vitest.nightly.config.ts.
    exclude: ["tests/nightly/**", "**/node_modules/**"],
    // CellB in Chromium (SQLite in WASM, every request through the page) is slower than in Node.
    testTimeout: browser || processes ? 120_000 : 60_000,
    hookTimeout: browser || processes ? 180_000 : 10_000,
  },
});
