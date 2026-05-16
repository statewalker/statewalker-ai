import { useAdapter, useAdapterValue } from "@statewalker/core-react";
import { Providers } from "@statewalker/ai-providers";
import {
  ManageLocalModelsCommand,
  ManageRemoteConnectionsCommand,
  SelectModelCommand,
} from "@statewalker/models-config";
import { Button } from "@statewalker/shadcn-react";
import { Commands } from "@statewalker/shared-commands";
import type { ReactElement } from "react";

/**
 * Tab body for the Settings dialog's "Models" entry. Three buttons
 * that open the three models-config dialogs via their workspace
 * commands. Renders a short summary line above the buttons so the
 * user sees the current configuration state at a glance.
 */
export function ModelsSettingsTab(): ReactElement {
  const commands = useAdapter(Commands);
  const config = useAdapterValue(Providers, (p) => p.config);
  const { connections, starred, local, active } = config;

  const summary =
    connections.length === 0
      ? "No connections configured."
      : `${connections.length} connection${connections.length === 1 ? "" : "s"}, ` +
        `${starred.length} starred, ${local.downloaded.length} local model${
          local.downloaded.length === 1 ? "" : "s"
        }.`;
  const activeLabel =
    active.providerId && active.modelId
      ? `Active: ${active.providerId} · ${active.modelId}`
      : "No active model selected.";

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm">{summary}</p>
        <p className="text-xs text-muted-foreground">{activeLabel}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          variant="default"
          onClick={() => {
            void commands.call(SelectModelCommand, undefined);
          }}
        >
          Select a model…
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            void commands.call(ManageRemoteConnectionsCommand, undefined);
          }}
        >
          Manage remote connections…
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            void commands.call(ManageLocalModelsCommand, undefined);
          }}
        >
          Manage local models…
        </Button>
      </div>
    </div>
  );
}
