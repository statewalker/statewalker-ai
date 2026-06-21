import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { mockLanguageModel } from "./_helpers/mock-language-model.js";
import { readSSE } from "./_helpers/sse.js";

const post = (body: unknown): Request =>
  new Request("http://x/v1/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface Completion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: string;
    logprobs: null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

describe("POST /v1/completions (legacy)", () => {
  it("single-string prompt returns one choice with text_completion object", async () => {
    const model = mockLanguageModel({
      content: [{ type: "text", text: "World" }],
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(post({ model: "m", prompt: "Hello" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Completion;
    expect(body.object).toBe("text_completion");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.index).toBe(0);
    expect(body.choices[0]?.text).toBe("World");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.logprobs).toBeNull();

    // Verify the backend message was a single user message with 'Hello'.
    expect(model.recordedCalls).toHaveLength(1);
    const userMsg = model.recordedCalls[0]?.prompt.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg?.content;
    expect(Array.isArray(content)).toBe(true);
    const textJoin = (content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(textJoin).toBe("Hello");
  });

  it("string-array prompt issues one call per prompt with per-prompt choices", async () => {
    let call = 0;
    const model = mockLanguageModel({
      content: [{ type: "text", text: "stub" }],
      onCall: () => {
        call++;
      },
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(post({ model: "m", prompt: ["A", "B"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Completion;
    expect(body.choices).toHaveLength(2);
    expect(body.choices[0]?.index).toBe(0);
    expect(body.choices[1]?.index).toBe(1);
    expect(call).toBe(2);
  });

  it("streaming with string prompt emits text_completion SSE", async () => {
    const streamParts: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "r",
        modelId: "m",
        timestamp: new Date(0),
      },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hel" },
      { type: "text-delta", id: "t", delta: "lo" },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 2, text: 2, reasoning: undefined },
        },
      },
    ];
    const model = mockLanguageModel({ streamParts });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(post({ model: "m", prompt: "Hi", stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const { chunks, sawDone } = await readSSE(res);
    expect(sawDone).toBe(true);
    interface Chunk {
      object: string;
      choices: Array<{ text: string; finish_reason: string | null }>;
    }
    const arr = chunks as Chunk[];
    expect(arr.every((c) => c.object === "text_completion")).toBe(true);
    const texts = arr
      .map((c) => c.choices[0]?.text)
      .filter((s): s is string => typeof s === "string");
    expect(texts.join("")).toBe("Hello");
    const last = arr.at(-1);
    expect(last?.choices[0]?.finish_reason).toBe("stop");
  });

  it("streaming with array prompt is rejected", async () => {
    const handler = createOpenAICompat({
      languageModels: { m: mockLanguageModel() },
    });
    const res = await handler(post({ model: "m", prompt: ["A", "B"], stream: true }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request_error");
  });

  it("n > 1 is rejected", async () => {
    const handler = createOpenAICompat({
      languageModels: { m: mockLanguageModel() },
    });
    const res = await handler(post({ model: "m", prompt: "x", n: 2 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request_error");
  });

  it("404s on unknown model", async () => {
    const handler = createOpenAICompat({
      languageModels: { m: mockLanguageModel() },
    });
    const res = await handler(post({ model: "unknown", prompt: "x" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });
});
