import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { MLCEngine } from "./loader.js";
import { convertPrompt, type WebLLMMessage } from "./prompt-converter.js";

// biome-ignore lint/suspicious/noExplicitAny: WebLLM completion shape varies by version
type ChatCompletion = any;
// biome-ignore lint/suspicious/noExplicitAny: WebLLM streaming chunk shape varies
type ChatCompletionChunk = any;

function unified(reason: LanguageModelV3FinishReason["unified"]): LanguageModelV3FinishReason {
  return { unified: reason, raw: undefined };
}

function usage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens ?? 0,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens ?? 0,
      text: outputTokens ?? 0,
      reasoning: undefined,
    },
  };
}

function mapOpenAIFinishReason(raw: string | null | undefined): LanguageModelV3FinishReason {
  switch (raw) {
    case "stop":
      return unified("stop");
    case "length":
      return unified("length");
    case "tool_calls":
      return unified("tool-calls");
    case "content_filter":
      return unified("content-filter");
    default:
      return unified("stop");
  }
}

interface WebLLMCallParams {
  messages: WebLLMMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

function buildParams(
  messages: WebLLMMessage[],
  options: LanguageModelV3CallOptions,
): WebLLMCallParams {
  const params: WebLLMCallParams = { messages };
  if (options.temperature != null) params.temperature = options.temperature;
  if (options.topP != null) params.top_p = options.topP;
  if (options.maxOutputTokens != null) params.max_tokens = options.maxOutputTokens;
  if (options.seed != null) params.seed = options.seed;
  if (options.frequencyPenalty != null) params.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty != null) params.presence_penalty = options.presencePenalty;
  if (options.stopSequences != null && options.stopSequences.length > 0)
    params.stop = options.stopSequences;

  // Tools
  if (options.tools != null && options.tools.length > 0) {
    params.tools = options.tools.map((t) => {
      if (t.type === "function") {
        return {
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        };
      }
      return t;
    });
    if (options.toolChoice) {
      if (options.toolChoice.type === "auto") params.tool_choice = "auto";
      else if (options.toolChoice.type === "none") params.tool_choice = "none";
      else if (options.toolChoice.type === "required") params.tool_choice = "required";
      else if (options.toolChoice.type === "tool")
        params.tool_choice = {
          type: "function",
          function: { name: options.toolChoice.toolName },
        };
    }
  }

  // Structured output (JSON mode / schema). WebLLM's
  // `GrammarCompiler.CompileJSONSchema` is a C++ embind binding that
  // expects `std::string` — passing the raw JS schema object throws
  // `BindingError: Cannot pass non-string to std::string`. Always
  // serialize before handing it across.
  if (options.responseFormat?.type === "json") {
    if (options.responseFormat.schema) {
      const schema = options.responseFormat.schema;
      params.response_format = {
        type: "json_object",
        schema: typeof schema === "string" ? schema : JSON.stringify(schema),
      };
    } else {
      params.response_format = { type: "json_object" };
    }
  }

  return params;
}

/**
 * LanguageModelV3 implementation wrapping a WebLLM MLCEngine. Uses the
 * OpenAI-shaped `engine.chat.completions.create(...)` surface for both
 * non-streaming and streaming paths, and forwards AbortSignal through
 * `engine.interruptGenerate()`.
 */
export class WebLLMLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "webllm";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    private readonly engine: MLCEngine,
    modelId: string,
  ) {
    this.modelId = modelId;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const messages = convertPrompt(options.prompt);
    const params = buildParams(messages, options);

    const onAbort = () => this.engine.interruptGenerate();
    options.abortSignal?.addEventListener("abort", onAbort);

    try {
      const completion: ChatCompletion = await this.engine.chat.completions.create({
        ...params,
        stream: false,
      });
      const choice = completion.choices?.[0];
      const message = choice?.message;
      const content: LanguageModelV3GenerateResult["content"] = [];
      if (typeof message?.content === "string" && message.content.length > 0) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message?.tool_calls ?? []) {
        if (call.type !== "function") continue;
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function?.name ?? "",
          input: call.function?.arguments ?? "",
        });
      }
      return {
        content,
        finishReason: mapOpenAIFinishReason(choice?.finish_reason),
        usage: usage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens),
        warnings: [],
      };
    } finally {
      options.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const messages = convertPrompt(options.prompt);
    const params = buildParams(messages, options);
    const engine = this.engine;

    const { readable, writable } = new TransformStream<LanguageModelV3StreamPart>();
    const writer = writable.getWriter();
    const textId = "text-0";

    const onAbort = () => engine.interruptGenerate();
    options.abortSignal?.addEventListener("abort", onAbort);

    (async () => {
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let finishReason: LanguageModelV3FinishReason = unified("stop");
      let textOpen = false;
      const emittedToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>();

      try {
        await writer.write({ type: "stream-start", warnings: [] });
        const stream: AsyncIterable<ChatCompletionChunk> = await engine.chat.completions.create({
          ...params,
          stream: true,
          stream_options: { include_usage: true },
        });
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            if (!textOpen) {
              await writer.write({ type: "text-start", id: textId });
              textOpen = true;
            }
            await writer.write({
              type: "text-delta",
              id: textId,
              delta: delta.content,
            });
          }
          // Tool-call deltas
          for (const call of delta?.tool_calls ?? []) {
            const idx = call.index ?? 0;
            let entry = emittedToolCalls.get(idx);
            if (!entry) {
              entry = {
                id: call.id ?? `call_${idx}`,
                name: call.function?.name ?? "",
                argsBuffer: "",
              };
              emittedToolCalls.set(idx, entry);
            }
            if (call.function?.name) entry.name = call.function.name;
            if (call.function?.arguments) {
              entry.argsBuffer += call.function.arguments;
            }
          }
          if (choice?.finish_reason) {
            finishReason = mapOpenAIFinishReason(choice.finish_reason);
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }

        if (textOpen) {
          await writer.write({ type: "text-end", id: textId });
        }
        for (const entry of emittedToolCalls.values()) {
          await writer.write({
            type: "tool-call",
            toolCallId: entry.id,
            toolName: entry.name,
            input: entry.argsBuffer,
          });
        }
        await writer.write({
          type: "finish",
          finishReason,
          usage: usage(promptTokens, completionTokens),
        });
      } catch (e) {
        if (options.abortSignal?.aborted) {
          if (textOpen) await writer.write({ type: "text-end", id: textId });
          await writer.write({
            type: "finish",
            finishReason: unified("other"),
            usage: usage(promptTokens, completionTokens),
          });
        } else {
          await writer.write({ type: "error", error: e });
        }
      } finally {
        options.abortSignal?.removeEventListener("abort", onAbort);
        await writer.close();
      }
    })();

    return { stream: readable };
  }
}
