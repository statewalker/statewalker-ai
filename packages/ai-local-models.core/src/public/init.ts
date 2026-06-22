import { ActiveModel } from "@statewalker/ai-agent-runtime.core";
import { settingsTabSlot } from "@statewalker/settings.core";
import { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import { getWorkspace } from "@statewalker/workspace.core";
import { SelectLocalModelCommand } from "./commands.js";
import { LOCAL_MODELS_TAB_ID, LOCAL_MODELS_TAB_VIEW_KEY } from "./constants.js";
import { LocalModels } from "./local-models.js";

/**
 * Logic-fragment init for `ai-local-models`. Owns the local-model
 * lifecycle: the `LocalModels` adapter (engine + own persistence), the
 * Local Models settings tab slot, the select-local command, and
 * restore-on-load of the active local model.
 *
 * `LocalModels` is registered as a lazy factory because `workspace.files`
 * throws while no FileSystem is installed; the factory only fires once a
 * consumer (or our own `onLoad`) first reaches for the adapter — at which
 * point the workspace is open and `workspace.files` is safe to read.
 *
 * Remote selection is owned by `AiConfig` + the chat-app projection; this
 * fragment only writes `ActiveModel{kind:"local"}`.
 */
export default function initAiLocalModels(ctx: Record<string, unknown>): () => Promise<void> {
  const workspace = getWorkspace(ctx);
  const commands = workspace.requireAdapter(Commands);
  const slots = workspace.requireAdapter(Slots);
  const activeModel = workspace.requireAdapter(ActiveModel);

  workspace.setAdapter(LocalModels, (ws) => new LocalModels({ files: ws.files }));

  const [register, cleanup] = newRegistry();

  register(
    slots.provide(settingsTabSlot, {
      id: LOCAL_MODELS_TAB_ID,
      title: "Local Models",
      viewKey: LOCAL_MODELS_TAB_VIEW_KEY,
      order: 30,
    }),
  );

  register(
    commands.listen(SelectLocalModelCommand, (cmd) => {
      void selectLocal(cmd.payload.modelId)
        .then(() => cmd.resolve())
        .catch((err) => cmd.reject(err));
      return true;
    }),
  );

  register(workspace.onLoad(() => void onLoad()));
  if (workspace.isOpened) void onLoad();

  async function onLoad(): Promise<void> {
    const localModels = workspace.requireAdapter(LocalModels);
    await localModels.load();
    // Restore the active local model if one was persisted.
    if (localModels.config.active) await selectLocal(localModels.config.active);
  }

  async function selectLocal(modelKey: string | undefined): Promise<void> {
    const localModels = workspace.requireAdapter(LocalModels);
    if (!modelKey) {
      await localModels.setActiveKey(undefined);
      activeModel.clear();
      return;
    }
    activeModel.set({
      kind: "local",
      providerId: "local",
      modelId: modelKey,
      createProvider: () => localModels.buildProvider(modelKey),
    });
    await localModels.setActiveKey(modelKey);
    // Kick off in-memory activation in the background. Failures surface
    // through ModelStateStore's status and propagate to the
    // AgentRuntimeAdapter on the runtime's next generate call.
    void consumeActivation(localModels, modelKey);
  }

  return cleanup;
}

async function consumeActivation(localModels: LocalModels, key: string): Promise<void> {
  try {
    for await (const _progress of localModels.manager.activate(key)) {
      // Drained — progress observability happens through
      // ModelStateStore.onUpdate which the renderer-side bridge mirrors.
    }
  } catch (err) {
    console.error(`[ai-local-models] local activation failed for ${key}:`, err);
  }
}
