import { ModelManager } from "@statewalker/ai-provider-core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace } from "@statewalker/workspace-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerLocalProvider = vi.fn();
const registerWebLLMProvider = vi.fn();

vi.mock("@statewalker/ai-provider-local", () => ({
  registerLocalProvider: (...args: unknown[]) => registerLocalProvider(...args),
}));
vi.mock("@statewalker/ai-provider-webllm", () => ({
  registerWebLLMProvider: (...args: unknown[]) => registerWebLLMProvider(...args),
}));

const { default: initAiProviderCoreBrowser } = await import(
  "../src/ai-provider-core-browser.js"
);

const fakeImpl = { tag: "fake-manager-impl" };
class MockModelManager extends ModelManager {
  readonly impl = fakeImpl as never;
}

describe("initAiProviderCoreBrowser", () => {
  beforeEach(() => {
    registerLocalProvider.mockClear();
    registerWebLLMProvider.mockClear();
  });

  it("default export is a single-ctx function", () => {
    expect(typeof initAiProviderCoreBrowser).toBe("function");
    expect(initAiProviderCoreBrowser.length).toBe(1);
  });

  it("throws synchronously when ModelManager is not registered", () => {
    const ctx: Record<string, unknown> = {};
    getWorkspace(ctx);
    expect(() => initAiProviderCoreBrowser(ctx)).toThrow(
      /No adapter registered for ModelManager/,
    );
  });

  it("does not register engines before the workspace opens", () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test").setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreBrowser(ctx);

    expect(registerLocalProvider).not.toHaveBeenCalled();
    expect(registerWebLLMProvider).not.toHaveBeenCalled();
  });

  it("registers engines on the manager once the workspace opens", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test").setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreBrowser(ctx);
    await ws.open();

    expect(registerLocalProvider).toHaveBeenCalledTimes(1);
    expect(registerLocalProvider).toHaveBeenCalledWith(fakeImpl);
    expect(registerWebLLMProvider).toHaveBeenCalledTimes(1);
    expect(registerWebLLMProvider).toHaveBeenCalledWith(fakeImpl);
  });
});
