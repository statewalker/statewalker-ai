import { DockPanelView, Layout } from "@statewalker/workbench-views";
import type { Workspace } from "@statewalker/workspace-api";
import { AiConfigView } from "../views/ai-config.view.js";

const PANEL_KEY = "ai-config:main";

/**
 * Mount the AI configurator dock panel into the workspace's `Layout`.
 * Returns a cleanup that removes the panel.
 *
 * The panel area is hardcoded to `"right"`. Hosts wanting different
 * placement can publish their own panel using the same `AiConfigView`
 * (which is intentionally not part of the public surface — promote
 * later if a second consumer appears).
 */
export function mountConfigPanel(workspace: Workspace): () => void {
  const layout = workspace.requireAdapter(Layout);
  const panel = new DockPanelView({
    key: PANEL_KEY,
    label: "AI",
    icon: "sparkles",
    area: "right",
    content: new AiConfigView(),
  });
  return layout.publishPanel(panel);
}
