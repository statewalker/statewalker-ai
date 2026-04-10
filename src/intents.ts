import type { LanguageModelV3 } from "@ai-sdk/provider";
import { newAdapter } from "@repo/shared/adapters";
import { type Intents, newIntent } from "@repo/shared/intents";

export type { Intents };

/**
 * The fragment shares the host app's Intents instance.
 * The host must call setIntents(ctx, intents) before initAiProviderCore(ctx).
 * No default factory — throws if not set.
 */
export const [getIntents, setIntents] = newAdapter<Intents>(
  "ai-provider:intents",
);

/** Open the full Model Settings panel. */
export const [runOpenModelSettings, handleOpenModelSettings] = newIntent<
  { tab?: "providers" | "models" | "active" } | undefined,
  void
>("ai-provider:open-settings");

/** Pick a model (inline, from the chat input). Resolves with the selected catalog key. */
export const [runPickModel, handlePickModel] = newIntent<
  void,
  { catalogKey: string }
>("ai-provider:pick-model");

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
