import { type Intents, newIntent } from "@statewalker/shared-intents";

export type { Intents };

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

// ── Local-model lifecycle (G2) ─────────────────────────────────────────────

import type { ActivationProgress } from "@statewalker/ai-agent/models";
import type {
  CancelDownloadPayload,
  DeleteLocalModelPayload,
  DownloadModelPayload,
  DownloadModelResult,
  StorageInfo,
} from "./types.js";

/**
 * Trigger a download of model weights for a local model. Resolves with
 * `{ ok: true }` only after the model is fully downloaded. Progress
 * events fire as `ai-provider:activation-progress` broadcasts during
 * the download.
 */
export const [runDownloadModel, handleDownloadModel] = newIntent<
  DownloadModelPayload,
  DownloadModelResult
>("ai-provider:download-model");

/** Cancel an in-progress download for the given catalog key. */
export const [runCancelDownload, handleCancelDownload] = newIntent<CancelDownloadPayload, void>(
  "ai-provider:cancel-download",
);

/** Delete downloaded weights for a local model. */
export const [runDeleteLocalModel, handleDeleteLocalModel] = newIntent<
  DeleteLocalModelPayload,
  void
>("ai-provider:delete-local-model");

/**
 * Enumerate per-engine storage info (total bytes, model count). Used by
 * the configurator UI to display disk usage.
 */
export const [runListStorages, handleListStorages] = newIntent<undefined, StorageInfo[]>(
  "ai-provider:list-storages",
);

/**
 * Broadcast intent — fires on every activation/download progress event.
 * Handlers MUST be observers (return false) so multiple subscribers can
 * react.
 */
export const [runActivationProgress, handleActivationProgress] = newIntent<
  ActivationProgress,
  void
>("ai-provider:activation-progress");

// ── List models (G3) ───────────────────────────────────────────────────────

import type { ListModelsPayload, ModelDescriptor } from "./types.js";

/**
 * List every model known to the system, optionally filtered by
 * runtime / role / providerId / instanceId / status. Source of truth
 * for the model-list panel and pickers.
 */
export const [runListModels, handleListModels] = newIntent<
  ListModelsPayload | undefined,
  ModelDescriptor[]
>("ai-provider:list-models");

// ── Per-role activation (G5, G6) ───────────────────────────────────────────

import type {
  ActivateModelPayload,
  ActivateModelResult,
  DeactivateModelPayload,
  GetActiveModelPayload,
  GetActiveModelResult,
  PickModelPayload,
  PickModelResult,
} from "./types.js";

/**
 * Activate a model for a specific role. Resolves with `{ ok, error? }`
 * after the model is loaded and assigned to the corresponding
 * `Active{Reasoning,Embedding}Model` adapter. Broadcasts
 * `ai-provider:active-model-changed`.
 */
export const [runActivateModel, handleActivateModel] = newIntent<
  ActivateModelPayload,
  ActivateModelResult
>("ai-provider:activate-model");

/**
 * Deactivate the currently-active model for a role. Clears the
 * corresponding adapter and broadcasts `ai-provider:active-model-changed`.
 */
export const [runDeactivateModel, handleDeactivateModel] = newIntent<DeactivateModelPayload, void>(
  "ai-provider:deactivate-model",
);

/**
 * Read the currently-active model for a role. Returns `undefined` if
 * no model is active. The `model` field is a live `LanguageModelV3`
 * usable directly with the Vercel AI SDK.
 */
export const [runGetActiveModel, handleGetActiveModel] = newIntent<
  GetActiveModelPayload,
  GetActiveModelResult
>("ai-provider:get-active-model");

/**
 * Open a model picker UI (e.g. inline from chat input). Resolves with
 * the chosen catalog key, or `undefined` if the user dismissed the
 * picker. Optional `role` scopes the choice to models eligible for
 * that role.
 */
export const [runPickModel, handlePickModel] = newIntent<PickModelPayload, PickModelResult>(
  "ai-provider:pick-model",
);
