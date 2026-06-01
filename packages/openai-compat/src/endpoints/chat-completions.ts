import { generateText, streamText } from "ai";
import { errorResponse } from "../errors.js";
import type { Init } from "../index.js";
import type {
  OpenAIAssistantToolCall,
  OpenAIChatCompletion,
  OpenAIChatCompletionRequest,
} from "../openai-types.js";
import { toOpenAIFinishReason } from "../translate/finish-reason.js";
import { MessageTranslationError, translateMessages } from "../translate/messages.js";
import { type ChatStreamContext, ChatStreamEmitter } from "../translate/stream-chunks.js";
import { translateToolChoice, translateTools } from "../translate/tools.js";
import { toOpenAIUsage } from "../translate/usage.js";
import { modelNotFound, parseJsonBody, requireModelField, upstreamError } from "../util.js";

export const handleChatCompletions = async (req: Request, init: Init): Promise<Response> => {
  const parsed = await parseJsonBody<OpenAIChatCompletionRequest>(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  const modelErr = requireModelField(body);
  if (modelErr) return modelErr;
  if (body.n !== undefined && body.n !== 1) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "`n > 1` is not supported",
      "n",
    );
  }
  const model = init.languageModels?.[body.model];
  if (!model) return modelNotFound(body.model);
  let messages: ReturnType<typeof translateMessages>;
  let tools: ReturnType<typeof translateTools>;
  let toolChoice: ReturnType<typeof translateToolChoice>;
  try {
    messages = translateMessages(body.messages);
    tools = translateTools(body.tools);
    toolChoice = translateToolChoice(body.tool_choice);
  } catch (e) {
    if (e instanceof MessageTranslationError) {
      return errorResponse(
        400,
        "invalid_request_error",
        "invalid_request_error",
        e.message,
        e.param,
      );
    }
    throw e;
  }

  const callOptions = {
    model,
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(body.frequency_penalty !== undefined ? { frequencyPenalty: body.frequency_penalty } : {}),
    ...(body.presence_penalty !== undefined ? { presencePenalty: body.presence_penalty } : {}),
    ...(body.seed !== undefined ? { seed: body.seed } : {}),
    ...(body.stop !== undefined
      ? {
          stopSequences: typeof body.stop === "string" ? [body.stop] : body.stop,
        }
      : {}),
    ...(body.max_completion_tokens !== undefined
      ? { maxOutputTokens: body.max_completion_tokens }
      : body.max_tokens !== undefined
        ? { maxOutputTokens: body.max_tokens }
        : {}),
    ...(req.signal ? { abortSignal: req.signal } : {}),
  };

  if (body.stream) {
    const ctx: ChatStreamContext = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    const emitter = new ChatStreamEmitter(ctx);
    const stream = streamText(callOptions);
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (chunk: unknown): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };
        try {
          for await (const part of stream.fullStream) {
            for (const c of emitter.handle(part)) write(c);
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          write({
            error: {
              message,
              type: "server_error",
              code: "upstream_error",
            },
          });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(sseBody, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  try {
    const result = await generateText(callOptions);
    const toolCalls: OpenAIAssistantToolCall[] = result.toolCalls.map((c) => ({
      id: c.toolCallId,
      type: "function",
      function: {
        name: c.toolName,
        arguments: JSON.stringify(c.input ?? {}),
      },
    }));
    const response: OpenAIChatCompletion = {
      id: result.response.id,
      object: "chat.completion",
      created: Math.floor(result.response.timestamp.getTime() / 1000),
      model: result.response.modelId,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.text || null,
            refusal: null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toOpenAIFinishReason(result.finishReason),
          logprobs: null,
        },
      ],
      usage: toOpenAIUsage(result.usage),
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return upstreamError(e);
  }
};
