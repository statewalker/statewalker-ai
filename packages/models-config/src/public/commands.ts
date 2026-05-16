import { Command, passthrough } from "@statewalker/shared-commands";

/** Opens the Models List dialog. */
export const SelectModelCommand = Command.silent("models-config:select-model")
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();

/** Opens the Remote Connections dialog. */
export const ManageRemoteConnectionsCommand = Command.silent(
  "models-config:manage-remote-connections",
)
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();

/** Opens the Local Models dialog. */
export const ManageLocalModelsCommand = Command.silent("models-config:manage-local-models")
  .input(passthrough<void>())
  .output(passthrough<void>())
  .build();

export interface RefreshConnectionModelsPayload {
  connectionId: string;
}

/**
 * Trigger a `/v1/models` fetch for the named Connection. The logic
 * fragment's listener writes the result into
 * `Connection.discoveredModels` and `discoveredAt`.
 */
export const RefreshConnectionModelsCommand = Command.silent(
  "models-config:refresh-connection-models",
)
  .input(passthrough<RefreshConnectionModelsPayload>())
  .output(passthrough<void>())
  .build();
