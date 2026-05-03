import type { ModelManager } from "@statewalker/ai-agent/models";
import { registerLlamaCppProvider } from "./register.js";

export interface NodeProvidersOptions {
  /**
   * Real-filesystem directory that maps to the manager's FilesApi virtual
   * root. node-llama-cpp memory-maps GGUF files and needs an on-disk path.
   */
  rootDir: string;
}

/**
 * Register the Node-only AI engines (currently llama.cpp) on a `ModelManager`.
 * Convenience activator equivalent to the former `initAiProviderCoreNode`
 * shim in `@statewalker/ai-provider-core-node`.
 */
export function registerNodeProviders(manager: ModelManager, opts: NodeProvidersOptions): void {
  registerLlamaCppProvider(manager, { rootDir: opts.rootDir });
}
