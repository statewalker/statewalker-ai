// The nightly scenarios (statewalker/statewalker-root#145): scale and load, the 24-hour approval
// expiry on a fake clock, and real-model smoke tests (skipped without a provider key). Run by
// .github/workflows/nightly.yml, never on pull requests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/nightly/**/*.test.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000,
    // One file at a time: the scale scenarios each take the machine's memory and disk.
    fileParallelism: false,
  },
});
