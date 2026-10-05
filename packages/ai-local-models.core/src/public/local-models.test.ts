import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it, vi } from "vitest";
import { localCatalog } from "../internal/local-catalog.js";
import { TJS_WEIGHTS_BASE_PATH } from "./constants.js";
import { LocalModels } from "./local-models.js";

describe("LocalModels finds downloaded weights after a reload", () => {
  it("reports a model whose files are under TJS_WEIGHTS_BASE_PATH as downloaded", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const files = new MemFilesApi();
    const models = new LocalModels({ files });
    const [key, entry] = Object.entries(localCatalog)[0] ?? [];
    if (!key || !entry) throw new Error("the local catalog is empty");
    const dir = `${TJS_WEIGHTS_BASE_PATH}/${entry.modelId}`;
    await writeText(files, `${dir}/config.json`, "{}");
    await writeText(files, `${dir}/onnx/model_q4.onnx`, "weights");

    await models.load();

    expect(models.status(key)).toBe("downloaded");
  });
});
