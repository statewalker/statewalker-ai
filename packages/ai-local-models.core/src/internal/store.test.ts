import { tryReadText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { type LocalModelsConfig, loadLocalModelsConfig, saveLocalModelsConfig } from "./store.js";

const SYS = ".settings";

describe("loadLocalModelsConfig", () => {
  it("returns the empty config when nothing is on disk", async () => {
    const files = new MemFilesApi();
    const cfg = await loadLocalModelsConfig(files, SYS);
    expect(cfg).toEqual({ schemaVersion: 1, downloaded: [], active: undefined });
  });

  it("round-trips a saved config", async () => {
    const files = new MemFilesApi();
    const config: LocalModelsConfig = {
      schemaVersion: 1,
      downloaded: [{ key: "local:smollm2-360m", downloadedAt: 111 }],
      active: "local:smollm2-360m",
    };
    await saveLocalModelsConfig(files, SYS, config);
    const back = await loadLocalModelsConfig(files, SYS);
    expect(back).toEqual(config);
  });

  it("migrates the local section + active local pointer from providers.json", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/providers.json",
      JSON.stringify({
        schemaVersion: 5,
        connections: [],
        local: {
          downloaded: [{ key: "local:smollm2-135m", downloadedAt: 42 }],
          lastActivatedKey: "local:smollm2-135m",
        },
        active: { providerId: "local", modelId: "local:smollm2-135m" },
      }),
    );
    const cfg = await loadLocalModelsConfig(files, SYS);
    expect(cfg).toEqual({
      schemaVersion: 1,
      downloaded: [{ key: "local:smollm2-135m", downloadedAt: 42 }],
      active: "local:smollm2-135m",
    });
    // Migration is written to local-models.json (idempotent thereafter).
    const written = await tryReadText(files, "/.settings/local-models.json");
    expect(written).toBeDefined();
  });

  it("migrates downloaded but NOT active when providers.json active is remote", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/providers.json",
      JSON.stringify({
        local: { downloaded: [{ key: "local:qwen3.5-0.8b", downloadedAt: 7 }] },
        active: { providerId: "openai", modelId: "gpt-4o" },
      }),
    );
    const cfg = await loadLocalModelsConfig(files, SYS);
    expect(cfg.downloaded).toEqual([{ key: "local:qwen3.5-0.8b", downloadedAt: 7 }]);
    expect(cfg.active).toBeUndefined();
  });

  it("ignores providers.json once local-models.json exists", async () => {
    const files = new MemFilesApi();
    await saveLocalModelsConfig(files, SYS, { schemaVersion: 1, downloaded: [] });
    await writeText(
      files,
      "/.settings/providers.json",
      JSON.stringify({ local: { downloaded: [{ key: "local:x", downloadedAt: 1 }] } }),
    );
    const cfg = await loadLocalModelsConfig(files, SYS);
    expect(cfg.downloaded).toEqual([]);
  });

  it("does not migrate when providers.json has no local data", async () => {
    const files = new MemFilesApi();
    await writeText(
      files,
      "/.settings/providers.json",
      JSON.stringify({ connections: [], active: {} }),
    );
    const cfg = await loadLocalModelsConfig(files, SYS);
    expect(cfg.downloaded).toEqual([]);
    // No own store was written (nothing to migrate).
    expect(await tryReadText(files, "/.settings/local-models.json")).toBeUndefined();
  });
});
