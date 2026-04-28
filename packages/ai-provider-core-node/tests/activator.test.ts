import { ModelManager } from "@statewalker/ai-provider-core";
import { getWorkspace } from "@statewalker/workspace-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerLlamaCppProvider = vi.fn();

vi.mock("@statewalker/ai-provider-llamacpp", () => ({
  registerLlamaCppProvider: (...args: unknown[]) => registerLlamaCppProvider(...args),
}));

const { default: initAiProviderCoreNode } = await import("../src/ai-provider-core-node.js");

describe("initAiProviderCoreNode", () => {
  beforeEach(() => {
    registerLlamaCppProvider.mockClear();
  });

  it("default export is a single-ctx function", () => {
    expect(typeof initAiProviderCoreNode).toBe("function");
    expect(initAiProviderCoreNode.length).toBe(1);
  });

  it("throws when ModelManager is not registered on the workspace", () => {
    const ctx: Record<string, unknown> = {};
    getWorkspace(ctx);
    expect(() => initAiProviderCoreNode(ctx)).toThrow(/No adapter registered for ModelManager/);
  });

  it("calls registerLlamaCppProvider with the manager + rootDir from ctx", () => {
    const fakeImpl = { tag: "fake-manager-impl" };
    class MockModelManager extends ModelManager {
      readonly impl = fakeImpl as never;
    }
    const ctx: Record<string, unknown> = {
      aiProviderLlamaCppRootDir: "/tmp/test-llamacpp",
    };
    const ws = getWorkspace(ctx);
    ws.setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreNode(ctx);

    expect(registerLlamaCppProvider).toHaveBeenCalledTimes(1);
    expect(registerLlamaCppProvider).toHaveBeenCalledWith(fakeImpl, {
      rootDir: "/tmp/test-llamacpp",
    });
  });

  it("skips registration when aiProviderLlamaCppRootDir is not configured", () => {
    const fakeImpl = { tag: "fake-manager-impl" };
    class MockModelManager extends ModelManager {
      readonly impl = fakeImpl as never;
    }
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreNode(ctx);

    expect(registerLlamaCppProvider).not.toHaveBeenCalled();
  });
});
