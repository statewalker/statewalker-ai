import { ModelManager as ModelManagerImpl } from "@statewalker/ai-provider";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import initAiProviderCore, { ModelManager } from "../../src/index.js";

describe("ModelManager adapter token", () => {
  it("is importable from the package's canonical entry", () => {
    expect(typeof ModelManager).toBe("function");
  });

  it("requireAdapter(ModelManager) throws before initAiProviderCore runs", () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    expect(() => ws.requireAdapter(ModelManager)).toThrow(/No adapter registered for ModelManager/);
  });

  it("after initAiProviderCore + workspace open, .impl is the ai-provider ModelManager", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    initAiProviderCore(ctx);
    await ws.open();

    const impl = ws.requireAdapter(ModelManager).impl;
    expect(impl).toBeInstanceOf(ModelManagerImpl);
  });

  it(".impl throws if accessed before workspace opens", () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    initAiProviderCore(ctx);
    // workspace is configured but not opened
    expect(() => ws.requireAdapter(ModelManager).impl).toThrow(/workspace is not opened/);
  });
});
