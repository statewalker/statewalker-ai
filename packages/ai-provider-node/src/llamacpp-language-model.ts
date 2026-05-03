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

// biome-ignore lint/suspicious/noExplicitAny: node-llama-cpp session type varies across versions
type LlamaChatSession = any;

function unified(reason: LanguageModelV3FinishReason["unified"]): LanguageModelV3FinishReason {
  return { unified: reason, raw: undefined };
}

function usage(inputChars: number, outputChars: number): LanguageModelV3Usage {
  // node-llama-cpp doesn't expose token counts in the v3 API without an
  // extra `session.getContext()` call; approximate with character counts
  // so the AI SDK always has a non-null usage block.
  return {
    inputTokens: {
      total: inputChars,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputChars,
      text: outputChars,
      reasoning: undefined,
    },
  };
}

/**
 * LanguageModelV3 implementation over a `node-llama-cpp` `LlamaChatSession`.
 * Creates a fresh session per `doGenerate` / `doStream` call so concurrent
 * requests don't corrupt each other's KV cache.
 */
export class LlamaCppLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "llamacpp";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    modelId: string,
    private readonly makeSession: (opts: { systemPrompt: string }) => LlamaChatSession,
    private readonly onDispose?: () => void | Promise<void>,
  ) {
    this.modelId = modelId;
  }

  /** Invoked by `ModelManager.deactivate(key)` to release the LlamaContext
   * and LlamaModel that this instance wraps. Safe to call multiple times. */
  async [Symbol.asyncDispose](): Promise<void> {
    const fn = this.onDispose;
    if (fn) await fn();
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { systemPrompt, history, lastUserText } = convertPrompt(options.prompt);
    const session = this.makeSession({ systemPrompt });
    if (history.length > 0 && session.setChatHistory) {
      await session.setChatHistory(history);
    }

    const promptOpts: Record<string, unknown> = {};
    if (options.temperature != null) promptOpts.temperature = options.temperature;
    if (options.topP != null) promptOpts.topP = options.topP;
    if (options.maxOutputTokens != null) promptOpts.maxTokens = options.maxOutputTokens;
    if (options.abortSignal) promptOpts.signal = options.abortSignal;

    const text: string = await session.prompt(lastUserText, promptOpts);
    return {
      content: [{ type: "text", text }],
      finishReason: unified("stop"),
      usage: usage(lastUserText.length, text.length),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const { systemPrompt, history, lastUserText } = convertPrompt(options.prompt);
    const session = this.makeSession({ systemPrompt });
    if (history.length > 0 && session.setChatHistory) {
      await session.setChatHistory(history);
    }

    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>();
    const writer = writable.getWriter();
    const textId = "text-0";

    (async () => {
      let outputChars = 0;
      try {
        await writer.write({ type: "stream-start", warnings: [] });
        await writer.write({ type: "text-start", id: textId });

        const promptOpts: Record<string, unknown> = {
          onTextChunk: (chunk: string) => {
            outputChars += chunk.length;
            void writer.write({ type: "text-delta", id: textId, delta: chunk });
          },
        };
        if (options.temperature != null) promptOpts.temperature = options.temperature;
        if (options.topP != null) promptOpts.topP = options.topP;
        if (options.maxOutputTokens != null) promptOpts.maxTokens = options.maxOutputTokens;
        if (options.abortSignal) promptOpts.signal = options.abortSignal;

        await session.prompt(lastUserText, promptOpts);

        await writer.write({ type: "text-end", id: textId });
        await writer.write({
          type: "finish",
          finishReason: options.abortSignal?.aborted ? unified("other") : unified("stop"),
          usage: usage(lastUserText.length, outputChars),
        });
      } catch (e) {
        if (options.abortSignal?.aborted) {
          await writer.write({ type: "text-end", id: textId });
          await writer.write({
            type: "finish",
            finishReason: unified("other"),
            usage: usage(lastUserText.length, outputChars),
          });
        } else {
          await writer.write({ type: "error", error: e });
        }
      } finally {
        await writer.close();
      }
    })();

    return { stream: readable };
  }
}
