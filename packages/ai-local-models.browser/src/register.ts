import type { ModelManager } from "@statewalker/ai-agent.core/models";
import { registerLocalProvider } from "./transformers/register.js";
// import { registerWebLLMProvider } from "./webllm/register.js";

/**
 * Register browser engines on a `ModelManager`.
 * WebLLM is currently disabled; only transformers.js is wired.
 */
export function registerBrowserProviders(manager: ModelManager): void {
  registerLocalProvider(manager);
  // registerWebLLMProvider(manager);
}
