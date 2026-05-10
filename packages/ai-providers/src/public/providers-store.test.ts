import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  emptyProvidersConfig,
  listConfiguredProviders,
  loadProvidersConfig,
  type ProvidersConfig,
  saveProvidersConfig,
} from "./providers-store.js";

describe("providers-store round-trip", () => {
  it("saves and reloads ProvidersConfig from <systemFolder>/providers.json", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      remote: {
        openai: { apiKey: "sk-test" },
        anthropic: { apiKey: "sk-ant-test" },
      },
      custom: [
        {
          id: "custom-abc",
          name: "LM Studio",
          baseURL: "http://localhost:1234/v1",
          apiKey: "sk-anything",
        },
      ],
      active: { providerId: "openai", modelId: "gpt-4o-mini" },
    };
    await saveProvidersConfig(files, ".settings", config);

    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.remote.openai?.apiKey).toBe("sk-test");
    expect(reloaded.custom).toHaveLength(1);
    expect(reloaded.custom[0]?.baseURL).toBe("http://localhost:1234/v1");
    expect(reloaded.active.providerId).toBe("openai");
    expect(reloaded.active.modelId).toBe("gpt-4o-mini");
  });

  it("returns empty config when providers.json does not exist", async () => {
    const files = new MemFilesApi();
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(Object.keys(reloaded.remote)).toHaveLength(0);
    expect(reloaded.custom).toEqual([]);
    expect(reloaded.active.providerId).toBeUndefined();
  });

  it("listConfiguredProviders returns canonical entries with stored API keys plus custom entries", () => {
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      remote: {
        openai: { apiKey: "sk-test" },
        anthropic: { apiKey: "" }, // empty → excluded
      },
      custom: [
        {
          id: "custom-1",
          name: "Custom 1",
          baseURL: "http://localhost:8000/v1",
          apiKey: "sk-1",
        },
      ],
      active: {},
    };
    const list = listConfiguredProviders(config);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe("openai");
    expect(list[0]?.kind).toBe("canonical");
    expect(list[1]?.id).toBe("custom-1");
    expect(list[1]?.kind).toBe("custom");
  });

  it("normalizes the systemFolder argument when computing the path", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      remote: { openai: { apiKey: "sk" } },
      active: {},
    };
    await saveProvidersConfig(files, "/.settings/", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.remote.openai?.apiKey).toBe("sk");
  });

  it("migrates a v1 config with `openai-compatible` entry into a custom provider", async () => {
    const files = new MemFilesApi();
    const v1 = {
      schemaVersion: 1,
      remote: {
        openai: { apiKey: "sk-1", baseURL: null },
        "openai-compatible": {
          apiKey: "sk-c",
          baseURL: "http://x:1/v1",
        },
      },
      active: { reasoning: "gpt-4o-mini" },
    };
    await files.write("/.settings/providers.json", [
      new TextEncoder().encode(JSON.stringify(v1)),
    ]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(3);
    expect(reloaded.remote.openai?.apiKey).toBe("sk-1");
    expect(reloaded.custom).toHaveLength(1);
    expect(reloaded.custom[0]?.baseURL).toBe("http://x:1/v1");
    // v1 active.reasoning has no provider id → drop on migration.
    expect(reloaded.active.providerId).toBeUndefined();
    expect(reloaded.local).toEqual({});
  });

  it("migrates a v2 config to v3 by adding an empty local block", async () => {
    const files = new MemFilesApi();
    const v2 = {
      schemaVersion: 2,
      remote: { openai: { apiKey: "sk-1" } },
      custom: [
        {
          id: "c-1",
          name: "LM",
          baseURL: "http://localhost:1234/v1",
          apiKey: "sk-c",
        },
      ],
      active: { providerId: "openai", modelId: "gpt-4o-mini" },
    };
    await files.write("/.settings/providers.json", [
      new TextEncoder().encode(JSON.stringify(v2)),
    ]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(3);
    expect(reloaded.remote.openai?.apiKey).toBe("sk-1");
    expect(reloaded.custom).toHaveLength(1);
    expect(reloaded.active.providerId).toBe("openai");
    expect(reloaded.active.modelId).toBe("gpt-4o-mini");
    expect(reloaded.local).toEqual({});
  });

  it("round-trips a v3 config preserving the local.lastActivatedKey field", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      remote: { openai: { apiKey: "sk-1" } },
      active: { providerId: "local", modelId: "webllm:llama-3.2-3b" },
      local: { lastActivatedKey: "webllm:llama-3.2-3b" },
    };
    await saveProvidersConfig(files, ".settings", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(3);
    expect(reloaded.active.providerId).toBe("local");
    expect(reloaded.active.modelId).toBe("webllm:llama-3.2-3b");
    expect(reloaded.local.lastActivatedKey).toBe("webllm:llama-3.2-3b");
  });
});
