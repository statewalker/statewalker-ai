import type { LocalModelConfig } from "@statewalker/ai-provider";
import { describe, expect, it } from "vitest";
import { resolveGgufFiles, verifyGgufWeights } from "../src/gguf-resolver.js";

const BASE_CONFIG: LocalModelConfig = {
  runtime: "local",
  engine: "llamacpp",
  modelId: "bartowski/Llama-3.2-3B-Instruct-GGUF",
  label: "Llama",
  family: "Llama",
  dtype: "Q4_K_M",
  size: "2.0 GB",
  sizeBytes: 2_000_000_000,
  ggufFile: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
};

describe("resolveGgufFiles", () => {
  it("returns a single-file list from config", async () => {
    const out = await resolveGgufFiles("x", BASE_CONFIG);
    expect(out).toEqual([
      { name: BASE_CONFIG.ggufFile, size: BASE_CONFIG.sizeBytes },
    ]);
  });

  it("throws when ggufFile is missing", async () => {
    const broken = { ...BASE_CONFIG, ggufFile: undefined };
    await expect(resolveGgufFiles("x", broken)).rejects.toThrow(/ggufFile/);
  });
});

describe("verifyGgufWeights", () => {
  async function* iter<T>(items: T[]) {
    for (const i of items) yield i;
  }

  it("returns true when a .gguf file is present", async () => {
    expect(
      await verifyGgufWeights(
        iter([{ kind: "file", name: "Llama.Q4_K_M.gguf" }]),
      ),
    ).toBe(true);
  });

  it("returns false when no .gguf file is present", async () => {
    expect(
      await verifyGgufWeights(iter([{ kind: "file", name: "readme.md" }])),
    ).toBe(false);
  });

  it("ignores directories", async () => {
    expect(
      await verifyGgufWeights(
        iter([
          { kind: "directory", name: "ignored" },
          { kind: "file", name: "x.gguf" },
        ]),
      ),
    ).toBe(true);
  });
});
