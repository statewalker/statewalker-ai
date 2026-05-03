import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { convertPrompt } from "./prompt-converter.js";

// biome-ignore lint/suspicious/noExplicitAny: transformers.js pipeline types
type TjsPipeline = any;
// biome-ignore lint/suspicious/noExplicitAny: transformers.js module types
type TjsModule = any;

const DEFAULT_MAX_NEW_TOKENS = 512;

function makeFinishReason(
  unified: LanguageModelV3FinishReason["unified"],
): LanguageModelV3FinishReason {
  return { unified, raw: undefined };
}

function makeUsage(inputTokens: number, outputTokens: number): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

/**
 * LanguageModelV3 implementation wrapping a transformers.js text-generation pipeline.
 */
export class LocalLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "local";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    modelId: string,
    private readonly pipeline: TjsPipeline,
    private readonly tjs: TjsModule,
    private readonly maxNewTokens = DEFAULT_MAX_NEW_TOKENS,
  ) {
    this.modelId = modelId;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const messages = convertPrompt(options.prompt);
    const prompt: string = this.pipeline.tokenizer.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
    });

    const output = await this.pipeline(prompt, {
      max_new_tokens: this.maxNewTokens,
      return_full_text: false,
      do_sample: false,
    });

    const text: string = output[0]?.generated_text ?? "";

    return {
      content: [{ type: "text", text }],
      finishReason: makeFinishReason("stop"),
      usage: makeUsage(prompt.length, text.length),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const messages = convertPrompt(options.prompt);
    const prompt: string = this.pipeline.tokenizer.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
    });

    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>();
    const writer = writable.getWriter();
    const signal = options.abortSignal;
    const tjs = this.tjs;
    const pipeline = this.pipeline;
    const maxNewTokens = this.maxNewTokens;
    const textId = "text-0";

    (async () => {
      const chunks: string[] = [];
      let notify: (() => void) | null = null;
      let done = false;
      let fullText = "";

      const streamer = new tjs.TextStreamer(pipeline.tokenizer, {
        skip_prompt: true,
        callback_function: (text: string) => {
          chunks.push(text);
          if (notify) {
            const f = notify;
            notify = null;
            f();
          }
        },
      });

      const inferPromise = pipeline(prompt, {
        max_new_tokens: maxNewTokens,
        return_full_text: false,
        do_sample: false,
        streamer,
      }).then(() => {
        done = true;
        if (notify) {
          const f = notify;
          notify = null;
          f();
        }
      });

      try {
        await writer.write({ type: "stream-start", warnings: [] });
        await writer.write({ type: "text-start", id: textId });

        while (true) {
          if (signal?.aborted) {
            await writer.write({ type: "text-end", id: textId });
            await writer.write({
              type: "finish",
              finishReason: makeFinishReason("other"),
              usage: makeUsage(prompt.length, fullText.length),
            });
            break;
          }
          if (chunks.length > 0) {
            const delta = chunks.shift() ?? "";
            fullText += delta;
            await writer.write({ type: "text-delta", id: textId, delta });
          } else if (done) {
            await writer.write({ type: "text-end", id: textId });
            await writer.write({
              type: "finish",
              finishReason: makeFinishReason("stop"),
              usage: makeUsage(prompt.length, fullText.length),
            });
            break;
          } else {
            await new Promise<void>((r) => {
              notify = r;
            });
          }
        }
        await inferPromise;
      } catch (e) {
        await writer.write({ type: "error", error: e });
      } finally {
        await writer.close();
      }
    })();

    return { stream: readable };
  }
}
