import type { ModelManager } from "@statewalker/ai-agent/models";
import { registerLocalProvider } from "./transformers/register.js";
import { registerWebLLMProvider } from "./webllm/register.js";

/**
 * Register both browser engines (transformers.js + WebLLM) on a `ModelManager`.
 * Replaces the former `initAiProviderCoreBrowser` activator package.
 */
export function registerBrowserProviders(manager: ModelManager): void {
  registerLocalProvider(manager);
  registerWebLLMProvider(manager);
}
