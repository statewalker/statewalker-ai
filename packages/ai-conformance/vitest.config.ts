import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The nightly scenarios (slow, costly or needing a provider key) run in vitest.nightly.config.ts.
    exclude: ["tests/nightly/**", "**/node_modules/**"],
    testTimeout: 60_000,
  },
});
