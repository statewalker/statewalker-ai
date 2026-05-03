import { ModelManager } from "@statewalker/ai-provider-core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace } from "@statewalker/workspace-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { default as initAiProviderCoreBrowser } from "../src/ai-provider-core-browser.js";

const registerBrowserProviders = vi.fn();

vi.mock("@statewalker/ai-provider-browser", () => ({
  registerBrowserProviders: (...args: unknown[]) => registerBrowserProviders(...args),
}));

const fakeImpl = { tag: "fake-manager-impl", refreshLocalStatuses: vi.fn() };
class MockModelManager extends ModelManager {
  readonly impl = fakeImpl as never;
}

describe("initAiProviderCoreBrowser", () => {
  beforeEach(() => {
    registerBrowserProviders.mockClear();
  });

  it("default export is a single-ctx function", () => {
    expect(typeof initAiProviderCoreBrowser).toBe("function");
    expect(initAiProviderCoreBrowser.length).toBe(1);
  });

  it("throws synchronously when ModelManager is not registered", () => {
    const ctx: Record<string, unknown> = {};
    getWorkspace(ctx);
    expect(() => initAiProviderCoreBrowser(ctx)).toThrow(/No adapter registered for ModelManager/);
  });

  it("does not register engines before the workspace opens", () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test").setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreBrowser(ctx);

    expect(registerBrowserProviders).not.toHaveBeenCalled();
  });

  it("registers engines on the manager once the workspace opens", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test").setAdapter(ModelManager, MockModelManager);

    initAiProviderCoreBrowser(ctx);
    await ws.open();

    expect(registerBrowserProviders).toHaveBeenCalledTimes(1);
    expect(registerBrowserProviders).toHaveBeenCalledWith(fakeImpl);
  });
});
