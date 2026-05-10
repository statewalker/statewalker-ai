import { remoteProvidersSlot } from "../public/extension-points.js";
import { Slots } from "@statewalker/shared-slots";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Workspace } from "@statewalker/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveModel, AgentRuntimeAdapter } from "@statewalker/ai-agent-runtime";
import { Providers } from "../public/providers.adapter.js";
import {
  emptyProvidersConfig, type ProvidersConfig
} from "../public/providers-store.js";

import { ProvidersManager } from "./providers.manager.js";

async function writeProvidersJson(
  files: MemFilesApi,
  config: ProvidersConfig,
): Promise<void> {
  await writeText(
    files,
    "/.settings/providers.json",
    JSON.stringify(config, null, 2),
  );
}

function makeWorkspace(files: MemFilesApi): Workspace {
  const ws = new Workspace();
  ws.setAdapter(ActiveModel);
  ws.setAdapter(AgentRuntimeAdapter);
  ws.setAdapter(Providers);
  ws.setFileSystem(files, "test");
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProvidersManager", () => {
  it("contributes built-in descriptors for each configured remote provider", async () => {
    const files = new MemFilesApi();
    await writeProvidersJson(files, {
      ...emptyProvidersConfig,
      remote: {
        openai: { apiKey: "sk-openai" },
        anthropic: { apiKey: "sk-anthropic" },
      },
      active: {},
    });
    const ws = makeWorkspace(files);
    const slots = ws.requireAdapter(Slots);

    const manager = new ProvidersManager({ workspace: ws });
    await ws.open();
    await vi.runAllTimersAsync();

    const descriptors =
      slots.getSnapshot(remoteProvidersSlot);
    expect(descriptors.map((d) => d.id).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(descriptors.find((d) => d.id === "openai")?.kind).toBe("canonical");

    await manager.close();
  });

  it("re-entrant: ≥2 onLoad/onUnload cycles produce fresh slot contributions", async () => {
    const files = new MemFilesApi();
    await writeProvidersJson(files, {
      ...emptyProvidersConfig,
      remote: { openai: { apiKey: "sk-openai" } },
      active: {},
    });
    const ws = makeWorkspace(files);
    const slots = ws.requireAdapter(Slots);

    const manager = new ProvidersManager({ workspace: ws });

    // Cycle 1.
    await ws.open();
    await vi.runAllTimersAsync();
    expect(
      slots.getSnapshot(remoteProvidersSlot).length,
    ).toBe(1);

    // Unload — slot must clear.
    await ws.close();
    expect(
      slots.getSnapshot(remoteProvidersSlot).length,
    ).toBe(0);

    // Edit providers.json off-cycle to add Anthropic; cycle 2 picks it up.
    await writeProvidersJson(files, {
      ...emptyProvidersConfig,
      remote: {
        openai: { apiKey: "sk-openai" },
        anthropic: { apiKey: "sk-anthropic" },
      },
      active: {},
    });
    await ws.open();
    await vi.runAllTimersAsync();
    expect(
      slots.getSnapshot(remoteProvidersSlot).length,
    ).toBe(2);

    await manager.close();
  });

  it("writes ActiveModel when config.active resolves to a configured provider", async () => {
    const files = new MemFilesApi();
    await writeProvidersJson(files, {
      ...emptyProvidersConfig,
      remote: { openai: { apiKey: "sk-openai" } },
      active: { providerId: "openai", modelId: "gpt-4o" },
    });
    const ws = makeWorkspace(files);
    const activeModel = ws.requireAdapter(ActiveModel);

    const manager = new ProvidersManager({ workspace: ws });
    await ws.open();
    await vi.runAllTimersAsync();

    const active = activeModel.get();
    expect(active).not.toBeNull();
    expect(active?.providerId).toBe("openai");
    expect(active?.modelId).toBe("gpt-4o");

    await manager.close();
  });

  it("publishes `no-providers` when nothing is configured", async () => {
    const files = new MemFilesApi();
    await writeProvidersJson(files, emptyProvidersConfig);
    const ws = makeWorkspace(files);
    const adapter = ws.requireAdapter(AgentRuntimeAdapter);
    const activeModel = ws.requireAdapter(ActiveModel);

    const manager = new ProvidersManager({ workspace: ws });
    await ws.open();
    await vi.runAllTimersAsync();

    expect(adapter.getState().status).toBe("no-providers");
    expect(activeModel.get()).toBeNull();

    await manager.close();
  });

  it("publishes `no-active-model` when providers exist but selection is empty", async () => {
    const files = new MemFilesApi();
    await writeProvidersJson(files, {
      ...emptyProvidersConfig,
      remote: { openai: { apiKey: "sk-openai" } },
      active: {},
    });
    const ws = makeWorkspace(files);
    const adapter = ws.requireAdapter(AgentRuntimeAdapter);

    const manager = new ProvidersManager({ workspace: ws });
    await ws.open();
    await vi.runAllTimersAsync();

    expect(adapter.getState().status).toBe("no-active-model");

    await manager.close();
  });

  it("saveProviders persists and re-derives ActiveModel", async () => {
    const files = new MemFilesApi();
    await writeProvidersJson(files, emptyProvidersConfig);
    const ws = makeWorkspace(files);
    const providers = ws.requireAdapter(Providers);
    const activeModel = ws.requireAdapter(ActiveModel);

    const manager = new ProvidersManager({ workspace: ws });
    await ws.open();
    await vi.runAllTimersAsync();
    expect(activeModel.get()).toBeNull();

    await providers.saveProviders({
      ...emptyProvidersConfig,
      remote: { openai: { apiKey: "sk-openai" } },
      active: { providerId: "openai", modelId: "gpt-4o" },
    });
    await vi.runAllTimersAsync();

    expect(activeModel.get()?.providerId).toBe("openai");

    await manager.close();
  });
});
