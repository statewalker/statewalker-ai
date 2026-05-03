import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

describe("ai-provider-core layout", () => {
  it("has src/public/ and src/internal/ resolvable", async () => {
    await Promise.all([
      import("../src/public/intents.js"),
      import("../src/public/types.js"),
      import("../src/public/engine-detection.js"),
      import("../src/public/adapters.js"),
      import("../src/public/init-ai-provider-core.js"),
    ]);
  });

  it("exposes a single-ctx default activator from src/index.ts", async () => {
    const mod = (await import("../src/index.js")) as { default?: unknown };
    expect(typeof mod.default).toBe("function");
    expect((mod.default as (ctx: Record<string, unknown>) => unknown).length).toBe(1);
  });

  it("declares the canonical main entry plus only ./views/* subpaths", () => {
    const exports = (pkg as { exports: Record<string, unknown> }).exports;
    const keys = Object.keys(exports);
    expect(keys).toContain(".");
    // Legacy non-view subpaths must not exist — consumers go through main.
    for (const legacy of ["./init", "./intents", "./adapters", "./active-models", "./model-list"]) {
      expect(keys).not.toContain(legacy);
    }
    // Every other declared key must be a ./views/* subpath (formalizes the
    // previously-implicit view imports used by chat.core / chat.app).
    for (const k of keys) {
      if (k === ".") continue;
      expect(k.startsWith("./views/")).toBe(true);
    }
  });
});
