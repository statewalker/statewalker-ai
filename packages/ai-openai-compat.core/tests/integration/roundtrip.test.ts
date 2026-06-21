import { createOpenAI } from "@ai-sdk/openai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { createMockOpenAIFetch } from "./_helpers/mock-openai-fetch.js";

const buildClient = (handler: (req: Request) => Promise<Response>) => {
  // OpenAI's `fetch` is typed against the standard Web Fetch signature.
  return new OpenAI({
    apiKey: "test",
    baseURL: "http://compat.local/v1",
    fetch: ((input: Request | string | URL, init?: RequestInit) => {
      const req =
        input instanceof Request
          ? new Request(input.url, {
              method: input.method,
              headers: input.headers,
              body: input.body,
            })
          : new Request(input as string | URL, init);
      return handler(req);
    }) as unknown as typeof fetch,
  });
};

describe("integration: openai client → handler → @ai-sdk/openai → mock backend", () => {
  it("non-streaming chat completion round-trip preserves content", async () => {
    const mockFetch = createMockOpenAIFetch({
      chat: {
        "gpt-4o-mini": {
          content: "roundtrip-ok",
          prompt_tokens: 12,
          completion_tokens: 7,
        },
      },
    });
    const provider = createOpenAI({
      apiKey: "any",
      baseURL: "http://mock-openai.local/v1",
      fetch: mockFetch,
    });
    const handler = createOpenAICompat({
      languageModels: { "gpt-4o-mini": provider.chat("gpt-4o-mini") },
    });
    const client = buildClient(handler);
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(response.choices[0]?.message.content).toBe("roundtrip-ok");
    expect(response.usage?.prompt_tokens).toBe(12);
    expect(response.usage?.completion_tokens).toBe(7);
  });

  it("streaming chat completion round-trip preserves deltas", async () => {
    const mockFetch = createMockOpenAIFetch({
      stream: {
        "gpt-4o-mini": [
          { delta: "ro" },
          { delta: "und" },
          { delta: "trip" },
          { finish_reason: "stop" },
        ],
      },
    });
    const provider = createOpenAI({
      apiKey: "any",
      baseURL: "http://mock-openai.local/v1",
      fetch: mockFetch,
    });
    const handler = createOpenAICompat({
      languageModels: { "gpt-4o-mini": provider.chat("gpt-4o-mini") },
    });
    const client = buildClient(handler);
    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (typeof delta === "string") text += delta;
    }
    expect(text).toBe("roundtrip");
  });

  it("tool-call round-trip preserves function name and arguments", async () => {
    const mockFetch = createMockOpenAIFetch({
      chat: {
        "gpt-4o-mini": {
          content: "",
          finish_reason: "tool_calls",
          tool_calls: [
            {
              id: "call_1",
              function: { name: "sum", arguments: '{"a":1,"b":2}' },
            },
          ],
        },
      },
    });
    const provider = createOpenAI({
      apiKey: "any",
      baseURL: "http://mock-openai.local/v1",
      fetch: mockFetch,
    });
    const handler = createOpenAICompat({
      languageModels: { "gpt-4o-mini": provider.chat("gpt-4o-mini") },
    });
    const client = buildClient(handler);
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "1+2" }],
      tools: [
        {
          type: "function",
          function: {
            name: "sum",
            parameters: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
            },
          },
        },
      ],
    });
    const tc = response.choices[0]?.message.tool_calls?.[0];
    expect(tc).toBeDefined();
    if (tc && tc.type === "function") {
      expect(tc.function.name).toBe("sum");
      expect(JSON.parse(tc.function.arguments)).toEqual({ a: 1, b: 2 });
    }
  });
});
