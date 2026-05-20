import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  emptyProvidersConfig,
  isConnected,
  loadProvidersConfig,
  type ProvidersConfig,
  saveProvidersConfig,
  validateConnectionUrl,
} from "./providers-store.js";

describe("providers-store round-trip (v5)", () => {
  it("saves and reloads v5 ProvidersConfig with per-Connection starredModelIds", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [
        {
          id: "openai",
          type: "openai",
          name: "OpenAI",
          apiKey: "sk-test",
          starredModelIds: ["gpt-4o", "gpt-4o-mini"],
        },
        {
          id: "anthropic",
          type: "anthropic",
          name: "Anthropic",
          url: "https://anthropic-proxy.example.com",
          apiKey: "sk-ant-test",
          starredModelIds: ["claude-3-5-sonnet"],
        },
        {
          id: "custom-abc",
          type: "openai-compatible",
          name: "LM Studio",
          url: "http://localhost:1234/v1",
          apiKey: "sk-anything",
          starredModelIds: [],
        },
      ],
      active: { providerId: "openai", modelId: "gpt-4o-mini" },
    };
    await saveProvidersConfig(files, ".settings", config);

    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(5);
    expect(reloaded.connections).toHaveLength(3);
    expect(reloaded.connections[0]?.apiKey).toBe("sk-test");
    expect(reloaded.connections[0]?.starredModelIds).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(reloaded.connections[1]?.starredModelIds).toEqual(["claude-3-5-sonnet"]);
    expect(reloaded.connections[2]?.url).toBe("http://localhost:1234/v1");
    expect(reloaded.active.providerId).toBe("openai");
  });

  it("returns empty v5 config when providers.json does not exist", async () => {
    const files = new MemFilesApi();
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(5);
    expect(reloaded.connections).toEqual([]);
    expect(reloaded.local.downloaded).toEqual([]);
    expect(reloaded.active.providerId).toBeUndefined();
  });

  it("retains dormant shells (empty apiKey) on save", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [
        {
          id: "openai",
          type: "openai",
          name: "OpenAI",
          apiKey: "sk-test",
          starredModelIds: [],
        },
        // Dormant shell — Disconnect cleared apiKey, but the shell
        // persists so re-Connect is one click.
        {
          id: "anthropic",
          type: "anthropic",
          name: "Anthropic",
          url: "https://anthropic-proxy.example.com",
          apiKey: "",
          starredModelIds: [],
        },
      ],
    };
    await saveProvidersConfig(files, ".settings", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.connections).toHaveLength(2);
    expect(reloaded.connections[1]?.apiKey).toBe("");
    expect(reloaded.connections[1]?.url).toBe("https://anthropic-proxy.example.com");
  });

  it("normalises the systemFolder argument when computing the path", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [
        { id: "openai", type: "openai", name: "OpenAI", apiKey: "sk", starredModelIds: [] },
      ],
    };
    await saveProvidersConfig(files, "/.settings/", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.connections[0]?.apiKey).toBe("sk");
  });

  it("migrates a v1 config to v5 Connections", async () => {
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
    expect(reloaded.schemaVersion).toBe(5);
    const openai = reloaded.connections.find((c) => c.id === "openai");
    expect(openai?.apiKey).toBe("sk-1");
    expect(openai?.starredModelIds).toEqual([]);
    const compat = reloaded.connections.find((c) => c.type === "openai-compatible");
    expect(compat?.url).toBe("http://x:1/v1");
    expect(compat?.starredModelIds).toEqual([]);
    expect(reloaded.active.providerId).toBeUndefined();
  });

  it("migrates a v2 config to v5", async () => {
    const files = new MemFilesApi();
    const v2 = {
      schemaVersion: 2,
      remote: { openai: { apiKey: "sk-1" } },
      custom: [{ id: "c-1", name: "LM", baseURL: "http://localhost:1234/v1", apiKey: "sk-c" }],
      active: { providerId: "openai", modelId: "gpt-4o-mini" },
    };
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v2))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(5);
    expect(reloaded.connections).toHaveLength(2);
    expect(reloaded.connections.every((c) => c.starredModelIds.length === 0)).toBe(true);
    expect(reloaded.active.providerId).toBe("openai");
  });

  it("migrates a v3 config to v5 preserving canonical + custom + active", async () => {
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
    expect(reloaded.schemaVersion).toBe(5);
    expect(reloaded.connections).toHaveLength(3);
    const openai = reloaded.connections.find((c) => c.id === "openai");
    expect(openai?.apiKey).toBe("sk-openai");
    expect(openai?.starredModelIds).toEqual([]);
    const lm = reloaded.connections.find((c) => c.id === "lmstudio");
    expect(lm?.type).toBe("openai-compatible");
    expect(lm?.url).toBe("http://localhost:1234/v1");
    expect(reloaded.active.providerId).toBe("openai");
    expect(reloaded.local.lastActivatedKey).toBe("webllm:llama-3.2-3b");
  });

  it("migrates a v4 fixture: fans top-level starred into per-Connection arrays", async () => {
    const files = new MemFilesApi();
    const v4 = {
      schemaVersion: 4,
      connections: [
        { id: "openai", type: "openai", name: "OpenAI", apiKey: "sk-1" },
        { id: "google", type: "google", name: "Google", apiKey: "sk-g" },
      ],
      starred: [
        { connectionId: "openai", modelId: "gpt-4o" },
        { connectionId: "openai", modelId: "gpt-4o-mini" },
        { connectionId: "google", modelId: "gemini-1.5-pro" },
      ],
      local: { downloaded: [] },
      active: { providerId: "openai", modelId: "gpt-4o" },
    };
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v4))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.schemaVersion).toBe(5);
    const openai = reloaded.connections.find((c) => c.id === "openai");
    expect(openai?.starredModelIds).toEqual(["gpt-4o", "gpt-4o-mini"]);
    const google = reloaded.connections.find((c) => c.id === "google");
    expect(google?.starredModelIds).toEqual(["gemini-1.5-pro"]);
    // Top-level starred is gone from v5.
    expect((reloaded as unknown as Record<string, unknown>).starred).toBeUndefined();
  });

  it("v4 → v5: drops orphan starred entries with unknown connectionIds", async () => {
    const files = new MemFilesApi();
    const v4 = {
      schemaVersion: 4,
      connections: [{ id: "openai", type: "openai", name: "OpenAI", apiKey: "sk-1" }],
      starred: [
        { connectionId: "openai", modelId: "gpt-4o" },
        { connectionId: "ghost-conn", modelId: "ghost-model" },
      ],
      local: { downloaded: [] },
      active: {},
    };
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v4))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    const openai = reloaded.connections.find((c) => c.id === "openai");
    expect(openai?.starredModelIds).toEqual(["gpt-4o"]);
    expect(reloaded.connections).toHaveLength(1);
  });

  it("v3 → v5: migrated Connections start with empty starredModelIds (no curated defaults)", async () => {
    const files = new MemFilesApi();
    const v3 = {
      schemaVersion: 3,
      remote: { openai: { apiKey: "sk-1" } },
      custom: [],
      active: {},
      local: {},
    };
    await files.write("/.settings/providers.json", [new TextEncoder().encode(JSON.stringify(v3))]);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.connections[0]?.starredModelIds).toEqual([]);
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
            { id: "gpt-4o", label: "GPT-4o", capabilities: ["chat"] },
            {
              id: "text-embedding-3-small",
              label: "text-embedding-3-small",
              capabilities: ["embedding"],
            },
          ],
          discoveredAt: 1_700_000_000_000,
          starredModelIds: ["gpt-4o"],
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
    expect(reloaded.connections[0]?.starredModelIds).toEqual(["gpt-4o"]);
  });

  it("round-trips downloaded local models", async () => {
    const files = new MemFilesApi();
    const config: ProvidersConfig = {
      ...emptyProvidersConfig,
      connections: [
        { id: "openai", type: "openai", name: "OpenAI", apiKey: "sk", starredModelIds: [] },
      ],
      local: {
        downloaded: [{ key: "local:smollm2-360m", downloadedAt: 1_700_000_000_001 }],
        lastActivatedKey: "local:smollm2-360m",
      },
    };
    await saveProvidersConfig(files, ".settings", config);
    const reloaded = await loadProvidersConfig(files, ".settings");
    expect(reloaded.local.downloaded[0]?.key).toBe("local:smollm2-360m");
    expect(reloaded.local.lastActivatedKey).toBe("local:smollm2-360m");
  });
});

