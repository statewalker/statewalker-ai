import { newRegistry } from "@repo/shared/registry";
import { createModelPickerController } from "./controllers/model-picker.controller.js";
import { createModelSettingsController } from "./controllers/model-settings.controller.js";

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

  register(createModelSettingsController(ctx));
  register(createModelPickerController(ctx));

  return cleanup;
}
