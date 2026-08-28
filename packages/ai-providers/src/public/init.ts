import { newRegistry } from "@statewalker/shared-registry";
import { getWorkspace } from "@statewalker/workspace.core";
import { ProvidersManager } from "../internal/providers.manager.js";
import { Providers } from "./providers.adapter.js";

/**
 * Logic-fragment init for `providers`. Constructs the `Providers`
 * adapter (data) and the `ProvidersManager` (re-entrant
 * orchestrator). The manager owns reading providers.json,
 * contributing to `providers:remote`, and writing `ActiveModel` —
 * replaces the interim bootstrap that lived in agent-runtime
 * (Wave 4.1).
 *
 * Boot order: register AFTER `initAgentRuntime` (this fragment
 * depends on `ActiveModel` and `AgentRuntimeAdapter` adapters being
 * registered). Per ADR 0002 (logic-only), no React imports.
 */
export default function initProviders(ctx: Record<string, unknown>): () => Promise<void> {
  const workspace = getWorkspace(ctx);
  workspace.setAdapter(Providers);

  const [register, cleanup] = newRegistry();
  const manager = new ProvidersManager({ workspace });
  register(() => manager.close());

  return cleanup;
}
