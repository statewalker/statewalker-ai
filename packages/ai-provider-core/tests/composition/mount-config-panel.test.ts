import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Layout } from "@statewalker/workbench-views";
import { getWorkspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import initAiProviderCore from "../../src/index.js";

const PANEL_KEY = "ai-config:main";

describe("mountConfigPanel", () => {
  it("publishes a dock panel with key 'ai-config:main' after initAiProviderCore", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    initAiProviderCore(ctx);
    await ws.open();

    const layout = ws.requireAdapter(Layout);
    const panel = layout.getPanel(PANEL_KEY);
    expect(panel).toBeDefined();
    expect(panel?.key).toBe(PANEL_KEY);
  });

  it("the published panel uses the right area + label", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    initAiProviderCore(ctx);
    await ws.open();

    const panel = ws.requireAdapter(Layout).getPanel(PANEL_KEY);
    expect(panel?.area).toBe("right");
    expect(panel?.label).toMatch(/AI/i);
  });

  it("the panel is removed when the activator's cleanup runs", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    const cleanup = initAiProviderCore(ctx);
    await ws.open();

    const layout = ws.requireAdapter(Layout);
    expect(layout.getPanel(PANEL_KEY)).toBeDefined();

    await cleanup();
    expect(layout.getPanel(PANEL_KEY)).toBeUndefined();
  });
});
