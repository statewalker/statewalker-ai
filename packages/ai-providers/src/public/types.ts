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
 * Built-in descriptors (OpenAI, Anthropic, Google) are contributed by
 * the providers fragment itself. Custom OpenAI-compatible endpoints
 * loaded from `providers.json` produce one descriptor each. Plug-in
 * fragments contribute additional descriptors via `provideRemoteProvider`.
 */
export interface ProviderDescriptor {
  /** Stable identifier — canonical name, custom-provider id, or
   * plug-in-supplied id. Used by `ActiveModel.providerId`. */
  id: string;
  /** Display label (e.g. "OpenAI", "LM Studio"). */
  label: string;
  /** Distinguishes built-in (canonical) descriptors from user-defined
   * OpenAI-compatible endpoints. Plug-in fragments use their own
   * `kind` value if needed; the providers fragment ignores the
   * `kind` for its core flow. */
  kind: "canonical" | "custom";
  /** Resolve to the actual `ProviderV3` instance. Closes over
   * credentials. May be called multiple times across rebuilds. */
  createProvider(): ProviderV3;
  /** Models exposed by this provider. Used by the model picker.
   * Returning a Promise lets descriptors hit a remote catalog;
   * implementations that ship a static list return synchronously. */
  listModels():
    | readonly ProviderModelInfo[]
    | Promise<readonly ProviderModelInfo[]>;
}
