import { newRegistry } from "@repo/shared/registry";
import { createActiveModelsLifecycleController } from "./controllers/active-models-lifecycle.controller.js";
import { removeModelActivationController } from "./controllers/model-activation.controller.js";
import { createModelManagerController } from "./controllers/model-manager.controller.js";
import { createModelPickerController } from "./controllers/model-picker.controller.js";
import { createModelSettingsController } from "./controllers/model-settings.controller.js";
import { createStartupController } from "./controllers/startup.controller.js";

/**
 * Initialises the AI provider fragment.
 *
 * Prerequisites:
 * - ModelManager must be set via setModelManager(ctx, ...) before calling this.
 *
 * Returns a cleanup function.
 */
export function initAiProviderCore(
  ctx: Record<string, unknown>,
): () => Promise<void> {
  const [register, cleanup] = newRegistry();

  register(createModelManagerController(ctx));
  // Settings controller creates the shared ModelListView; lifecycle
  // controller subscribes to it — order matters.
  register(createModelSettingsController(ctx));
  register(createActiveModelsLifecycleController(ctx));
  register(createModelPickerController(ctx));
  register(createStartupController(ctx));
  register(() => removeModelActivationController(ctx));

  return cleanup;
}
