import { Intents } from "@statewalker/shared-intents";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { getWorkspace } from "@statewalker/workspace-api";
import { describe, expect, it } from "vitest";
import { runOpen } from "../../src/api/intents.js";
import initAiProviderCore from "../../src/index.js";

describe("ai-provider:open intent", () => {
  it("resolves when dispatched after initAiProviderCore runs", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    initAiProviderCore(ctx);
    await ws.open();

    const intents = ws.requireAdapter(Intents);
    const result = await runOpen(intents, undefined).promise;
    expect(result).toBeUndefined();
  });

  it("accepts a focus payload and resolves", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    initAiProviderCore(ctx);
    await ws.open();

    const intents = ws.requireAdapter(Intents);
    const result = await runOpen(intents, { focus: "reasoning" }).promise;
    expect(result).toBeUndefined();
  });

  it("does not claim the intent when activator has not run", async () => {
    const ctx: Record<string, unknown> = {};
    const ws = getWorkspace(ctx);
    ws.setFileSystem(new MemFilesApi(), "test");
    await ws.open();

    const intents = ws.requireAdapter(Intents);
    const intent = runOpen(intents, undefined);
    expect(intent.settled).toBe(false);
  });
});
