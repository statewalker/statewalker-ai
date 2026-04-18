import type { ModelState } from "@statewalker/ai-provider";
import { describe, expect, it } from "vitest";
import { ModelListView } from "./model-list.view.js";

function remoteState(
  provider: "anthropic" | "google" | "openai" | "openai-compatible",
  modelId: string,
  label: string,
  status: ModelState["status"],
  providerInstanceId?: string,
): ModelState {
  return {
    config: {
      runtime: "remote",
      provider,
      modelId,
      label,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    },
    status,
  };
}

function localState(
  modelId: string,
  family: string,
  label: string,
  status: ModelState["status"],
): ModelState {
  return {
    config: {
      runtime: "local",
      engine: "tjs",
      modelId,
      family,
      label,
      dtype: "q4f16",
      size: "1 GB",
      sizeBytes: 1_000_000,
    },
    status,
  };
}

describe("ModelListView", () => {
  it("groups remote models by provider and adds a Local group", () => {
    const states = new Map<string, ModelState>([
      ["anthropic/a", remoteState("anthropic", "a", "Claude A", "ready")],
      [
        "anthropic/b",
        remoteState("anthropic", "b", "Claude B", "not-downloaded"),
      ],
      ["openai/gpt", remoteState("openai", "gpt", "GPT", "not-downloaded")],
      ["local:x", localState("x", "Gemma", "Gemma-2B", "downloaded")],
    ]);

    const view = new ModelListView();
    view.recompute(
      states,
      {
        anthropic: { apiKey: "sk-a" },
        openai: { apiKey: "sk-o" },
        "openai-compatible": {},
        activeModels: { reasoning: [], embedding: [] },
      },
      { reasoning: [], embedding: [] },
    );

    const groupIds = view.groups.map((g) => g.id);
    expect(groupIds).toEqual(["anthropic", "openai", "local"]);

    const anthropicGroup = view.groups.find((g) => g.id === "anthropic");
    expect(anthropicGroup?.configured).toBe(true);
    expect(anthropicGroup?.rows.map((r) => r.key).sort()).toEqual([
      "anthropic/a",
      "anthropic/b",
    ]);
  });

  it("treats each openai-compatible instance as its own group", () => {
    const states = new Map<string, ModelState>([
      [
        "openai-compatible:groq/llama",
        remoteState("openai-compatible", "llama", "Llama 70B", "ready", "groq"),
      ],
      [
        "openai-compatible:lmstudio/qwen",
        remoteState(
          "openai-compatible",
          "qwen",
          "Qwen",
          "not-downloaded",
          "lmstudio",
        ),
      ],
    ]);

    const view = new ModelListView();
    view.recompute(
      states,
      {
        "openai-compatible": {
          groq: {
            apiKey: "gsk",
            baseURL: "https://api.groq.com/openai/v1",
            displayName: "Groq",
          },
          lmstudio: {
            baseURL: "http://localhost:1234/v1",
            displayName: "LM Studio",
          },
        },
        activeModels: { reasoning: [], embedding: [] },
      },
      { reasoning: [], embedding: [] },
    );

    const ids = view.groups.map((g) => g.id);
    expect(ids).toEqual([
      "openai-compatible:groq",
      "openai-compatible:lmstudio",
    ]);
    expect(
      view.groups.find((g) => g.id === "openai-compatible:groq")?.label,
    ).toBe("Groq");
  });

  it("derives hasActiveReasoning from ready models listed in activeModels.reasoning", () => {
    const states = new Map<string, ModelState>([
      ["anthropic/a", remoteState("anthropic", "a", "A", "ready")],
      ["anthropic/b", remoteState("anthropic", "b", "B", "not-downloaded")],
    ]);
    const view = new ModelListView();

    // Key present but not ready → doesn't count.
    view.recompute(
      states,
      { activeModels: { reasoning: ["anthropic/b"], embedding: [] } },
      { reasoning: ["anthropic/b"], embedding: [] },
    );
    expect(view.hasActiveReasoning).toBe(false);
    expect(view.activeReasoningKeys.size).toBe(0);

    // Ready and listed → counts.
    view.recompute(
      states,
      { activeModels: { reasoning: ["anthropic/a"], embedding: [] } },
      { reasoning: ["anthropic/a"], embedding: [] },
    );
    expect(view.hasActiveReasoning).toBe(true);
    expect(view.activeReasoningKeys.has("anthropic/a")).toBe(true);
  });

  it("notifies listeners on recompute", () => {
    const view = new ModelListView();
    let count = 0;
    view.onUpdate(() => count++);

    view.recompute(
      new Map(),
      { activeModels: { reasoning: [], embedding: [] } },
      { reasoning: [], embedding: [] },
    );
    expect(count).toBe(1);
  });
});
