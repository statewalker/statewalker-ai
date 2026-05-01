import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import type { Workspace } from "@statewalker/workspace-api";
import { handleOpen } from "../../public/intents.js";

export function registerOpenHandlers(_workspace: Workspace, intents: Intents): () => void {
  const [register, cleanup] = newRegistry();

  register(
    handleOpen(intents, (intent) => {
      intent.resolve();
      return true;
    }),
  );

  return cleanup;
}
