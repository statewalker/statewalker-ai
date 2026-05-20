import type { ConnectionType } from "@statewalker/ai-providers";
import { Command, passthrough } from "@statewalker/shared-commands";

export interface SelectModelPayload {
  connectionId: string;
  modelId: string;
}

/**
 * Sets the current chat session's `modelRef` (and updates the
 * workspace `ActiveModel` as the "last-selected" hint). Semantics
 * changed from the v4 draft, where the void payload opened the
 * Models List dialog — that role is replaced by
 * `ConfigureModelsCommand` below.
 */
export const SelectModelCommand = Command.silent("models-config:select-model")
  .input(passthrough<SelectModelPayload>())
  .output(passthrough<void>())
  .build();

export interface ConfigureModelsPayload {
  /** When supplied, the Settings dialog opens with the corresponding
   * type sub-tab focused inside the Models & Connections tab. */
  typeHint?: ConnectionType;
}

/**
 * Opens the Settings dialog on the Models & Connections tab. The
 * composer dropdown's trailing entry ("Configure models…") fires
 * this with a `typeHint` derived from the current session's model
 * (if any). Replaces the retired `manage-remote-connections` and
 * `manage-local-models` commands from the v4 draft.
 */
export const ConfigureModelsCommand = Command.silent("models-config:configure-models")
  .input(passthrough<ConfigureModelsPayload>())
  .output(passthrough<void>())
  .build();

export interface RefreshConnectionModelsPayload {
  connectionId: string;
}

/**
 * Trigger a `/v1/models` fetch for the named Connection. The logic
 * fragment's listener writes the result into
 * `Connection.discoveredModels` and `discoveredAt`. Used by the
 * Check Connection action (re-fetch, preserves user stars) and
 * the initial Connect action (with default-starred seeding).
 */
export const RefreshConnectionModelsCommand = Command.silent(
  "models-config:refresh-connection-models",
)
  .input(passthrough<RefreshConnectionModelsPayload>())
  .output(passthrough<void>())
  .build();

// ── Legacy commands (transitional) ───────────────────────────────
// Retained while §5/§7 consumers are still using them. Will be
// removed by §3.3 after the overlay host, composer picker, and
// settings tab consumers are rewritten to use ConfigureModelsCommand.

/** @deprecated — use ConfigureModelsCommand (no typeHint). */
export const ManageRemoteConnectionsCommand = Command.silent(
  "models-config:manage-remote-connections",
)
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();

/** @deprecated — use ConfigureModelsCommand (no typeHint). */
export const ManageLocalModelsCommand = Command.silent("models-config:manage-local-models")
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();
