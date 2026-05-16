import type { ProviderV3 } from "@ai-sdk/provider";

/**
 * Catalog-listing entry returned from `ProviderDescriptor.listModels`.
 * Used by the model picker. Plain data, no React.
 */
export interface ProviderModelInfo {
  id: string;
  label: string;
  /** Optional grouping tag for the picker (e.g. "Reasoning", "Fast"). */
  group?: string;
}

/**
 * Plug-in surface for a remote provider — what gets contributed into
 * the `providers:remote` slot. The fragment owning the descriptor
 * must close `createProvider` over its credentials so consumers can
 * call `provider.languageModel(modelId)` without re-resolving anything.
 *
 * One descriptor per `Connection` (see `providers-store.ts`). The
 * providers fragment builds the descriptor list from
 * `config.connections` (built-ins for canonical types,
 * OpenAI-compatible for `type: "openai-compatible"`). Plug-in
 * fragments contribute additional descriptors directly to the slot.
 */
export interface ProviderDescriptor {
  /** Stable identifier — the originating `Connection.id` for
   * fragment-built descriptors, or a plug-in-supplied id. Used by
   * `ActiveModel.providerId`. */
  id: string;
  /** Display label (the Connection's `name`, e.g. "OpenAI",
   * "OpenAI (work)", "LM Studio"). */
  label: string;
  /** Derived from `Connection.type`: `"canonical"` for the three
   * first-party SDK types, `"custom"` for `openai-compatible`.
   * Plug-in fragments use whichever value fits their integration. */
  kind: "canonical" | "custom";
  /** Resolve to the actual `ProviderV3` instance. Closes over
   * credentials. May be called multiple times across rebuilds. */
  createProvider(): ProviderV3;
  /** Models exposed by this provider. Used by the model picker.
   * Returning a Promise lets descriptors hit a remote catalog;
   * implementations that ship a static list return synchronously. */
  listModels(): readonly ProviderModelInfo[] | Promise<readonly ProviderModelInfo[]>;
}
