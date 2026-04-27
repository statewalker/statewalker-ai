import { newRegistry } from "@statewalker/shared-registry";
import { removeModelActivationController } from "./model-activation.controller.js";
import { createModelManagerController } from "./model-manager.controller.js";
import { createModelPickerController } from "./model-picker.controller.js";
import { createModelSettingsController } from "./model-settings.controller.js";
import { createStartupController } from "./startup.controller.js";

/**
 * Initialises the AI provider fragment.
 *
 * Prerequisites:
 * - ModelManager must be set via setModelManager(ctx, ...) before calling this.
 *
 * The active-models lifecycle controller is NOT registered here — it
 * depends on a FilesApi which is only available once the workspace has
 * booted. Host apps must call `createActiveModelsLifecycleController(ctx)`
 * after `setActiveModelsFilesApi(ctx, filesApi)` has been invoked.
 *
 * Returns a cleanup function.
 */
export function initAiProviderCore(ctx: Record<string, unknown>): () => Promise<void> {
  const [register, cleanup] = newRegistry();

  register(createModelManagerController(ctx));
  // Settings controller creates the shared ModelListView.
  register(createModelSettingsController(ctx));
  register(createModelPickerController(ctx));
  register(createStartupController(ctx));
  register(() => removeModelActivationController(ctx));

  return cleanup;
}
