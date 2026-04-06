import type { ToolRegistry } from "../state/tool-registry.js";
import type { McpClientManager } from "./mcp-client-manager.js";

/**
 * Syncs MCP tools into a ToolRegistry. Listens for McpClientManager
 * updates and re-registers tools when MCP servers change.
 *
 * @returns Cleanup function that stops listening and unregisters all MCP tools.
 */
export function bridgeMcpTools(
  mcp: McpClientManager,
  registry: ToolRegistry,
): () => void {
  let cleanups: Array<() => void> = [];

  function sync() {
    for (const fn of cleanups) fn();
    cleanups = [];
    for (const [name, tool] of Object.entries(mcp.tools)) {
      cleanups.push(registry.register(name, tool));
    }
  }

  sync();
  const unsub = mcp.onUpdate(sync);
  return () => {
    unsub();
    for (const fn of cleanups) fn();
    cleanups = [];
  };
}
