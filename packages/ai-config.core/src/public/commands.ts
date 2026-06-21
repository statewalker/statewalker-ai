import { Command, passthrough } from "@statewalker/shared-commands";
import type { Connection, DiscoveredModel } from "./types.js";

export interface UpsertConnectionPayload {
  connection: Omit<Connection, "discoveredModels" | "discoveredAt">;
  apiKey?: string;
}
export const UpsertConnectionCommand = Command.silent("ai-config:upsert-connection")
  .input(passthrough<UpsertConnectionPayload>())
  .output(passthrough<void>())
  .build();

export const RemoveConnectionCommand = Command.silent("ai-config:remove-connection")
  .input(passthrough<{ id: string }>())
  .output(passthrough<void>())
  .build();

export const SetApiKeyCommand = Command.silent("ai-config:set-key")
  .input(passthrough<{ connectionId: string; apiKey: string }>())
  .output(passthrough<void>())
  .build();

export const RefreshModelsCommand = Command.silent("ai-config:refresh-models")
  .input(passthrough<{ connectionId: string }>())
  .output(passthrough<readonly DiscoveredModel[]>())
  .build();

export const SetActiveModelCommand = Command.silent("ai-config:set-active")
  .input(passthrough<{ connectionId: string; modelId: string }>())
  .output(passthrough<void>())
  .build();

export const StarModelsCommand = Command.silent("ai-config:star-models")
  .input(passthrough<{ connectionId: string; modelIds: string[] }>())
  .output(passthrough<void>())
  .build();

/**
 * Deep-link command: open the settings dialog on the `ai-config:connections`
 * ("Remote Models") tab. The renderer's init listens for this and fires
 * `OpenSettingsCommand({ tabId })`; the composer's "Configure models…" entry
 * dispatches it. Replaces the old `models-config:configure-models`.
 */
export const ConfigureAiCommand = Command.silent("ai-config:configure")
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();
