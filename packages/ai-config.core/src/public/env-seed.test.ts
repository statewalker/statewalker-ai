import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Secrets, Workspace } from "@statewalker/workspace.core";
import { describe, expect, it } from "vitest";
import { AiConfigImpl } from "../internal/ai-config.impl.js";
import { AiConfig, apiKeySecretKey } from "./ai-config.js";
import { seedAiConfigFromEnv } from "./env-seed.js";

class MapSecrets extends Secrets {
  private readonly m = new Map<string, unknown>();
  async get(k: string) {
    return this.m.get(k);
  }
  async set(k: string, v: unknown) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    return this.m.delete(k);
  }
  async list() {
    return [...this.m.keys()];
  }
  onUpdate() {
    return () => {};
  }
}

async function boot(secrets: MapSecrets): Promise<Workspace> {
  const ws = new Workspace().setFileSystem(new MemFilesApi());
  ws.setAdapter(Secrets, () => secrets);
  const cfg = new AiConfigImpl(ws);
  ws.setAdapter(AiConfig, () => cfg);
  await cfg.load();
  return ws;
}

describe("seedAiConfigFromEnv", () => {
  it("seeds Secrets + registers a connection when the secret store is empty", async () => {
    const secrets = new MapSecrets();
    const ws = await boot(secrets);
    await seedAiConfigFromEnv(ws, { OPENAI_API_KEY: "sk-env" });
    expect(await secrets.get(apiKeySecretKey("openai"))).toBe("sk-env");
    expect(ws.requireAdapter(AiConfig).getConnection("openai")?.type).toBe("openai");
  });

  it("does not overwrite an existing stored secret (stored wins over env)", async () => {
    const secrets = new MapSecrets();
    await secrets.set(apiKeySecretKey("openai"), "sk-stored");
    const ws = await boot(secrets);
    await seedAiConfigFromEnv(ws, { OPENAI_API_KEY: "sk-env" });
    expect(await secrets.get(apiKeySecretKey("openai"))).toBe("sk-stored");
  });

  it("ignores providers whose env var is absent", async () => {
    const secrets = new MapSecrets();
    const ws = await boot(secrets);
    await seedAiConfigFromEnv(ws, {});
    expect(ws.requireAdapter(AiConfig).listConnections()).toEqual([]);
  });
});
