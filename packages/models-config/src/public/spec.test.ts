import { validateSpec } from "@json-render/core";
import { describe, expect, it } from "vitest";
import { makeModelsConfigSpec } from "./spec.js";

describe("makeModelsConfigSpec", () => {
  const spec = makeModelsConfigSpec();
  const result = validateSpec(spec);

  it("is structurally valid", () => {
    expect(result.valid).toBe(true);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("has exactly three Dialog elements with the expected openPaths", () => {
    const dialogs = Object.values(spec.elements).filter((el) => el.type === "Dialog");
    expect(dialogs).toHaveLength(3);
    const paths = dialogs.map((el) => (el.props as { openPath?: string }).openPath).sort();
    expect(paths).toEqual([
      "/ui/dialogs/localModels/open",
      "/ui/dialogs/modelsList/open",
      "/ui/dialogs/remoteConnections/open",
    ]);
  });
});
