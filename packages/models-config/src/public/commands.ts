import { defineCommand } from "@statewalker/shared-commands";

/** Opens the Models List dialog. */
export const SelectModelCommand = defineCommand<void, void>("models-config:select-model", () => {});

/** Opens the Remote Connections dialog. */
export const ManageRemoteConnectionsCommand = defineCommand<void, void>(
  "models-config:manage-remote-connections",
  () => {},
);

/** Opens the Local Models dialog. */
export const ManageLocalModelsCommand = defineCommand<void, void>(
  "models-config:manage-local-models",
  () => {},
);

export interface RefreshConnectionModelsPayload {
  connectionId: string;
}

/**
 * Trigger a `/v1/models` fetch for the named Connection. The logic
 * fragment's listener writes the result into
 * `Connection.discoveredModels` and `discoveredAt`.
 */
export const RefreshConnectionModelsCommand = defineCommand<RefreshConnectionModelsPayload, void>(
  "models-config:refresh-connection-models",
  () => {},
);
