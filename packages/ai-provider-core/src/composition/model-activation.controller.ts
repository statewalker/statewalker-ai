import type { ModelManager } from "@statewalker/ai-provider";
import { newAdapter } from "@statewalker/shared-adapters";
import { BaseClass } from "@statewalker/shared-baseclass";
import { resolveActivationSettings } from "../core/resolve-settings.js";

/**
 * Persistent model activation lifecycle controller.
 *
 * Owns activation state (downloading, activating, progress) independently
 * of the model picker dialog. Closing the dialog does NOT cancel activation.
 */
export class ModelActivationController extends BaseClass {
  #isActivating = false;
  #activationMessage = "";
  #abort: AbortController | null = null;

  get isActivating(): boolean {
    return this.#isActivating;
  }

  get activationMessage(): string {
    return this.#activationMessage;
  }

  /**
   * Start activating a model by catalog key.
   * Returns a promise that resolves with the catalog key on success,
   * or rejects on error/cancellation.
   */
  async activate(
    ctx: Record<string, unknown>,
    manager: ModelManager,
    catalogKey: string,
  ): Promise<string> {
    // Cancel any in-progress activation
    this.#abort?.abort();

    const abort = new AbortController();
    this.#abort = abort;
    this.#isActivating = true;
    this.#activationMessage = "Activating...";
    this.notify();

    try {
      const settings = resolveActivationSettings(ctx, manager, catalogKey);
      for await (const p of manager.activate(catalogKey, { settings })) {
        if (abort.signal.aborted) {
          throw new Error("Activation cancelled");
        }
        this.#activationMessage = p.message;
        this.notify();
        if (p.phase === "error") {
          throw p.error ?? new Error(p.message);
        }
      }
      this.#isActivating = false;
      this.#activationMessage = "";
      this.#abort = null;
      this.notify();
      return catalogKey;
    } catch (err) {
      this.#isActivating = false;
      this.#activationMessage = String(err);
      this.#abort = null;
      this.notify();
      throw err;
    }
  }

  /**
   * Cancel any in-progress activation.
   */
  cancel(): void {
    if (this.#abort) {
      this.#abort.abort();
      this.#abort = null;
      this.#isActivating = false;
      this.#activationMessage = "";
      this.notify();
    }
  }
}

export const [
  getModelActivationController,
  setModelActivationController,
  removeModelActivationController,
] = newAdapter<ModelActivationController>(
  "controller:model-activation",
  () => new ModelActivationController(),
);
