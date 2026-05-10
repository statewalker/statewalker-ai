import type { ProviderV3 } from "@ai-sdk/provider";
import type { Agent, AgentRuntime } from "@statewalker/ai-agent/runtime";
import { Slots } from "@statewalker/shared-slots";
import { Workspace } from "@statewalker/workspace-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveModel } from "../public/active-model.js";
import {
  provideAgentMcpConnection,
  provideAgentSkill,
  provideAgentTool,
} from "../public/extension-points.js";
import { AgentRuntimeAdapter } from "../public/runtime-state.js";
import type { ActiveModelValue } from "../public/types.js";
import { AgentRuntimeManager } from "./agent-runtime.manager.js";
import type { BuildRuntimeInput } from "./build-runtime.js";

function fakeFiles(): import("@statewalker/webrun-files").FilesApi {
  return {} as import("@statewalker/webrun-files").FilesApi;
}

function fakeProvider(): ProviderV3 {
  return {} as ProviderV3;
}

function fakeActiveModel(): ActiveModelValue {
  return {
    kind: "remote",
    providerId: "openai",
    modelId: "gpt-4o",
    createProvider: () => fakeProvider(),
  };
}

function makeWorkspace(): Workspace {
  const ws = new Workspace();
  ws.setAdapter(ActiveModel);
  ws.setAdapter(AgentRuntimeAdapter);
  ws.setFileSystem(fakeFiles(), "test");
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentRuntimeManager", () => {
  it("starts in `loading` and reaches `ready` when ActiveModel is set", async () => {
    const ws = makeWorkspace();
    await ws.open();

    const adapter = ws.requireAdapter(AgentRuntimeAdapter);
    const activeModel = ws.requireAdapter(ActiveModel);
    const fakeRuntime = {
      createAgent: vi.fn(() => ({}) as Agent),
    } as unknown as AgentRuntime;
    const buildSpy = vi.fn(async (_: BuildRuntimeInput) => fakeRuntime);

    const manager = new AgentRuntimeManager({
      workspace: ws,
      buildRuntime: buildSpy,
    });

    // After onLoad fires (synchronously inside the constructor branch),
    // a debounced rebuild is queued; ActiveModel is null so the manager
    // leaves the adapter in `loading`.
    expect(adapter.getState().status).toBe("loading");

    activeModel.set(fakeActiveModel());
    await vi.runOnlyPendingTimersAsync();
    await vi.runAllTimersAsync();

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(adapter.getState().status).toBe("ready");

    await manager.close();
  });

  it("re-entrant lifecycle: ≥2 onLoad/onUnload cycles each rebuild fresh", async () => {
    const ws = makeWorkspace();
    const buildSpy = vi.fn(
      async (_: BuildRuntimeInput) =>
        ({ createAgent: () => ({}) as Agent }) as unknown as AgentRuntime,
    );
    const manager = new AgentRuntimeManager({
      workspace: ws,
      buildRuntime: buildSpy,
    });
    const adapter = ws.requireAdapter(AgentRuntimeAdapter);
    const activeModel = ws.requireAdapter(ActiveModel);

    // Cycle 1.
    await ws.open();
    activeModel.set(fakeActiveModel());
    await vi.runAllTimersAsync();
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(adapter.getState().status).toBe("ready");

    // Unload — adapter resets, ActiveModel can be cleared.
    await ws.close();
    expect(adapter.getState().status).toBe("loading");

    // Cycle 2 — fresh subscription, fresh rebuild.
    await ws.open();
    activeModel.set(fakeActiveModel());
    await vi.runAllTimersAsync();
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(adapter.getState().status).toBe("ready");

    await manager.close();
  });

  it("slot contributions arriving mid-cycle trigger a rebuild", async () => {
    const ws = makeWorkspace();
    const slots = ws.requireAdapter(Slots);
    const buildSpy = vi.fn(
      async (_: BuildRuntimeInput) =>
        ({ createAgent: () => ({}) as Agent }) as unknown as AgentRuntime,
    );
    const manager = new AgentRuntimeManager({
      workspace: ws,
      buildRuntime: buildSpy,
    });
    const activeModel = ws.requireAdapter(ActiveModel);

    await ws.open();
    activeModel.set(fakeActiveModel());
    await vi.runAllTimersAsync();
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Mid-cycle slot contributions should fire fresh rebuilds with
    // the cumulative snapshots.
    const toolFactory = (): import("ai").ToolSet =>
      ({}) as import("ai").ToolSet;
    provideAgentTool(slots, toolFactory);
    await vi.runAllTimersAsync();
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(buildSpy.mock.calls[1]?.[0].tools).toHaveLength(1);

    provideAgentSkill(slots, {
      name: "demo",
      description: "demo",
      content: "# demo skill",
    });
    await vi.runAllTimersAsync();
    expect(buildSpy).toHaveBeenCalledTimes(3);
    expect(buildSpy.mock.calls[2]?.[0].skills).toHaveLength(1);

    provideAgentMcpConnection(slots, {
      id: "fs",
      config: {
        command: "node",
        args: [],
      } as unknown as import("@statewalker/ai-agent").McpServerConfig,
    });
    await vi.runAllTimersAsync();
    expect(buildSpy).toHaveBeenCalledTimes(4);
    expect(buildSpy.mock.calls[3]?.[0].mcpServers).toEqual({
      fs: { command: "node", args: [] },
    });

    await manager.close();
  });

  it("contributions while unloaded do not fire a rebuild", async () => {
    const ws = makeWorkspace();
    const slots = ws.requireAdapter(Slots);
    const buildSpy = vi.fn(
      async (_: BuildRuntimeInput) =>
        ({ createAgent: () => ({}) as Agent }) as unknown as AgentRuntime,
    );
    const manager = new AgentRuntimeManager({
      workspace: ws,
      buildRuntime: buildSpy,
    });
    const activeModel = ws.requireAdapter(ActiveModel);

    await ws.open();
    activeModel.set(fakeActiveModel());
    await vi.runAllTimersAsync();
    expect(buildSpy).toHaveBeenCalledTimes(1);

    await ws.close();
    provideAgentTool(slots, () => ({}) as import("ai").ToolSet);
    await vi.runAllTimersAsync();
    // Still 1 — the manager unsubscribed on onUnload.
    expect(buildSpy).toHaveBeenCalledTimes(1);

    await manager.close();
  });

  it("rebuild error transitions adapter to `error`", async () => {
    const ws = makeWorkspace();
    await ws.open();
    const adapter = ws.requireAdapter(AgentRuntimeAdapter);
    const activeModel = ws.requireAdapter(ActiveModel);

    const manager = new AgentRuntimeManager({
      workspace: ws,
      buildRuntime: async () => {
        throw new Error("boom");
      },
    });

    activeModel.set(fakeActiveModel());
    await vi.runAllTimersAsync();

    const state = adapter.getState();
    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.message).toBe("boom");
    }

    await manager.close();
  });

  it("clearing ActiveModel mid-cycle leaves the adapter state alone", async () => {
    const ws = makeWorkspace();
    await ws.open();
    const adapter = ws.requireAdapter(AgentRuntimeAdapter);
    const activeModel = ws.requireAdapter(ActiveModel);

    const manager = new AgentRuntimeManager({
      workspace: ws,
      buildRuntime: async () =>
        ({ createAgent: () => ({}) as Agent }) as unknown as AgentRuntime,
    });

    activeModel.set(fakeActiveModel());
    await vi.runAllTimersAsync();
    expect(adapter.getState().status).toBe("ready");

    // Simulate the providers fragment publishing `no-active-model`
    // before clearing ActiveModel.
    adapter._setState({ status: "no-active-model" });
    activeModel.clear();
    await vi.runAllTimersAsync();
    expect(adapter.getState().status).toBe("no-active-model");

    await manager.close();
  });
});
