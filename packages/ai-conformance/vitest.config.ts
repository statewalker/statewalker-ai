import { defineConfig } from "vitest/config";

const browser = process.env.CONFORMANCE_RUNTIME === "browser";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The nightly scenarios (slow, costly or needing a provider key) run in vitest.nightly.config.ts.
    exclude: ["tests/nightly/**", "**/node_modules/**"],
    // CellB in Chromium (SQLite in WASM, every request through the page) is slower than in Node.
    testTimeout: browser ? 120_000 : 60_000,
    hookTimeout: browser ? 180_000 : 10_000,
  },
});
