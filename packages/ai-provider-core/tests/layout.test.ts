import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

describe("ai-provider-core layout", () => {
  it("has src/api/, src/core/, src/composition/ resolvable", async () => {
    await Promise.all([
      import("../src/api/intents.js"),
      import("../src/api/types.js"),
      import("../src/core/engine-detection.js"),
      import("../src/composition/adapters.js"),
      import("../src/composition/ai-provider-core.js"),
    ]);
  });

  it("exposes a single-ctx default activator from src/index.ts", async () => {
    const mod = (await import("../src/index.js")) as { default?: unknown };
    expect(typeof mod.default).toBe("function");
    expect((mod.default as (ctx: Record<string, unknown>) => unknown).length).toBe(1);
  });

  it("declares a single canonical entry in package.json exports (no legacy subpaths)", () => {
    const exports = (pkg as { exports: Record<string, unknown> }).exports;
    const keys = Object.keys(exports);
    expect(keys).toEqual(["."]);
    for (const legacy of [
      "./init",
      "./intents",
      "./adapters",
      "./active-models",
      "./model-list",
      "./views/model-picker",
    ]) {
      expect(keys).not.toContain(legacy);
    }
  });
});
