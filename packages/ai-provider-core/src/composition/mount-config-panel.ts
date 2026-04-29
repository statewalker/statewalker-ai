import { Intents } from "@statewalker/shared-intents";
import { newRegistry } from "@statewalker/shared-registry";
import { DockPanelView, Layout } from "@statewalker/workbench-views";
import type { Workspace } from "@statewalker/workspace-api";
import { AiConfigView } from "../views/ai-config.view.js";
import { createAiConfigManager } from "./ai-config.manager.js";

const PANEL_KEY = "ai-config:main";

/**
 * Mount the AI configurator dock panel into the workspace's `Layout`.
 *
 * Builds an `AiConfigView` (composite of role-summary + provider-list +
 * model-list + the two add-* forms + the empty state), publishes it
 * under panel key `"ai-config:main"` in area `"right"`, and wires the
 * view's action publishers + the workspace's intent surface via
 * `createAiConfigManager`. Returns a cleanup that disposes the manager
 * subscriptions and removes the panel.
 */
export function mountConfigPanel(workspace: Workspace): () => void {
  const [register, cleanup] = newRegistry();
  const view = new AiConfigView();
  const intents = workspace.requireAdapter(Intents);
  register(createAiConfigManager(workspace, intents, view));
  const panel = new DockPanelView({
    key: PANEL_KEY,
    label: "AI",
    icon: "sparkles",
    area: "right",
    content: view,
  });
  register(workspace.requireAdapter(Layout).publishPanel(panel));
  return cleanup;
}
