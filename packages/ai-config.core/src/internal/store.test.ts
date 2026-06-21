import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { emptyAiConfigData } from "../public/types.js";
import { loadAiConfig, saveAiConfig } from "./store.js";

const SYS = ".settings";

describe("ai.config store", () => {
  it("returns empty config when the file is missing", async () => {
    const files = new MemFilesApi();
    const data = await loadAiConfig(files, SYS);
    expect(data).toEqual(emptyAiConfigData);
  });

  it("round-trips a credential-free config", async () => {
    const files = new MemFilesApi();
    await saveAiConfig(files, SYS, {
      ...emptyAiConfigData,
      connections: [{ id: "openai", type: "openai", name: "OpenAI", starredModelIds: [] }],
      active: { connectionId: "openai", modelId: "gpt-4o" },
    });
    const data = await loadAiConfig(files, SYS);
    expect(data.connections.map((c) => c.id)).toEqual(["openai"]);
    expect(data.active).toEqual({ connectionId: "openai", modelId: "gpt-4o" });
    // No credential field is ever persisted.
    const raw = await files.read(`/${SYS}/ai-config.json`);
    let text = "";
    for await (const chunk of raw) text += new TextDecoder().decode(chunk);
    expect(text).not.toMatch(/apiKey/);
  });

  it("lifts a legacy plaintext apiKey out via onLegacyKey, strips it, idempotently", async () => {
    const files = new MemFilesApi();
    // Legacy providers.json shape: connections carry plaintext apiKey.
    await writeText(
      files,
      `/${SYS}/ai-config.json`,
      JSON.stringify({
        schemaVersion: 5,
        connections: [
          {
            id: "openai",
            type: "openai",
            name: "OpenAI",
            apiKey: "sk-legacy",
            starredModelIds: [],
          },
        ],
        local: { downloaded: [] },
        active: {},
      }),
    );

    const lifted: Array<[string, string]> = [];
    const data = await loadAiConfig(files, SYS, (id, key) => lifted.push([id, key]));
    expect(lifted).toEqual([["openai", "sk-legacy"]]);
    expect((data.connections[0] as Record<string, unknown>).apiKey).toBeUndefined();
    expect(data.schemaVersion).toBe(6);

    // Persist the migrated (stripped) config, reload — no second lift.
    await saveAiConfig(files, SYS, data);
    const lifted2: Array<[string, string]> = [];
    await loadAiConfig(files, SYS, (id, key) => lifted2.push([id, key]));
    expect(lifted2).toEqual([]);
  });
});
