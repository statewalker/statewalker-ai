import { ModelManager } from "@statewalker/ai-provider-core";
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

const { default: initAiProviderCoreBrowser } = await import("../src/ai-provider-core-browser.js");

describe("initAiProviderCoreBrowser", () => {
  beforeEach(() => {
    registerLocalProvider.mockClear();
    registerWebLLMProvider.mockClear();
  });

  it("default export is a single-ctx function", () => {
    expect(typeof initAiProviderCoreBrowser).toBe("function");
    expect(initAiProviderCoreBrowser.length).toBe(1);
  });

  it("throws when ModelManager is not registered on the workspace", () => {
    const ctx: Record<string, unknown> = {};
    getWorkspace(ctx); // create fresh workspace; no adapter registered
    expect(() => initAiProviderCoreBrowser(ctx)).toThrow(/No adapter registered for ModelManager/);
  });

  it("calls the engine registrars with the manager from ws.requireAdapter(ModelManager).impl", () => {
    const fakeImpl = { tag: "fake-manager-impl" };
    class MockModelManager extends ModelManager {
      readonly impl = fakeImpl as never;
    }
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreBrowser(ctx);

    expect(registerLocalProvider).toHaveBeenCalledTimes(1);
    expect(registerLocalProvider).toHaveBeenCalledWith(fakeImpl);
    expect(registerWebLLMProvider).toHaveBeenCalledTimes(1);
    expect(registerWebLLMProvider).toHaveBeenCalledWith(fakeImpl);
  });
});
