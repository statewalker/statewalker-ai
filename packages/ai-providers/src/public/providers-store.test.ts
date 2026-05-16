import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  emptyProvidersConfig,
  loadProvidersConfig,
  type ProvidersConfig,
  saveProvidersConfig,
} from "./providers-store.js";

describe("providers-store round-trip", () => {
  it("saves and reloads v4 ProvidersConfig", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [
        { id: "openai", type: "openai", name: "OpenAI", apiKey: "sk-test" },
        {
          id: "anthropic",
          type: "anthropic",
          name: "Anthropic",
          apiKey: "sk-ant-test",
        },
        {
          id: "custom-abc",
          type: "openai-compatible",
          name: "LM Studio",
          url: "http://localhost:1234/v1",
          apiKey: "sk-anything",
        },
      ],
      active: { providerId: "openai", modelId: "gpt-4o-mini" },
    };
    await saveProvidersConfig(files, ".settings", config);

    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(4);
    expect(reloaded.connections).toHaveLength(3);
    expect(reloaded.connections[0]?.apiKey).toBe("sk-test");
    expect(reloaded.connections[2]?.url).toBe("http://localhost:1234/v1");
    expect(reloaded.active.providerId).toBe("openai");
    expect(reloaded.active.modelId).toBe("gpt-4o-mini");
  });

  it("returns empty v4 config when providers.json does not exist", async () => {
    const files = new MemFilesApi();
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(4);
    expect(reloaded.connections).toEqual([]);
    expect(reloaded.starred).toEqual([]);
    expect(reloaded.local.downloaded).toEqual([]);
    expect(reloaded.active.providerId).toBeUndefined();
  });

  it("drops connections without apiKey on save", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [
        { id: "openai", type: "openai", name: "OpenAI", apiKey: "sk-test" },
        { id: "anthropic", type: "anthropic", name: "Anthropic", apiKey: "" },
      ],
    };
    await saveProvidersConfig(files, ".settings", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.connections).toHaveLength(1);
    expect(reloaded.connections[0]?.id).toBe("openai");
  });

  it("normalises the systemFolder argument when computing the path", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [{ id: "openai", type: "openai", name: "OpenAI", apiKey: "sk" }],
    };
    await saveProvidersConfig(files, "/.settings/", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.connections[0]?.apiKey).toBe("sk");
  });

  it("migrates a v1 config with an `openai-compatible` entry into a Connection", async () => {
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
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v1))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(4);
    const openai = reloaded.connections.find((c) => c.id === "openai");
    expect(openai?.apiKey).toBe("sk-1");
    const compat = reloaded.connections.find((c) => c.type === "openai-compatible");
    expect(compat?.url).toBe("http://x:1/v1");
    // V1 active.reasoning had no provider id → drop on migration.
    expect(reloaded.active.providerId).toBeUndefined();
  });

  it("migrates a v2 config to v4 connections", async () => {
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
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v2))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(4);
    expect(reloaded.connections).toHaveLength(2);
    expect(reloaded.active.providerId).toBe("openai");
    expect(reloaded.active.modelId).toBe("gpt-4o-mini");
    expect(reloaded.local.downloaded).toEqual([]);
  });

  it("migrates a v3 config to v4 preserving canonical + custom + active + lastActivatedKey", async () => {
    const files = new MemFilesApi();
    const v3 = {
      schemaVersion: 3,
      remote: {
        openai: { apiKey: "sk-openai" },
        anthropic: { apiKey: "sk-ant" },
      },
      custom: [
        {
          id: "lmstudio",
          name: "LM Studio",
          baseURL: "http://localhost:1234/v1",
          apiKey: "sk-c",
        },
      ],
      active: { providerId: "openai", modelId: "gpt-4o" },
      local: { lastActivatedKey: "webllm:llama-3.2-3b" },
    };
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v3))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(4);
    expect(reloaded.connections).toHaveLength(3);
    // Canonical entries migrated with deterministic ids.
    const openai = reloaded.connections.find((c) => c.id === "openai");
    expect(openai?.type).toBe("openai");
    expect(openai?.name).toBe("OpenAI");
    expect(openai?.apiKey).toBe("sk-openai");
    // Custom entries preserved their id.
    const lm = reloaded.connections.find((c) => c.id === "lmstudio");
    expect(lm?.type).toBe("openai-compatible");
    expect(lm?.url).toBe("http://localhost:1234/v1");
    // active.providerId survives because canonical ids are deterministic.
    expect(reloaded.active.providerId).toBe("openai");
    expect(reloaded.local.lastActivatedKey).toBe("webllm:llama-3.2-3b");
    expect(reloaded.local.downloaded).toEqual([]);
    expect(reloaded.starred).toEqual([]);
  });

  it("migrates an empty v3 config to empty v4 connections", async () => {
    const files = new MemFilesApi();
    const v3 = {
      schemaVersion: 3,
      remote: {},
      custom: [],
      active: {},
      local: {},
    };
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v3))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(4);
    expect(reloaded.connections).toEqual([]);
    expect(reloaded.starred).toEqual([]);
    expect(reloaded.local.downloaded).toEqual([]);
    expect(reloaded.local.lastActivatedKey).toBeUndefined();
  });

  it("round-trips headers and discoveredModels", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [
        {
          id: "openai",
          type: "openai",
          name: "OpenAI",
          apiKey: "sk-test",
          headers: [
            { name: "X-Org", value: "acme" },
            { name: "X-Trace", value: "1" },
          ],
          discoveredModels: [
            { id: "gpt-4o", label: "GPT-4o", capabilities: ["text"] },
            {
              id: "text-embedding-3-small",
              label: "text-embedding-3-small",
              capabilities: ["embedding"],
            },
          ],
          discoveredAt: 1_700_000_000_000,
        },
      ],
    };
    await saveProvidersConfig(files, ".settings", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.connections[0]?.headers).toEqual([
      { name: "X-Org", value: "acme" },
      { name: "X-Trace", value: "1" },
    ]);
    expect(reloaded.connections[0]?.discoveredModels).toHaveLength(2);
    expect(reloaded.connections[0]?.discoveredAt).toBe(1_700_000_000_000);
  });

  it("round-trips starred and downloaded", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [{ id: "openai", type: "openai", name: "OpenAI", apiKey: "sk" }],
      starred: [
        { connectionId: "openai", modelId: "gpt-4o" },
        { connectionId: "anthropic", modelId: "claude-sonnet-4-20250514" },
      ],
      local: {
        downloaded: [{ key: "local:smollm2-360m", downloadedAt: 1_700_000_000_001 }],
        lastActivatedKey: "local:smollm2-360m",
      },
    };
    await saveProvidersConfig(files, ".settings", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.starred).toHaveLength(2);
    expect(reloaded.starred[0]).toEqual({
      connectionId: "openai",
      modelId: "gpt-4o",
    });
    expect(reloaded.local.downloaded[0]?.key).toBe("local:smollm2-360m");
    expect(reloaded.local.lastActivatedKey).toBe("local:smollm2-360m");
  });
});
