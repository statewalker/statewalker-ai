import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderSettingsStore } from "../src/provider-settings-store.js";

const PATH = "/.settings/providers.json";
const LEGACY_PATH = "/.settings/key.json";

async function writeJson(files: MemFilesApi, path: string, value: unknown): Promise<void> {
  await files.mkdir("/.settings");
  await files.write(path, [new TextEncoder().encode(JSON.stringify(value, null, 2))]);
}

describe("ProviderSettingsStore", () => {
  let stores: ProviderSettingsStore[] = [];
  afterEach(() => {
    for (const s of stores) s.dispose();
    stores = [];
  });
  function newStore(files: MemFilesApi): ProviderSettingsStore {
    const s = new ProviderSettingsStore(files);
    stores.push(s);
    return s;
  }

  it("returns {} when providers.json is missing and no legacy file exists", async () => {
    const files = new MemFilesApi();
    const store = newStore(files);
    const loaded = await store.load();
    expect(loaded).toEqual({});
  });

  it("defaults activeModels and openai-compatible when missing from disk", async () => {
    const files = new MemFilesApi();
    await writeJson(files, PATH, { anthropic: { apiKey: "sk-a" } });

    const store = newStore(files);
    const loaded = await store.load();

    expect(loaded.anthropic?.apiKey).toBe("sk-a");
    expect(loaded["openai-compatible"]).toEqual({});
    expect(loaded.activeModels).toEqual({ reasoning: [], embedding: [] });
  });

  it("round-trips activeModels through saveNow + load", async () => {
    const files = new MemFilesApi();
    const store = newStore(files);

    await store.saveNow({
      anthropic: { apiKey: "sk-a" },
      activeModels: { reasoning: ["a", "b"], embedding: [] },
    });

    const loaded = await newStore(files).load();
    expect(loaded.activeModels).toEqual({
      reasoning: ["a", "b"],
      embedding: [],
    });
  });

  it("persists multiple openai-compatible instances", async () => {
    const files = new MemFilesApi();
    const store = newStore(files);

    await store.saveNow({
      "openai-compatible": {
        groq: {
          apiKey: "gsk",
          baseURL: "https://api.groq.com/openai/v1",
          displayName: "Groq",
        },
        lmstudio: {
          baseURL: "http://localhost:1234/v1",
          displayName: "LM Studio",
        },
      },
    });

    const loaded = await newStore(files).load();
    const compat = loaded["openai-compatible"];
    expect(Object.keys(compat ?? {})).toEqual(["groq", "lmstudio"]);
    expect(compat?.groq?.apiKey).toBe("gsk");
    expect(compat?.lmstudio?.baseURL).toBe("http://localhost:1234/v1");
  });

  it("debounced save coalesces rapid writes into one flush", async () => {
    const files = new MemFilesApi();
    const store = newStore(files);

    store.save({ anthropic: { apiKey: "v1" } });
    store.save({ anthropic: { apiKey: "v2" } });
    store.save({ anthropic: { apiKey: "v3" } });

    expect(await files.exists(PATH)).toBe(false);
    await store.flush();

    const text = await readText(files, PATH);
    expect(JSON.parse(text).anthropic.apiKey).toBe("v3");
  });

  it("migrates legacy key.json and seeds activeModels.reasoning", async () => {
    const files = new MemFilesApi();
    await writeJson(files, LEGACY_PATH, {
      apiKey: "sk-old",
      provider: "anthropic",
      models: [
        { type: "reasoning", model: "claude-sonnet-4-20250514" },
        { type: "embedding", model: "voyage-3" },
      ],
    });

    const store = newStore(files);
    const loaded = await store.load();

    expect(loaded.anthropic?.apiKey).toBe("sk-old");
    expect(loaded.activeModels?.reasoning).toEqual(["anthropic:claude-sonnet-4-20250514"]);
    expect(loaded.activeModels?.embedding).toEqual([]);
    // The legacy file is preserved for backward compat
    expect(await files.exists(LEGACY_PATH)).toBe(true);
    // The migrated providers.json is written
    expect(await files.exists(PATH)).toBe(true);
  });

  it("skips migration when providers.json already exists", async () => {
    const files = new MemFilesApi();
    await writeJson(files, PATH, { openai: { apiKey: "sk-existing" } });
    await writeJson(files, LEGACY_PATH, {
      apiKey: "sk-should-be-ignored",
      provider: "anthropic",
      models: [{ type: "reasoning", model: "claude-x" }],
    });

    const store = newStore(files);
    const loaded = await store.load();

    expect(loaded.openai?.apiKey).toBe("sk-existing");
    expect(loaded.anthropic).toBeUndefined();
    expect(loaded.activeModels?.reasoning).toEqual([]);
  });
});
