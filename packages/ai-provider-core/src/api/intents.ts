import type { LanguageModelV3 } from "@ai-sdk/provider";
import { newAdapter } from "@statewalker/shared-adapters";
import { type Intents, newIntent } from "@statewalker/shared-intents";

export type { Intents };

/**
 * The fragment shares the host app's Intents instance.
 * The host must call setIntents(ctx, intents) before initAiProviderCore(ctx).
 * No default factory — throws if not set.
 */
export const [getIntents, setIntents] = newAdapter<Intents>("ai-provider:intents");

/**
 * Open the full Model Settings panel.
 *
 * The legacy `{ tab }` payload is accepted for one release but ignored;
 * the panel now presents all content as a single list grouped by provider.
 * Callers should omit the payload. A deprecation warning is logged when
 * the field is supplied — see `model-settings.controller.ts`.
 *
 * @deprecated Use `runOpen` instead. The new canonical intent is
 *   `ai-provider:open` — see {@link runOpen}. Migration: replace any
 *   `runOpenModelSettings(intents, ...)` call with `runOpen(intents, ...)`.
 */
export const [runOpenModelSettings, handleOpenModelSettings] = newIntent<
  { tab?: "providers" | "models" | "active" } | undefined,
  void
>("ai-provider:open-settings");

/**
 * Canonical "open AI configurator" command intent. Replaces
 * `ai-provider:open-settings` and the duplicate `ai-provider:open` that
 * lived in `apps/ai-provider.api`.
 *
 * Resolves once the configurator panel has been brought into focus (or
 * immediately if no panel is mounted yet — handler responsibility).
 */
export const [runOpen, handleOpen] = newIntent<
  { focus?: "reasoning" | "embedding" | "providers" } | undefined,
  void
>("ai-provider:open");

// ── Provider management (G1, G4) ───────────────────────────────────────────

import type {
  ConfigureProviderPayload,
  ConfigureProviderResult,
  ListProvidersPayload,
  ProviderDescriptor,
  RemoveProviderPayload,
} from "./types.js";

/** List configured providers, optionally filtered by runtime. */
export const [runListProviders, handleListProviders] = newIntent<
  ListProvidersPayload | undefined,
  ProviderDescriptor[]
>("ai-provider:list-providers");

/**
 * Add or update a provider configuration. Persists via
 * `ProviderSettingsStore` and emits an `ai-provider:providers-changed`
 * broadcast on success. If `test: true`, the handler MAY validate
 * credentials before persisting (handler decision).
 */
export const [runConfigureProvider, handleConfigureProvider] = newIntent<
  ConfigureProviderPayload,
  ConfigureProviderResult
>("ai-provider:configure-provider");

/**
 * Remove a provider configuration. Cascade: if any model from the
 * removed provider is currently active in either role, the
 * corresponding `Active{Reasoning,Embedding}Model` adapter is cleared
 * and `ai-provider:active-model-changed` broadcasts.
 */
export const [runRemoveProvider, handleRemoveProvider] = newIntent<RemoveProviderPayload, void>(
  "ai-provider:remove-provider",
);

/**
 * Broadcast intent — fires after every provider-set mutation. Payload
 * is the full updated descriptor list. Handlers MUST be observers (not
 * claim the intent) so multiple subscribers can react.
 */
export const [runProvidersChanged, handleProvidersChanged] = newIntent<ProviderDescriptor[], void>(
  "ai-provider:providers-changed",
);

/**
 * Broadcast intent — fires on every active-model mutation. Payload is
 * the role + new catalog key (undefined when cleared). Handlers MUST
 * be observers.
 */
export const [runActiveModelChanged, handleActiveModelChanged] = newIntent<
  { role: "reasoning" | "embedding"; catalogKey: string | undefined },
  void
>("ai-provider:active-model-changed");

/** Pick a model (inline, from the chat input). Resolves with the selected catalog key. */
export const [runPickModel, handlePickModel] = newIntent<void, { catalogKey: string }>(
  "ai-provider:pick-model",
);

/** Activate a specific model (download/load/verify). Resolves with the ready model instance. */
export const [runActivateModel, handleActivateModel] = newIntent<
  { catalogKey: string },
  { model: LanguageModelV3 }
>("ai-provider:activate-model");

/** Get the currently active model. Resolves with the model or undefined. */
export const [runGetActiveModel, handleGetActiveModel] = newIntent<
  void,
  { catalogKey: string; model: LanguageModelV3 } | undefined
>("ai-provider:get-active-model");
