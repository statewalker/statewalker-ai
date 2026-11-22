import { defineConfig } from "vitest/config";

// The built page in Chromium (tests/page), apart from the shell's tests against CellB Node.
export default defineConfig({
  test: { include: ["tests/page/**/*.test.ts"], testTimeout: 60_000 },
});
