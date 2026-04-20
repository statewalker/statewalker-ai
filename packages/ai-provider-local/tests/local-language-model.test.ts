import { describe, expect, it, vi } from "vitest";
import { LocalLanguageModel } from "../src/local-language-model.js";

function createMockPipeline(response = "Hello back!") {
  const tokenizer = {
    apply_chat_template: vi.fn(
      (_messages: unknown[], _opts: unknown) => "formatted prompt",
    ),
  };

  const pipeline = Object.assign(
    vi.fn(async () => [{ generated_text: response }]),
    { tokenizer },
  );

  return pipeline;
}

function createMockTjs() {
  return {
    TextStreamer: vi.fn().mockImplementation((_tokenizer, opts) => {
      // Store callback for later invocation in pipeline mock
      return { _callback: opts.callback_function };
    }),
  };
}

describe("LocalLanguageModel", () => {
  describe("properties", () => {
    it("has correct specificationVersion, provider, modelId", () => {
      const model = new LocalLanguageModel(
        "test/model",
        createMockPipeline(),
        createMockTjs(),
      );
      expect(model.specificationVersion).toBe("v3");
      expect(model.provider).toBe("local");
      expect(model.modelId).toBe("test/model");
      expect(model.supportedUrls).toEqual({});
    });
  });

  describe("doGenerate", () => {
    it("returns text content, finishReason, and usage", async () => {
      const pipeline = createMockPipeline("Generated text");
      const model = new LocalLanguageModel(
        "test/model",
        pipeline,
        createMockTjs(),
      );

      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        mode: { type: "regular" },
      } as never);

      expect(result.content).toEqual([
        { type: "text", text: "Generated text" },
      ]);
      expect(result.finishReason.unified).toBe("stop");
      expect(result.usage.inputTokens.total).toBeGreaterThan(0);
      expect(result.usage.outputTokens.total).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
    });

    it("applies chat template via tokenizer", async () => {
      const pipeline = createMockPipeline();
      const model = new LocalLanguageModel(
        "test/model",
        pipeline,
        createMockTjs(),
      );

      await model.doGenerate({
        prompt: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: [{ type: "text", text: "Hi" }] },
        ],
        mode: { type: "regular" },
      } as never);

      expect(pipeline.tokenizer.apply_chat_template).toHaveBeenCalledWith(
        [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hi" },
        ],
        { tokenize: false, add_generation_prompt: true },
      );
    });
  });

  describe("doStream", () => {
    it("produces a readable stream with text-start, text-delta, text-end, finish", async () => {
      const tjs = {
        TextStreamer: vi.fn().mockImplementation((_tokenizer, opts) => {
          return { _callback: opts.callback_function };
        }),
      };

      const tokenizer = {
        apply_chat_template: vi.fn(() => "prompt"),
      };

      // Pipeline that invokes streamer callbacks
      const pipeline = Object.assign(
        vi.fn(
          async (
            _prompt: string,
            opts: { streamer: { _callback: (t: string) => void } },
          ) => {
            const streamer = opts.streamer;
            streamer._callback("Hello");
            streamer._callback(" world");
            return [{ generated_text: "Hello world" }];
          },
        ),
        { tokenizer },
      );

      const model = new LocalLanguageModel("test/model", pipeline, tjs);
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        mode: { type: "regular" },
      } as never);

      const reader = result.stream.getReader();
      const parts: Array<{ type: string }> = [];

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }

      const types = parts.map((p) => p.type);
      expect(types).toContain("stream-start");
      expect(types).toContain("text-start");
      expect(types).toContain("text-delta");
      expect(types).toContain("text-end");
      expect(types).toContain("finish");

      const finishPart = parts.find((p) => p.type === "finish") as {
        type: string;
        finishReason: { unified: string };
      };
      expect(finishPart.finishReason.unified).toBe("stop");
    });
  });
});
