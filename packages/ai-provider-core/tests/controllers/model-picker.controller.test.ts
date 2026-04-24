import { ModelManager, ModelStateStore, type RemoteModelConfig } from "@statewalker/ai-provider";
import { createIntents } from "@statewalker/shared-intents";
import { describe, expect, it } from "vitest";
import { getModelPickerView, setModelManager } from "../../src/adapters.js";
import {
  getModelActivationController,
  ModelActivationController,
  setModelActivationController,
} from "../../src/controllers/model-activation.controller.js";
import { createModelPickerController } from "../../src/controllers/model-picker.controller.js";
import { setModelListView } from "../../src/controllers/model-settings.controller.js";
import { ModelListView } from "../../src/domain/model-list.view.js";
import { setIntents } from "../../src/intents.js";

function makeCtx(catalog: Record<string, RemoteModelConfig> = {}): {
  ctx: Record<string, unknown>;
  manager: ModelManager;
  listView: ModelListView;
} {
  const ctx: Record<string, unknown> = {};
  setIntents(ctx, createIntents());
  const store = new ModelStateStore(catalog);
  const manager = new ModelManager({ store });
  setModelManager(ctx, manager);
  const listView = new ModelListView();
  setModelListView(ctx, listView);
  setModelActivationController(ctx, new ModelActivationController());
  // Touch adapter to seed context
  getModelActivationController(ctx);
  return { ctx, manager, listView };
}

describe("model-picker.controller", () => {
  it("mode = 'none' when no active reasoning model", () => {
    const { ctx } = makeCtx();
    createModelPickerController(ctx);
    const picker = getModelPickerView(ctx);
    expect(picker.mode).toBe("none");
    expect(picker.items).toEqual([]);
  });

  it("mode = 'single' when exactly one reasoning model is active", () => {
    const { ctx, manager, listView } = makeCtx({
      "anthropic/claude": {
        runtime: "remote",
        provider: "anthropic",
        modelId: "claude",
        label: "Claude",
        kinds: ["reasoning"],
      },
    });
    createModelPickerController(ctx);

    manager.store.setStatus("anthropic/claude", "ready");
    listView.recompute(
      manager.store.getStates(),
      { activeModels: { reasoning: ["anthropic/claude"], embedding: [] } },
      { reasoning: ["anthropic/claude"], embedding: [] },
    );

    const picker = getModelPickerView(ctx);
    expect(picker.mode).toBe("single");
    expect(picker.currentLabel).toBe("Claude");
    expect(picker.items.map((i) => i.key)).toEqual(["anthropic/claude"]);
  });

  it("mode = 'multi' when ≥ 2 reasoning models are active", () => {
    const { ctx, manager, listView } = makeCtx({
      "anthropic/claude": {
        runtime: "remote",
        provider: "anthropic",
        modelId: "claude",
        label: "Claude",
        kinds: ["reasoning"],
      },
      "openai/gpt": {
        runtime: "remote",
        provider: "openai",
        modelId: "gpt",
        label: "GPT",
        kinds: ["reasoning"],
      },
    });
    createModelPickerController(ctx);
    manager.store.setStatus("anthropic/claude", "ready");
    manager.store.setStatus("openai/gpt", "ready");
    listView.recompute(
      manager.store.getStates(),
      {
        activeModels: {
          reasoning: ["anthropic/claude", "openai/gpt"],
          embedding: [],
        },
      },
      {
        reasoning: ["anthropic/claude", "openai/gpt"],
        embedding: [],
      },
    );

    const picker = getModelPickerView(ctx);
    expect(picker.mode).toBe("multi");
    expect(picker.items).toHaveLength(2);

    // Selecting a different model switches the active key
    picker.selectAction.submit("openai/gpt");
    expect(manager.store.activeModelKey).toBe("openai/gpt");
    expect(picker.currentKey).toBe("openai/gpt");
  });
});
