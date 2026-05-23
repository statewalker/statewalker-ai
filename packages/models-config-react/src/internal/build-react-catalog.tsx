import type { Actions, Components } from "@json-render/react";
import { type DefineRegistryResult, defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { type ModelsConfigCatalog, modelsConfigCatalog } from "@statewalker/models-config";
import { FieldInput } from "./field-input.js";
import { MarkdownText } from "./markdown-text.js";

export interface BuildRegistryOptions {
  /** Action implementations keyed by action name (see action-handlers.ts). */
  actions: Record<string, (params: Record<string, unknown>) => Promise<void>>;
}

/**
 * Build the json-render `Registry` for the `models-config` catalog
 * by combining the shadcn React bindings with the bespoke `Markdown`
 * primitive. The `actions` map is supplied by the overlay host (it
 * closes over workspace adapters / commands).
 */
export function buildModelsConfigRegistry(options: BuildRegistryOptions): DefineRegistryResult {
  const components = {
    ...shadcnComponents,
    Markdown: MarkdownText,
    FieldInput,
  } as unknown as Components<ModelsConfigCatalog>;
  const actions = options.actions as unknown as Actions<ModelsConfigCatalog>;
  return defineRegistry(modelsConfigCatalog, { components, actions });
}
