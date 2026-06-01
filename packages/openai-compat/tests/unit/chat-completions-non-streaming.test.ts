import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { type MockFinishReason, mockLanguageModel } from "./_helpers/mock-language-model.js";

const post = (body: unknown): Request =>
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string; refusal?: string | null };
    finish_reason: string | null;
    logprobs: null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

describe("POST /v1/chat/completions (non-streaming)", () => {
  it("returns a ChatCompletion shape with text, finish_reason, usage", async () => {
    const model = mockLanguageModel({
      modelId: "gpt-x",
      content: [{ type: "text", text: "Hi" }],
      finishReason: "stop",
      usage: {
        inputTokens: {
          total: 5,
          noCache: 5,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
    });
    const handler = createOpenAICompat({
      languageModels: { "gpt-x": model },
    });
    const res = await handler(
      post({
        model: "gpt-x",
        messages: [{ role: "user", content: "Hello" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as ChatCompletion;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-x");
    expect(Number.isInteger(body.created)).toBe(true);
    expect(typeof body.id).toBe("string");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.index).toBe(0);
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toBe("Hi");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.logprobs).toBeNull();
    expect(body.usage).toBeDefined();
    expect(body.usage?.prompt_tokens).toBe(5);
    expect(body.usage?.completion_tokens).toBe(1);
    expect(body.usage?.total_tokens).toBe(6);
  });

  const finishReasonCases: Array<[MockFinishReason, string]> = [
    ["stop", "stop"],
    ["length", "length"],
    ["content-filter", "content_filter"],
    ["tool-calls", "tool_calls"],
    ["error", "stop"],
    ["other", "stop"],
  ];
  for (const [sdk, openai] of finishReasonCases) {
    it(`maps finish reason ${sdk} → ${openai}`, async () => {
      const model = mockLanguageModel({
        content: [{ type: "text", text: "ok" }],
        finishReason: sdk,
      });
      const handler = createOpenAICompat({
        languageModels: { m: model },
      });
      const res = await handler(post({ model: "m", messages: [{ role: "user", content: "Hi" }] }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChatCompletion;
      expect(body.choices[0]?.finish_reason).toBe(openai);
    });
  }

  it("forwards the user message to the underlying model", async () => {
    const model = mockLanguageModel({
      content: [{ type: "text", text: "ack" }],
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    await handler(
      post({
        model: "m",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "Hello there" },
        ],
      }),
    );
    expect(model.recordedCalls).toHaveLength(1);
    const prompt = model.recordedCalls[0]?.prompt;
    expect(prompt).toBeDefined();
    const roles = prompt?.map((m) => m.role);
    expect(roles).toContain("user");
    const userMsg = prompt?.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const content = userMsg?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const textParts = content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(textParts).toBe("Hello there");
    }
  });

  it("404s on unknown model", async () => {
    const handler = createOpenAICompat({
      languageModels: { known: mockLanguageModel() },
    });
    const res = await handler(
      post({ model: "unknown", messages: [{ role: "user", content: "x" }] }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; param?: string };
    };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.param).toBe("model");
  });
});
