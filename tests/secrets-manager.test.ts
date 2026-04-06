import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../src/config/config-manager.js";
import {
  type ApiKeyData,
  SecretsManager,
} from "../src/config/secrets-manager.js";

describe("SecretsManager", () => {
  let files: MemFilesApi;
  let secrets: SecretsManager;

  beforeEach(() => {
    files = new MemFilesApi();
    secrets = new SecretsManager(new ConfigManager(files));
  });

  describe("API key", () => {
    const keyData: ApiKeyData = {
      apiKey: "sk-test-123",
      provider: "anthropic",
      models: [
        { type: "reasoning", model: "claude-sonnet-4-20250514" },
        { type: "embedding", model: "text-embedding-3-large", size: 1024 },
      ],
    };

    it("saves and loads API key data", async () => {
      await secrets.saveApiKey(keyData);
      const loaded = await secrets.getApiKey();
      expect(loaded).toEqual(keyData);
    });

    it("returns undefined when no key saved", async () => {
      expect(await secrets.getApiKey()).toBeUndefined();
    });

    it("stores in key.json compatible with existing format", async () => {
      await secrets.saveApiKey(keyData);
      const exists = await files.exists("/key.json");
      expect(exists).toBe(true);
    });
  });

  describe("credentials", () => {
    it("saves and loads named credentials", async () => {
      const creds = { username: "admin", token: "tok-abc" };
      await secrets.saveCredentials("my-api", creds);
      const loaded = await secrets.getCredentials("my-api");
      expect(loaded).toEqual(creds);
    });

    it("returns undefined for missing credentials", async () => {
      expect(await secrets.getCredentials("nonexistent")).toBeUndefined();
    });

    it("stores in credentials/ subfolder", async () => {
      await secrets.saveCredentials("svc", { key: "val" });
      expect(await files.exists("/credentials/svc.json")).toBe(true);
    });

    it("isolates different credential names", async () => {
      await secrets.saveCredentials("a", { x: "1" });
      await secrets.saveCredentials("b", { y: "2" });
      expect(await secrets.getCredentials("a")).toEqual({ x: "1" });
      expect(await secrets.getCredentials("b")).toEqual({ y: "2" });
    });
  });
});
