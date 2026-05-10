import { newRegistry } from "@statewalker/shared-registry";
import { getWorkspace } from "@statewalker/workspace";
import { AgentRuntimeManager } from "../internal/agent-runtime.manager.js";
import { ActiveModel } from "./active-model.js";
import { AgentRuntimeAdapter } from "./runtime-state.js";

/**
 * Logic-fragment init for `agent-runtime`. Constructs the
 * `ActiveModel` adapter (the resolved provider+model pointer), the
 * `AgentRuntimeAdapter` adapter (the unified state machine), and
 * the `AgentRuntimeManager` (re-entrant orchestrator).
 *
 * `ActiveModel` writes are owned by the `providers/` fragment
 * (Wave 4.2). The agent-runtime manager only observes the pointer
 * and rebuilds `AgentRuntime` accordingly — it does not load
 * providers.json itself.
 *
 * Boot order: register AFTER `initWorkspaceBridge` (so workspace
 * lifecycle hooks are wired). The `providers/` fragment registers
 * AFTER this one (it depends on the two adapters above). Per
 * ADR 0002 (logic-only): no React imports.
 */
export default function initAgentRuntime(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const workspace = getWorkspace(ctx);

  workspace.setAdapter(ActiveModel);
  workspace.setAdapter(AgentRuntimeAdapter);

  const [register, cleanup] = newRegistry();
  const manager = new AgentRuntimeManager({ workspace });
  register(() => manager.close());

  return cleanup;
}
