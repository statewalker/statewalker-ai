import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createOpenAICompat } from "../../src/index.js";
import { mockLanguageModel } from "./_helpers/mock-language-model.js";
import { readSSE } from "./_helpers/sse.js";

const post = (body: unknown, opts: { stream?: boolean } = {}): Request =>
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(body as object), stream: opts.stream }),
  });

const baseUsage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

describe("tool calls — request translation", () => {
  it("forwards tools definition (function name, description, parameters)", async () => {
    const model = mockLanguageModel({
      content: [{ type: "text", text: "ok" }],
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      post({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "sum",
              description: "add two ints",
              parameters: {
                type: "object",
                properties: {
                  a: { type: "number" },
                  b: { type: "number" },
                },
                required: ["a", "b"],
              },
            },
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(model.recordedCalls).toHaveLength(1);
    const call = model.recordedCalls[0]!;
    expect(call.tools).toBeDefined();
    const tools = call.tools!;
    expect(tools.length).toBeGreaterThan(0);
    const sumTool = tools.find((t) => t.type === "function" && t.name === "sum");
    expect(sumTool).toBeDefined();
    expect(sumTool?.type).toBe("function");
    if (sumTool?.type === "function") {
      expect(sumTool.description).toBe("add two ints");
      expect(sumTool.inputSchema).toEqual({
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      });
    }
  });

  it("maps tool_choice string ('required') through to AI SDK", async () => {
    const model = mockLanguageModel({
      content: [{ type: "text", text: "ok" }],
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    await handler(
      post({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
        tool_choice: "required",
      }),
    );
    const choice = model.recordedCalls[0]?.toolChoice;
    expect(choice).toEqual({ type: "required" });
  });

  it("maps tool_choice object to {type:'tool', toolName}", async () => {
    const model = mockLanguageModel({
      content: [{ type: "text", text: "ok" }],
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    await handler(
      post({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
        tool_choice: { type: "function", function: { name: "x" } },
      }),
    );
    const choice = model.recordedCalls[0]?.toolChoice;
    expect(choice).toEqual({ type: "tool", toolName: "x" });
  });
});

describe("tool calls — non-streaming response", () => {
  it("returns choices[0].message.tool_calls when model emits tool calls", async () => {
    const model = mockLanguageModel({
      content: [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "sum",
          input: '{"a":1,"b":2}',
        },
      ],
      finishReason: "tool-calls",
    });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      post({
        model: "m",
        messages: [{ role: "user", content: "1+2" }],
        tools: [
          {
            type: "function",
            function: { name: "sum", parameters: { type: "object" } },
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{
        finish_reason: string;
        message: {
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    const tc = body.choices[0]?.message.tool_calls?.[0];
    expect(tc).toBeDefined();
    expect(tc?.id).toBe("tc1");
    expect(tc?.type).toBe("function");
    expect(tc?.function.name).toBe("sum");
    expect(JSON.parse(tc?.function.arguments ?? "")).toEqual({
      a: 1,
      b: 2,
    });
  });
});

describe("tool calls — streaming response", () => {
  const inputUsage = {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };

  it("emits a single chunk for tool-call without deltas", async () => {
    const streamParts: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "r",
        modelId: "m",
        timestamp: new Date(0),
      },
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "sum",
        input: '{"a":1}',
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: inputUsage,
      },
    ];
    const model = mockLanguageModel({ streamParts });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      post(
        {
          model: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [{ type: "function", function: { name: "sum", parameters: {} } }],
        },
        { stream: true },
      ),
    );
    const { chunks } = await readSSE(res);
    interface Chunk {
      choices: Array<{
        delta: {
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason: string | null;
      }>;
    }
    const arr = chunks as Chunk[];
    const tcChunk = arr.find((c) => c.choices[0]?.delta.tool_calls?.length);
    expect(tcChunk).toBeDefined();
    const tc = tcChunk?.choices[0]?.delta.tool_calls?.[0];
    expect(tc).toBeDefined();
    expect(tc?.id).toBe("tc1");
    expect(tc?.index).toBe(0);
    expect(tc?.function?.name).toBe("sum");
    expect(JSON.parse(tc?.function?.arguments ?? "")).toEqual({ a: 1 });
    expect(arr.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("emits arguments delta chunks for tool-input-delta events", async () => {
    const streamParts: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "r",
        modelId: "m",
        timestamp: new Date(0),
      },
      { type: "tool-input-start", id: "p1", toolName: "sum" },
      { type: "tool-input-delta", id: "p1", delta: '{"a":' },
      { type: "tool-input-delta", id: "p1", delta: "1}" },
      { type: "tool-input-end", id: "p1" },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: baseUsage,
      },
    ];
    const model = mockLanguageModel({ streamParts });
    const handler = createOpenAICompat({
      languageModels: { m: model },
    });
    const res = await handler(
      post(
        {
          model: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [{ type: "function", function: { name: "sum", parameters: {} } }],
        },
        { stream: true },
      ),
    );
    const { chunks } = await readSSE(res);
    interface Chunk {
      choices: Array<{
        delta: {
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    }
    const arr = chunks as Chunk[];
    const argChunks = arr
      .map((c) => c.choices[0]?.delta.tool_calls?.[0]?.function?.arguments)
      .filter((s): s is string => typeof s === "string");
    const concatenated = argChunks.join("");
    expect(JSON.parse(concatenated)).toEqual({ a: 1 });
    // First chunk for that tool should carry id + name
    const head = arr.find((c) => c.choices[0]?.delta.tool_calls?.[0]?.function?.name === "sum");
    expect(head).toBeDefined();
    expect(head?.choices[0]?.delta.tool_calls?.[0]?.id).toBe("p1");
  });
});
