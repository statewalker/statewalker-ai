import type {
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { WebLLMLanguageModel } from "../src/webllm-language-model.js";

function fakeEngine(opts: {
  completion?: unknown;
  streamChunks?: unknown[];
  onInterrupt?: () => void;
}) {
  const create = vi
    .fn()
    .mockImplementation(async (params: { stream?: boolean }) => {
      if (params.stream) {
        const chunks = opts.streamChunks ?? [];
        async function* gen() {
          for (const c of chunks) yield c;
        }
        return gen();
      }
      return opts.completion;
    });
  return {
    chat: { completions: { create } },
    interruptGenerate: opts.onInterrupt ?? vi.fn(),
    create,
  };
}

const prompt: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

describe("WebLLMLanguageModel.doGenerate", () => {
  it("returns text content from a non-streaming completion", async () => {
    const engine = fakeEngine({
      completion: {
        choices: [
          {
            message: { content: "hi there", tool_calls: [] },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    });
    const model = new WebLLMLanguageModel(engine, "test-model");
    const res = await model.doGenerate({ prompt });
    expect(res.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(res.finishReason.unified).toBe("stop");
    expect(res.usage.inputTokens.total).toBe(5);
    expect(res.usage.outputTokens.total).toBe(2);
    expect(engine.create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: false }),
    );
  });

  it("emits tool-call content parts", async () => {
    const engine = fakeEngine({
      completion: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"paris"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    });
    const model = new WebLLMLanguageModel(engine, "test-model");
    const res = await model.doGenerate({ prompt });
    expect(res.finishReason.unified).toBe("tool-calls");
    expect(res.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "get_weather",
      }),
    ]);
  });

  it("forwards AbortSignal to engine.interruptGenerate()", async () => {
    const onInterrupt = vi.fn();
    const engine = fakeEngine({
      completion: {
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
      },
      onInterrupt,
    });
    const model = new WebLLMLanguageModel(engine, "test-model");
    const controller = new AbortController();
    const p = model.doGenerate({ prompt, abortSignal: controller.signal });
    controller.abort();
    await p;
    expect(onInterrupt).toHaveBeenCalled();
  });
});

describe("WebLLMLanguageModel.doStream", () => {
  it("emits stream-start, text-start, deltas, text-end, finish", async () => {
    const engine = fakeEngine({
      streamChunks: [
        { choices: [{ delta: { content: "he" } }] },
        { choices: [{ delta: { content: "llo" } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        },
      ],
    });
    const model = new WebLLMLanguageModel(engine, "test-model");
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
    const finish = events.find((e) => e.type === "finish");
    expect(
      finish && "finishReason" in finish
        ? finish.finishReason.unified
        : undefined,
    ).toBe("stop");
  });

  it("aggregates tool-call deltas into a single tool-call event", async () => {
    const engine = fakeEngine({
      streamChunks: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "f", arguments: '{"a"' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: ":1}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
    });
    const model = new WebLLMLanguageModel(engine, "test-model");
    const { stream } = await model.doStream({ prompt });

    const events: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) events.push(value);
    }
    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "f",
      input: '{"a":1}',
    });
  });
});
