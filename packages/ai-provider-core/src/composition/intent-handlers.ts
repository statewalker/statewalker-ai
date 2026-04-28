import { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import { handleOpen } from "../api/intents.js";

/**
 * Register the package's intent handlers on the workspace's `Intents`
 * adapter. Returns a cleanup that unregisters all handlers.
 *
 * Handlers for the §5-§8 intent surface (providers / local-model
 * lifecycle / list-models / per-role activation) plug in here as those
 * sections of the ai-provider-core-reshape change land.
 */
export function registerIntentHandlers(workspace: Workspace): () => void {
  const intents = workspace.requireAdapter(Intents);
  const [register, cleanup] = newRegistry();

  register(
    handleOpen(intents, (intent) => {
      // Configurator-panel focus is a §9 responsibility. Until the
      // panel mounts, resolve immediately so the intent doesn't hang.
      // Future: bring the dock panel forward and apply `intent.payload.focus`.
      intent.resolve();
      return true;
    }),
  );

  return cleanup;
}
