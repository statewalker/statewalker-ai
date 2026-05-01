import type { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import { Layout } from "@statewalker/workbench-views";
import type { Workspace } from "@statewalker/workspace-api";
import { handleOpen } from "../../public/intents.js";

const PANEL_KEY = "ai-config:main";

/**
 * Register the `ai-provider:open` intent handler. Brings the
 * configurator dock panel into focus. Section-level focus
 * (`focus: "reasoning" | "embedding" | "providers"`) is handled by the
 * manager's panel-focus listener — this handler only ensures the panel
 * is the focused tab.
 */
export function registerOpenHandlers(workspace: Workspace, intents: Intents): () => void {
  const [register, cleanup] = newRegistry();

  register(
    handleOpen(intents, (intent) => {
      try {
        workspace.requireAdapter(Layout).focus(PANEL_KEY);
      } catch {
        // Layout may not be available in some contexts (tests with no workbench shell).
      }
      intent.resolve();
      return true;
    }),
  );

  return cleanup;
}
