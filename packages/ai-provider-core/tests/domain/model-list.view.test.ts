import type { EngineId, ModelState } from "@statewalker/ai-provider";
import { describe, expect, it } from "vitest";
import { ModelListView } from "../../src/core/model-list.view.js";

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
  engine: EngineId = "tjs",
): ModelState {
  return {
    config: {
      runtime: "local",
      engine,
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
      ["anthropic/b", remoteState("anthropic", "b", "Claude B", "not-downloaded")],
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
    expect(anthropicGroup?.rows.map((r) => r.key).sort()).toEqual(["anthropic/a", "anthropic/b"]);
  });

  it("treats each openai-compatible instance as its own group", () => {
    const states = new Map<string, ModelState>([
      [
        "openai-compatible:groq/llama",
        remoteState("openai-compatible", "llama", "Llama 70B", "ready", "groq"),
      ],
      [
        "openai-compatible:lmstudio/qwen",
        remoteState("openai-compatible", "qwen", "Qwen", "not-downloaded", "lmstudio"),
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
    expect(ids).toEqual(["openai-compatible:groq", "openai-compatible:lmstudio"]);
    expect(view.groups.find((g) => g.id === "openai-compatible:groq")?.label).toBe("Groq");
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

  it("maps engine to engineBadge and leaves remote rows without a badge", () => {
    const states = new Map<string, ModelState>([
      ["anthropic/a", remoteState("anthropic", "a", "Claude A", "ready")],
      ["local:tjs", localState("t", "TJS", "TJS-M", "downloaded", "tjs")],
      ["local:web", localState("w", "WLM", "WLM-M", "downloaded", "webllm")],
      ["local:llama", localState("l", "LCPP", "LCPP-M", "downloaded", "llamacpp")],
    ]);

    const view = new ModelListView();
    view.recompute(
      states,
      {
        anthropic: { apiKey: "sk-a" },
        activeModels: { reasoning: [], embedding: [] },
      },
      { reasoning: [], embedding: [] },
    );

    const rowsByKey = new Map(view.groups.flatMap((g) => g.rows).map((r) => [r.key, r]));
    expect(rowsByKey.get("anthropic/a")?.engine).toBeUndefined();
    expect(rowsByKey.get("anthropic/a")?.engineBadge).toBeUndefined();
    expect(rowsByKey.get("local:tjs")?.engineBadge).toBe("WASM");
    expect(rowsByKey.get("local:web")?.engineBadge).toBe("WebGPU");
    expect(rowsByKey.get("local:llama")?.engineBadge).toBe("Native");
  });

  it("marks rows unavailable when their engine isn't available", () => {
    const states = new Map<string, ModelState>([
      ["remote", remoteState("anthropic", "x", "X", "ready")],
      ["tjs", localState("t", "TJS", "TJS-M", "downloaded", "tjs")],
      ["web", localState("w", "WLM", "WLM-M", "downloaded", "webllm")],
      ["llama", localState("l", "LCPP", "LCPP-M", "downloaded", "llamacpp")],
    ]);

    const view = new ModelListView();
    view.recompute(
      states,
      {
        anthropic: { apiKey: "sk" },
        activeModels: { reasoning: [], embedding: [] },
      },
      { reasoning: [], embedding: [] },
      { tjs: true, webllm: false, llamacpp: true },
    );

    const rowsByKey = new Map(view.groups.flatMap((g) => g.rows).map((r) => [r.key, r]));
    expect(rowsByKey.get("remote")?.available).toBe(true);
    expect(rowsByKey.get("tjs")?.available).toBe(true);
    expect(rowsByKey.get("web")?.available).toBe(false);
    expect(rowsByKey.get("llama")?.available).toBe(true);
  });
});
