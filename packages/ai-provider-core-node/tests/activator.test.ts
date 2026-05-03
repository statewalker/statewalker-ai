import { ModelManager } from "@statewalker/ai-provider-core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace } from "@statewalker/workspace-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerNodeProviders = vi.fn();

vi.mock("@statewalker/ai-provider-node", () => ({
  registerNodeProviders: (...args: unknown[]) => registerNodeProviders(...args),
}));

const { default: initAiProviderCoreNode } = await import("../src/ai-provider-core-node.js");

const fakeImpl = { tag: "fake-manager-impl" };
class MockModelManager extends ModelManager {
  readonly impl = fakeImpl as never;
}

describe("initAiProviderCoreNode", () => {
  beforeEach(() => {
    registerNodeProviders.mockClear();
  });

  it("default export is a single-ctx function", () => {
    expect(typeof initAiProviderCoreNode).toBe("function");
    expect(initAiProviderCoreNode.length).toBe(1);
  });

  it("throws synchronously when ModelManager is not registered", () => {
    const ctx: Record<string, unknown> = {};
    getWorkspace(ctx);
    expect(() => initAiProviderCoreNode(ctx)).toThrow(/No adapter registered for ModelManager/);
  });

  it("does not register llamacpp before the workspace opens", () => {
    const ctx: Record<string, unknown> = {
      aiProviderLlamaCppRootDir: "/tmp/test-llamacpp",
    };
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test").setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreNode(ctx);

    expect(registerNodeProviders).not.toHaveBeenCalled();
  });

  it("registers llamacpp once the workspace opens (rootDir + manager from ctx)", async () => {
    const ctx: Record<string, unknown> = {
      aiProviderLlamaCppRootDir: "/tmp/test-llamacpp",
    };
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test").setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreNode(ctx);
    await ws.open();

    expect(registerNodeProviders).toHaveBeenCalledTimes(1);
    expect(registerNodeProviders).toHaveBeenCalledWith(fakeImpl, {
      rootDir: "/tmp/test-llamacpp",
    });
  });

  it("skips registration after open when aiProviderLlamaCppRootDir is unset", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test").setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreNode(ctx);
    await ws.open();

    expect(registerNodeProviders).not.toHaveBeenCalled();
  });
});
