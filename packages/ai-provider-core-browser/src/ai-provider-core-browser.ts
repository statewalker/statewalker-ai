import { ModelManager } from "@statewalker/ai-provider-core";
import { registerLocalProvider } from "@statewalker/ai-provider-local";
import { registerWebLLMProvider } from "@statewalker/ai-provider-webllm";
import { getWorkspace } from "@statewalker/workspace-api";

/**
 * Register the browser-only AI engines (transformers.js + WebLLM) on the
 * shared ModelManager published by `@statewalker/ai-provider-core`.
 *
 * Engine registration is deferred to `workspace.onLoad` because the
 * underlying ModelManager needs the workspace's FilesApi, which is only
 * set after `workspace.setFileSystem(...) → open()` runs (typically
 * triggered by the `workspace:change` intent at user-pick time).
 *
 * Activator order: `initAiProviderCore(ctx)` MUST register the
 * ModelManager adapter first — this activator throws "No adapter
 * registered for ModelManager" otherwise (deferred to onLoad firing).
 *
 * Returns the unsubscriber from `onLoad` so the host can dispose.
 */
export default function initAiProviderCoreBrowser(
  ctx: Record<string, unknown>,
): () => void {
  const ws = getWorkspace(ctx);
  ws.requireAdapter(ModelManager);
  return ws.onLoad(() => {
    const manager = ws.requireAdapter(ModelManager).impl;
    registerLocalProvider(manager);
    registerWebLLMProvider(manager);
  });
}
