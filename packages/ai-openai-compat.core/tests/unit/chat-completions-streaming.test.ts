import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { mockLanguageModel } from "./_helpers/mock-language-model.js";
import { readSSE } from "./_helpers/sse.js";

const postStream = (body: unknown): Request =>
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const finishUsage = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

const textStream = (
  textChunks: string[],
  finishUnified: "stop" | "length" | "tool-calls" | "content-filter" = "stop",
): LanguageModelV3StreamPart[] => {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    {
      type: "response-metadata",
      id: "stream-rid",
      modelId: "stream-model",
      timestamp: new Date(0),
    },
    { type: "text-start", id: "t1" },
  ];
  for (const c of textChunks) {
    parts.push({ type: "text-delta", id: "t1", delta: c });
  }
  parts.push({ type: "text-end", id: "t1" });
  parts.push({
    type: "finish",
    finishReason: { unified: finishUnified, raw: undefined },
    usage: finishUsage,
  });
  return parts;
};

interface SseChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

describe("POST /v1/chat/completions (streaming)", () => {
  it("emits SSE stream with content deltas, stable id, terminator", async () => {
    const model = mockLanguageModel({
      modelId: "gpt-x",
      streamParts: textStream(["Hel", "lo"]),
    });
    const handler = createOpenAICompat({
      languageModels: { "gpt-x": model },
    });
    const res = await handler(
      postStream({
        model: "gpt-x",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const { chunks, sawDone } = await readSSE(res);
    expect(sawDone).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(3); // 2 text + 1 finish
    // First non-empty content delta
    const contentDeltas = (chunks as SseChunk[])
      .map((c) => c.choices[0]?.delta.content)
      .filter((s): s is string => typeof s === "string");
    expect(contentDeltas.join("")).toBe("Hello");
  });

  it("all chunks share the same id and have integer created timestamps", async () => {
    const model = mockLanguageModel({
      streamParts: textStream(["a", "b", "c"]),
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      postStream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        stream: true,
      }),
    );
    const { chunks } = await readSSE(res);
    expect(chunks.length).toBeGreaterThan(0);
    const ids = new Set((chunks as SseChunk[]).map((c) => c.id));
    expect(ids.size).toBe(1);
    for (const c of chunks as SseChunk[]) {
      expect(c.object).toBe("chat.completion.chunk");
      expect(Number.isInteger(c.created)).toBe(true);
    }
  });

  it("usage and finish_reason appear only on the terminal chunk", async () => {
    const model = mockLanguageModel({
      streamParts: textStream(["a", "b"]),
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      postStream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        stream: true,
      }),
    );
    const { chunks } = await readSSE(res);
    const arr = chunks as SseChunk[];
    const last = arr[arr.length - 1];
    expect(last?.usage).toBeDefined();
    expect(last?.usage?.total_tokens).toBe(8);
    expect(last?.choices[0]?.finish_reason).toBe("stop");
    for (const c of arr.slice(0, -1)) {
      expect(c.usage).toBeUndefined();
      expect(c.choices[0]?.finish_reason).toBeNull();
    }
  });

  it("maps streaming finish reasons correctly", async () => {
    const model = mockLanguageModel({
      streamParts: textStream(["x"], "length"),
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      postStream({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        stream: true,
      }),
    );
    const { chunks } = await readSSE(res);
    const last = (chunks as SseChunk[]).at(-1);
    expect(last?.choices[0]?.finish_reason).toBe("length");
  });
});
