import type { LocalModelConfig, ModelState } from "@statewalker/ai-provider";
import { describe, expect, it } from "vitest";
import { AddLocalModelFormVM } from "../../src/domain/add-local-model.form.js";

function localState(
  family: string,
  label: string,
  status: ModelState["status"] = "not-downloaded",
): ModelState {
  const config: LocalModelConfig = {
    runtime: "local",
    engine: "tjs",
    modelId: `${family}/${label}`,
    family,
    label,
    dtype: "q4f16",
    size: "1 GB",
    sizeBytes: 1_000_000,
  };
  return { config, status };
}

describe("AddLocalModelFormVM", () => {
  it("defaults selectedKey to a Gemma variant when available", () => {
    const states = new Map<string, ModelState>([
      ["local:smol-135m", localState("SmolLM2", "SmolLM2-135M")],
      ["local:gemma-2b-it", localState("Gemma", "gemma-2-2b-it")],
      ["local:qwen-2b", localState("Qwen", "Qwen-2B")],
    ]);

    const vm = AddLocalModelFormVM.fromStates(states);

    expect(vm.selectedKey).toBe("local:gemma-2b-it");
    expect(vm.selectedEntry?.family).toBe("Gemma");
  });

  it("falls back to the first catalog entry when no Gemma is available", () => {
    const states = new Map<string, ModelState>([
      ["local:qwen-2b", localState("Qwen", "Qwen-2B")],
      ["local:llama-1b", localState("Llama", "Llama-1B")],
    ]);
    const vm = AddLocalModelFormVM.fromStates(states);
    // Catalog is sorted by family, so Llama comes before Qwen.
    expect(vm.selectedEntry?.family).toBe("Llama");
  });

  it("canDownload is false for already-downloaded entries", () => {
    const states = new Map<string, ModelState>([
      ["local:gemma-2b-it", localState("Gemma", "gemma-2-2b-it", "downloaded")],
    ]);
    const vm = AddLocalModelFormVM.fromStates(states);
    expect(vm.canDownload).toBe(false);
  });

  it("applyProgress mirrors ActivationProgress fields and notifies", () => {
    const states = new Map<string, ModelState>([["local:gemma", localState("Gemma", "Gemma-2B")]]);
    const vm = AddLocalModelFormVM.fromStates(states);

    let count = 0;
    vm.onUpdate(() => count++);

    vm.beginDownload();
    vm.applyProgress({
      modelKey: "local:gemma",
      phase: "downloading",
      progress: 0.42,
      message: "Downloading shard 2/5",
    });
    expect(vm.downloadPhase).toBe("downloading");
    expect(vm.progress).toBeCloseTo(0.42);
    expect(vm.message).toBe("Downloading shard 2/5");

    vm.completeDownload();
    expect(vm.downloadPhase).toBe("downloaded");
    expect(vm.progress).toBe(1);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("failDownload records an error message", () => {
    const states = new Map<string, ModelState>([["local:gemma", localState("Gemma", "Gemma-2B")]]);
    const vm = AddLocalModelFormVM.fromStates(states);
    vm.beginDownload();
    vm.failDownload("network error");
    expect(vm.downloadPhase).toBe("error");
    expect(vm.errorMessage).toBe("network error");
  });

  it("switching selectedKey resets download phase", () => {
    const states = new Map<string, ModelState>([
      ["local:gemma", localState("Gemma", "Gemma-2B")],
      ["local:qwen", localState("Qwen", "Qwen-2B")],
    ]);
    const vm = AddLocalModelFormVM.fromStates(states);
    vm.beginDownload();
    vm.applyProgress({
      modelKey: "local:gemma",
      phase: "downloading",
      progress: 0.3,
      message: "mid-way",
    });
    vm.setSelectedKey("local:qwen");
    expect(vm.downloadPhase).toBe("idle");
    expect(vm.progress).toBe(0);
    expect(vm.message).toBe("");
  });
});
