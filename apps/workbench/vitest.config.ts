import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/page/**", "**/node_modules/**"],
    testTimeout: 60_000,
  },
});
