import { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { getWorkspace } from "@statewalker/workspace.core";
import { AiConfigImpl } from "../internal/ai-config.impl.js";
import { AiConfig } from "./ai-config.js";
import {
  RefreshModelsCommand,
  RemoveConnectionCommand,
  SetActiveModelCommand,
  SetApiKeyCommand,
  StarModelsCommand,
  UpsertConnectionCommand,
} from "./commands.js";

/**
 * Logic-fragment init for `@statewalker/ai-config`. Registers the single
 * `AiConfig` adapter (the unified source of truth for AI connections/models),
 * loads its config on workspace open (lifting any legacy plaintext key into
 * `Secrets`), and registers the `ai-config:*` command handlers.
 *
 * Per ADR 0002 (logic-only): no React imports. Credentials never touch the
 * config file — keys live in the `Secrets` adapter.
 */
export default function initAiConfig(ctx: Record<string, unknown>): () => Promise<void> {
  const workspace = getWorkspace(ctx);
  const config = new AiConfigImpl(workspace);
  workspace.setAdapter(AiConfig, () => config);

  const commands = workspace.requireAdapter(Commands);
  const [register, cleanup] = newRegistry();

  register(workspace.onLoad(() => void config.load()));

  register(
    commands.listen(UpsertConnectionCommand, (cmd) => {
      void config
        .upsertConnection(cmd.payload.connection, cmd.payload.apiKey)
        .then(() => cmd.resolve())
        .catch((e) => cmd.reject(e));
      return true;
    }),
  );
  register(
    commands.listen(RemoveConnectionCommand, (cmd) => {
      void config
        .removeConnection(cmd.payload.id)
        .then(() => cmd.resolve())
        .catch((e) => cmd.reject(e));
      return true;
    }),
  );
  register(
    commands.listen(SetApiKeyCommand, (cmd) => {
      void config
        .setApiKey(cmd.payload.connectionId, cmd.payload.apiKey)
        .then(() => cmd.resolve())
        .catch((e) => cmd.reject(e));
      return true;
    }),
  );
  register(
    commands.listen(RefreshModelsCommand, (cmd) => {
      void config
        .refreshModels(cmd.payload.connectionId)
        .then((models) => cmd.resolve(models))
        .catch((e) => cmd.reject(e));
      return true;
    }),
  );
  register(
    commands.listen(SetActiveModelCommand, (cmd) => {
      void config
        .setActive(cmd.payload.connectionId, cmd.payload.modelId)
        .then(() => cmd.resolve())
        .catch((e) => cmd.reject(e));
      return true;
    }),
  );
  register(
    commands.listen(StarModelsCommand, (cmd) => {
      void config
        .starModels(cmd.payload.connectionId, cmd.payload.modelIds)
        .then(() => cmd.resolve())
        .catch((e) => cmd.reject(e));
      return true;
    }),
  );

  if (workspace.isOpened) void config.load();

  return cleanup;
}
