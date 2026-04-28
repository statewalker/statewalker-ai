import { newRegistry } from "@statewalker/shared-registry";
import { removeModelActivationController } from "./model-activation.controller.js";
import { createModelManagerController } from "./model-manager.controller.js";
import { createModelPickerController } from "./model-picker.controller.js";
import { createModelSettingsController } from "./model-settings.controller.js";
import { createStartupController } from "./startup.controller.js";

/**
 * Legacy controller wireup — preserves the pre-reshape 4-intent surface
 * (`ai-provider:open-settings`, `pick-model`, `activate-model`,
 * `get-active-model`) for chat.* consumers during the transition. Wired
 * by `initAiProviderCore` (the new single-ctx activator) until §4-§9
 * replace these controllers with the new 16-intent surface.
 *
 * Prerequisites: legacy `setModelManager(ctx, ...)` (from `core/legacy-adapters`)
 * must be set before calling.
 */
export function initLegacyControllers(ctx: Record<string, unknown>): () => Promise<void> {
  const [register, cleanup] = newRegistry();

  register(createModelManagerController(ctx));
  // Settings controller creates the shared ModelListView.
  register(createModelSettingsController(ctx));
  register(createModelPickerController(ctx));
  register(createStartupController(ctx));
  register(() => removeModelActivationController(ctx));

  return cleanup;
}
