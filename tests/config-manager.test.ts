import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigManager } from "../src/config/config-manager.js";

describe("ConfigManager", () => {
  let files: MemFilesApi;
  let config: ConfigManager;

  beforeEach(() => {
    files = new MemFilesApi();
    config = new ConfigManager(files);
  });

  describe("load / save round-trip", () => {
    it("saves and loads JSON data", async () => {
      const data = { name: "test", count: 42, nested: { ok: true } };
      await config.save("/config.json", data);
      const loaded = await config.load("/config.json");
      expect(loaded).toEqual(data);
    });

    it("returns undefined for missing file", async () => {
      const loaded = await config.load("/missing.json");
      expect(loaded).toBeUndefined();
    });

    it("returns undefined for invalid JSON", async () => {
      const enc = new TextEncoder();
      await files.write("/bad.json", [enc.encode("not json {{{")]);
      const loaded = await config.load("/bad.json");
      expect(loaded).toBeUndefined();
    });
  });

  describe("Zod validation", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });

    it("returns validated data when schema matches", async () => {
      await config.save("/valid.json", { name: "ok", count: 5 });
      const loaded = await config.load("/valid.json", schema);
      expect(loaded).toEqual({ name: "ok", count: 5 });
    });

    it("returns undefined when schema does not match", async () => {
      await config.save("/invalid.json", { name: 123, count: "bad" });
      const loaded = await config.load("/invalid.json", schema);
      expect(loaded).toBeUndefined();
    });
  });

  describe("basePath", () => {
    it("resolves paths relative to basePath", async () => {
      const scoped = new ConfigManager(files, "/.settings");
      await scoped.save("/key.json", { key: "abc" });

      // Should be stored at /.settings/key.json in the underlying FS
      const raw = await files.exists("/.settings/key.json");
      expect(raw).toBe(true);

      const loaded = await scoped.load("/key.json");
      expect(loaded).toEqual({ key: "abc" });
    });
  });

  describe("exists", () => {
    it("returns true for existing file", async () => {
      await config.save("/exists.json", {});
      expect(await config.exists("/exists.json")).toBe(true);
    });

    it("returns false for missing file", async () => {
      expect(await config.exists("/nope.json")).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes existing file", async () => {
      await config.save("/del.json", {});
      expect(await config.delete("/del.json")).toBe(true);
      expect(await config.exists("/del.json")).toBe(false);
    });

    it("returns false for missing file", async () => {
      expect(await config.delete("/nope.json")).toBe(false);
    });
  });
});
