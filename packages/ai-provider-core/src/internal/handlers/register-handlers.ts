import { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import { registerActivationHandlers } from "./activation.handler.js";
import { registerListModelsHandlers } from "./list-models.handler.js";
import { registerLocalModelHandlers } from "./local-models.handler.js";
import { registerOpenHandlers } from "./open.handler.js";
import { registerProviderHandlers } from "./providers.handler.js";

export function registerIntentHandlers(workspace: Workspace): () => void {
  const intents = workspace.requireAdapter(Intents);
  const [register, cleanup] = newRegistry();

  register(registerOpenHandlers(workspace, intents));
  register(registerProviderHandlers(workspace, intents));
  register(registerLocalModelHandlers(workspace, intents));
  register(registerListModelsHandlers(workspace, intents));
  register(registerActivationHandlers(workspace, intents));

  return cleanup;
}
