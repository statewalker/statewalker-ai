import type {
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { LlamaCppLanguageModel } from "../src/llamacpp-language-model.js";

const prompt: LanguageModelV3Prompt = [
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function sessionFactory(behavior: {
  reply?: string;
  chunks?: string[];
  onPrompt?: (args: unknown) => void;
}) {
  return vi.fn(() => {
    return {
      setChatHistory: vi.fn(async () => {}),
      prompt: vi.fn(async (_text: string, opts: Record<string, unknown>) => {
        behavior.onPrompt?.(opts);
        if (behavior.chunks) {
          const cb = opts.onTextChunk as ((c: string) => void) | undefined;
          for (const c of behavior.chunks) cb?.(c);
          return behavior.chunks.join("");
        }
        return behavior.reply ?? "";
      }),
    };
  });
}

describe("LlamaCppLanguageModel.doGenerate", () => {
  it("returns text content and usage from session.prompt", async () => {
    const make = sessionFactory({ reply: "hi there" });
    const model = new LlamaCppLanguageModel("m", make);
    const res = await model.doGenerate({ prompt });
    expect(res.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(res.finishReason.unified).toBe("stop");
    expect(res.usage.outputTokens.total).toBe("hi there".length);
    expect(make).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: "sys" }),
    );
  });

  it("forwards temperature, topP, maxTokens, and signal to session.prompt", async () => {
    let captured: Record<string, unknown> | undefined;
    const make = sessionFactory({
      reply: "",
      onPrompt: (opts) => {
        captured = opts as Record<string, unknown>;
      },
    });
    const model = new LlamaCppLanguageModel("m", make);
    const signal = new AbortController().signal;
    await model.doGenerate({
      prompt,
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 42,
      abortSignal: signal,
    });
    expect(captured).toMatchObject({
      temperature: 0.5,
      topP: 0.9,
      maxTokens: 42,
      signal,
    });
  });
});

describe("LlamaCppLanguageModel.doStream", () => {
  it("emits deltas per onTextChunk call", async () => {
    const make = sessionFactory({ chunks: ["he", "llo"] });
    const model = new LlamaCppLanguageModel("m", make);
    const { stream } = await model.doStream({ prompt });

    const events: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) events.push(value);
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const deltas = events.filter((e) => e.type === "text-delta") as Array<
      Extract<LanguageModelV3StreamPart, { type: "text-delta" }>
    >;
    expect(deltas.map((d) => d.delta).join("")).toBe("hello");
  });
});
