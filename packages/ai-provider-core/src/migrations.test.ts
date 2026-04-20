import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { ENGINE_NAMESPACING, migrateEngineNamespacing } from "./migrations.js";

async function touch(files: MemFilesApi, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  const parent = `/${parts.slice(0, -1).join("/")}`;
  if (parent !== "/") await files.mkdir(parent);
  await files.write(path, [new TextEncoder().encode("x")]);
}

describe("migrateEngineNamespacing", () => {
  it("moves legacy per-model dirs under /models/tjs/", async () => {
    const files = new MemFilesApi();
    await touch(files, "/models/smollm2-135m/model.onnx");
    await touch(files, "/models/qwen2-0.5b/tokenizer.json");

    const ran = await migrateEngineNamespacing(files);
    expect(ran).toBe(true);

    expect(await files.exists("/models/tjs/smollm2-135m/model.onnx")).toBe(
      true,
    );
    expect(await files.exists("/models/tjs/qwen2-0.5b/tokenizer.json")).toBe(
      true,
    );
    expect(await files.exists("/models/smollm2-135m")).toBe(false);
    expect(await files.exists("/models/qwen2-0.5b")).toBe(false);

    const markers = JSON.parse(
      await readText(files, "/.settings/migrations.json"),
    );
    expect(markers[ENGINE_NAMESPACING]).toBeDefined();
  });

  it("leaves already-namespaced engine dirs alone", async () => {
    const files = new MemFilesApi();
    await touch(files, "/models/tjs/existing/model.onnx");
    await touch(files, "/models/webllm/shard/params.bin");
    await touch(files, "/models/legacy/model.onnx");

    await migrateEngineNamespacing(files);

    expect(await files.exists("/models/tjs/existing/model.onnx")).toBe(true);
    expect(await files.exists("/models/webllm/shard/params.bin")).toBe(true);
    expect(await files.exists("/models/tjs/legacy/model.onnx")).toBe(true);
  });

  it("is idempotent: second call is a no-op", async () => {
    const files = new MemFilesApi();
    await touch(files, "/models/alpha/model.onnx");

    const first = await migrateEngineNamespacing(files);
    expect(first).toBe(true);

    // Simulate a file added after the migration ran.
    await touch(files, "/models/beta/model.onnx");
    const second = await migrateEngineNamespacing(files);
    expect(second).toBe(false);

    // beta was NOT moved because the migration did not run a second time.
    expect(await files.exists("/models/beta/model.onnx")).toBe(true);
    expect(await files.exists("/models/tjs/beta/model.onnx")).toBe(false);
  });

  it("runs even when /models/ does not yet exist and writes the marker", async () => {
    const files = new MemFilesApi();
    const ran = await migrateEngineNamespacing(files);
    expect(ran).toBe(true);
    const markers = JSON.parse(
      await readText(files, "/.settings/migrations.json"),
    );
    expect(markers[ENGINE_NAMESPACING]).toBeDefined();
  });
});
