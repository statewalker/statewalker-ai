import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { LocalModelStorage } from "../../src/models/local-model-storage.js";

describe("LocalModelStorage", () => {
  describe("hasWeights", () => {
    it("returns false when no files exist", async () => {
      const files = new MemFilesApi();
      const storage = new LocalModelStorage(files);
      expect(await storage.hasWeights("test/model")).toBe(false);
    });

    it("returns false when only metadata exists", async () => {
      const files = new MemFilesApi();
      const storage = new LocalModelStorage(files);
      await files.mkdir("/models/test/model");
      await files.write("/models/test/model/model.json", [new TextEncoder().encode("{}")]);
      expect(await storage.hasWeights("test/model")).toBe(false);
    });

    it("returns true when onnx weight file exists", async () => {
      const files = new MemFilesApi();
      const storage = new LocalModelStorage(files);
      const dir = "/models/test/model";
      await files.mkdir(dir);
      await files.write(`${dir}/model.json`, [new TextEncoder().encode("{}")]);
      await files.write(`${dir}/model.onnx`, [new Uint8Array([1, 2, 3])]);
      expect(await storage.hasWeights("test/model")).toBe(true);
    });

    it("returns true when onnx weights live in an `onnx/` subdirectory", async () => {
      // Transformers.js layout: weights are stored under `onnx/`, not at the
      // model root. The default verifier must recurse to find them.
      const files = new MemFilesApi();
      const storage = new LocalModelStorage(files);
      const dir = "/models/test/model";
      await files.mkdir(`${dir}/onnx`);
      await files.write(`${dir}/model.json`, [new TextEncoder().encode("{}")]);
      await files.write(`${dir}/onnx/model.onnx`, [new Uint8Array([1, 2, 3])]);
      expect(await storage.hasWeights("test/model")).toBe(true);
    });
  });

  describe("delete", () => {
    it("removes model directory", async () => {
      const files = new MemFilesApi();
      const storage = new LocalModelStorage(files);
      const dir = "/models/test/model";
      await files.mkdir(dir);
      await files.write(`${dir}/model.json`, [new TextEncoder().encode("{}")]);
      await files.write(`${dir}/model.onnx`, [new Uint8Array([1])]);

      await storage.delete("test/model");
      expect(await files.exists(dir)).toBe(false);
    });
  });

  describe("listStored", () => {
    it("returns empty when no models stored", async () => {
      const files = new MemFilesApi();
      const storage = new LocalModelStorage(files);
      const result = await storage.listStored();
      expect(result).toEqual([]);
    });

    it("returns stored model metadata", async () => {
      const files = new MemFilesApi();
      const storage = new LocalModelStorage(files);
      // Use a flat model ID (no slashes) so list() sees a direct child directory
      const dir = "/models/test-model";
      await files.mkdir(dir);
      const meta = {
        runtime: "local",
        engine: "tjs",
        modelId: "test-model",
        label: "Test",
        family: "Test",
        dtype: "q4f16",
        size: "100 MB",
        sizeBytes: 100000000,
      };
      await files.write(`${dir}/model.json`, [new TextEncoder().encode(JSON.stringify(meta))]);

      const result = await storage.listStored();
      expect(result).toHaveLength(1);
      expect(result[0]?.modelId).toBe("test-model");
    });
  });
});