describe("isConnected predicate", () => {
  it("returns true when discoveredModels is populated", () => {
    expect(
      isConnected({
        id: "x",
        type: "openai",
        name: "x",
        apiKey: "sk",
        discoveredModels: [{ id: "m", label: "m" }],
        starredModelIds: [],
      }),
    ).toBe(true);
  });

  it("returns false when discoveredModels is undefined (dormant shell)", () => {
    expect(
      isConnected({
        id: "x",
        type: "openai",
        name: "x",
        apiKey: "",
        starredModelIds: [],
      }),
    ).toBe(false);
  });
});

describe("validateConnectionUrl", () => {
  it("rejects Anthropic Connection without URL", () => {
    expect(() =>
      validateConnectionUrl({
        id: "a",
        type: "anthropic",
        name: "Anthropic",
        apiKey: "sk-ant",
        starredModelIds: [],
      }),
    ).toThrow(/Anthropic requires a proxy URL/);
  });

  it("rejects Anthropic Connection with empty URL string", () => {
    expect(() =>
      validateConnectionUrl({
        id: "a",
        type: "anthropic",
        name: "Anthropic",
        url: "  ",
        apiKey: "sk-ant",
        starredModelIds: [],
      }),
    ).toThrow();
  });

  it("rejects openai-compatible Connection without URL", () => {
    expect(() =>
      validateConnectionUrl({
        id: "lm",
        type: "openai-compatible",
        name: "LM Studio",
        apiKey: "sk",
        starredModelIds: [],
      }),
    ).toThrow(/openai-compatible requires a URL/i);
  });

  it("accepts OpenAI Connection without URL", () => {
    expect(() =>
      validateConnectionUrl({
        id: "o",
        type: "openai",
        name: "OpenAI",
        apiKey: "sk",
        starredModelIds: [],
      }),
    ).not.toThrow();
  });

  it("accepts Google Connection without URL", () => {
    expect(() =>
      validateConnectionUrl({
        id: "g",
        type: "google",
        name: "Google",
        apiKey: "k",
        starredModelIds: [],
      }),
    ).not.toThrow();
  });

  it("accepts Anthropic Connection with URL", () => {
    expect(() =>
      validateConnectionUrl({
        id: "a",
        type: "anthropic",
        name: "Anthropic",
        url: "https://proxy.example.com",
        apiKey: "sk-ant",
        starredModelIds: [],
      }),
    ).not.toThrow();
  });
});
