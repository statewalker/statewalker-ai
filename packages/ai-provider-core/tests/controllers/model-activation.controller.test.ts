import { describe, expect, it } from "vitest";
import { ModelActivationController } from "../../src/controllers/model-activation.controller.js";

function createMockManager(phases: Array<{ phase: string; message: string; error?: Error }>) {
  return {
    store: {
      getState: () => ({ config: { runtime: "local", engine: "tjs" } }),
      getStates: () => new Map(),
    },
    async *activate() {
      for (const p of phases) {
        yield p;
      }
    },
  } as never;
}

describe("ModelActivationController", () => {
  it("starts with idle state", () => {
    const ctrl = new ModelActivationController();
    expect(ctrl.isActivating).toBe(false);
    expect(ctrl.activationMessage).toBe("");
  });

  it("sets isActivating during activation", async () => {
    const ctrl = new ModelActivationController();
    const ctx = {};
    const manager = createMockManager([
      { phase: "download", message: "Downloading..." },
      { phase: "ready", message: "Ready" },
    ]);

    const states: boolean[] = [];
    ctrl.onUpdate(() => states.push(ctrl.isActivating));

    await ctrl.activate(ctx, manager, "test-model");

    // Should have gone: true → true (message update) → true (message update) → false
    expect(states[0]).toBe(true); // activation started
    expect(states[states.length - 1]).toBe(false); // activation complete
  });

  it("resolves with catalog key on success", async () => {
    const ctrl = new ModelActivationController();
    const ctx = {};
    const manager = createMockManager([{ phase: "ready", message: "Done" }]);

    const result = await ctrl.activate(ctx, manager, "my-model");
    expect(result).toBe("my-model");
    expect(ctrl.isActivating).toBe(false);
    expect(ctrl.activationMessage).toBe("");
  });

  it("rejects on error phase", async () => {
    const ctrl = new ModelActivationController();
    const ctx = {};
    const manager = createMockManager([
      { phase: "error", message: "API key invalid", error: new Error("401") },
    ]);

    await expect(ctrl.activate(ctx, manager, "bad-model")).rejects.toThrow("401");
    expect(ctrl.isActivating).toBe(false);
    expect(ctrl.activationMessage).toBe("Error: 401");
  });

  it("cancel() stops activation", () => {
    const ctrl = new ModelActivationController();
    const ctx = {};
    // Create a manager that yields indefinitely
    const manager = {
      store: {
        getState: () => ({ config: { runtime: "local", engine: "tjs" } }),
      },
      async *activate() {
        yield { phase: "download", message: "Downloading..." };
        // Will be cancelled before reaching here
        await new Promise(() => {}); // hang forever
      },
    } as never;

    // Start activation (don't await)
    const promise = ctrl.activate(ctx, manager, "model");
    expect(ctrl.isActivating).toBe(true);

    ctrl.cancel();
    expect(ctrl.isActivating).toBe(false);
    expect(ctrl.activationMessage).toBe("");

    // The promise should eventually reject
    return expect(promise).rejects.toThrow("cancelled");
  });

  it("notifies on state changes", async () => {
    const ctrl = new ModelActivationController();
    const ctx = {};
    const manager = createMockManager([
      { phase: "download", message: "50%" },
      { phase: "ready", message: "Done" },
    ]);

    const messages: string[] = [];
    ctrl.onUpdate(() => messages.push(ctrl.activationMessage));

    await ctrl.activate(ctx, manager, "model");

    expect(messages).toContain("Activating...");
    expect(messages).toContain("50%");
  });
});
