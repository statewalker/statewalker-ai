import { ModelManager } from "@statewalker/ai-provider-core";
import { registerLocalProvider } from "@statewalker/ai-provider-local";
import { registerWebLLMProvider } from "@statewalker/ai-provider-webllm";
import { getWorkspace } from "@statewalker/workspace-api";

/**
 * Register the browser-only AI engines (transformers.js + WebLLM) on the
 * shared ModelManager published by `@statewalker/ai-provider-core`.
 *
 * Activator order: `initAiProviderCore(ctx)` MUST run first — this
 * activator throws "No adapter registered for ModelManager" otherwise.
 */
export default function initAiProviderCoreBrowser(ctx: Record<string, unknown>): void {
  const ws = getWorkspace(ctx);
  const manager = ws.requireAdapter(ModelManager).impl;
  registerLocalProvider(manager);
  registerWebLLMProvider(manager);
}
