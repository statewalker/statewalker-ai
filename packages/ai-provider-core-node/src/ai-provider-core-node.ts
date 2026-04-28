import { ModelManager } from "@statewalker/ai-provider-core";
import { registerLlamaCppProvider } from "@statewalker/ai-provider-llamacpp";
import { getWorkspace } from "@statewalker/workspace-api";

/**
 * Register the node-only AI engine (llama.cpp) on the shared ModelManager
 * published by `@statewalker/ai-provider-core`.
 *
 * Activator order: `initAiProviderCore(ctx)` MUST run first — this
 * activator throws "No adapter registered for ModelManager" otherwise.
 *
 * Configuration:
 * - `ctx.aiProviderLlamaCppRootDir` — required real-filesystem directory
 *   that maps to the FilesApi virtual root. `node-llama-cpp` memory-maps
 *   GGUF files and needs an on-disk path. Pass the same `rootDir` given
 *   to `NodeFilesApi`. If unset, the activator skips llama.cpp registration
 *   silently — the node host has not opted into llama.cpp.
 */
export default function initAiProviderCoreNode(ctx: Record<string, unknown>): void {
  const ws = getWorkspace(ctx);
  const manager = ws.requireAdapter(ModelManager).impl;
  const rootDir = ctx.aiProviderLlamaCppRootDir as string | undefined;
  if (!rootDir) return;
  registerLlamaCppProvider(manager, { rootDir });
}
