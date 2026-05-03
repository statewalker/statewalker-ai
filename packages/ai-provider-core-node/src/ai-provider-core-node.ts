import { ModelManager } from "@statewalker/ai-provider-core";
import { registerNodeProviders } from "@statewalker/ai-provider-node";
import { getWorkspace } from "@statewalker/workspace-api";

/**
 * Register the node-only AI engine (llama.cpp) on the shared ModelManager
 * published by `@statewalker/ai-provider-core`.
 *
 * Registration is deferred to `workspace.onLoad` because the underlying
 * ModelManager needs the workspace's FilesApi, which is only set after
 * `workspace.setFileSystem(...) → open()` runs.
 *
 * Activator order: `initAiProviderCore(ctx)` MUST register the
 * ModelManager adapter first — this activator throws "No adapter
 * registered for ModelManager" otherwise (deferred to onLoad firing).
 *
 * Configuration:
 * - `ctx.aiProviderLlamaCppRootDir` — required real-filesystem directory
 *   that maps to the FilesApi virtual root. `node-llama-cpp` memory-maps
 *   GGUF files and needs an on-disk path. Pass the same `rootDir` given
 *   to `NodeFilesApi`. If unset, the activator skips llama.cpp registration
 *   silently — the node host has not opted into llama.cpp.
 *
 * Returns the unsubscriber from `onLoad` so the host can dispose.
 */
export default function initAiProviderCoreNode(ctx: Record<string, unknown>): () => void {
  const ws = getWorkspace(ctx);
  ws.requireAdapter(ModelManager);
  return ws.onLoad(() => {
    const manager = ws.requireAdapter(ModelManager).impl;
    const rootDir = ctx.aiProviderLlamaCppRootDir as string | undefined;
    if (!rootDir) return;
    registerNodeProviders(manager, { rootDir });
  });
}
