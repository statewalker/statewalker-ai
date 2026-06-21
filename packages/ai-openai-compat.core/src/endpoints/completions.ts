import { generateText, streamText } from "ai";
import { errorResponse } from "../errors.js";
import type { Init } from "../index.js";
import type {
  OpenAICompletion,
  OpenAICompletionChunk,
  OpenAICompletionRequest,
} from "../openai-types.js";
import { toOpenAIFinishReason } from "../translate/finish-reason.js";
import { toOpenAIUsage } from "../translate/usage.js";
import { modelNotFound, parseJsonBody, requireModelField, upstreamError } from "../util.js";

export const handleCompletions = async (req: Request, init: Init): Promise<Response> => {
  const parsed = await parseJsonBody<OpenAICompletionRequest>(req);
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
  if (body.prompt === undefined) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "`prompt` is required",
      "prompt",
    );
  }
  const model = init.languageModels?.[body.model];
  if (!model) return modelNotFound(body.model);

  const callBase = {
    model,
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
    ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
    ...(req.signal ? { abortSignal: req.signal } : {}),
  };

  // Streaming only allowed with a single string prompt.
  if (body.stream) {
    if (typeof body.prompt !== "string") {
      return errorResponse(
        400,
        "invalid_request_error",
        "invalid_request_error",
        "`stream: true` requires `prompt` to be a string",
        "prompt",
      );
    }
    const ctx = {
      id: `cmpl-${crypto.randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    const stream = streamText({
      ...callBase,
      messages: [{ role: "user", content: body.prompt }],
    });
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (chunk: OpenAICompletionChunk): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };
        try {
          for await (const part of stream.fullStream) {
            if (part.type === "text-delta") {
              write({
                id: ctx.id,
                object: "text_completion",
                created: ctx.created,
                model: ctx.model,
                choices: [
                  {
                    index: 0,
                    text: part.text,
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              });
            } else if (part.type === "finish") {
              write({
                id: ctx.id,
                object: "text_completion",
                created: ctx.created,
                model: ctx.model,
                choices: [
                  {
                    index: 0,
                    text: "",
                    finish_reason: toOpenAIFinishReason(part.finishReason),
                    logprobs: null,
                  },
                ],
              });
            }
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: {
                  message,
                  type: "server_error",
                  code: "upstream_error",
                },
              })}\n\n`,
            ),
          );
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

  const prompts = Array.isArray(body.prompt) ? body.prompt : [body.prompt];
  try {
    const results = await Promise.all(
      prompts.map((p) =>
        generateText({
          ...callBase,
          messages: [{ role: "user", content: p }],
        }),
      ),
    );
    const first = results[0];
    if (!first) {
      return errorResponse(500, "server_error", "upstream_error", "No completion result");
    }
    const firstResponse = first.response;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    for (const r of results) {
      const u = toOpenAIUsage(r.usage);
      if (u) {
        promptTokens += u.prompt_tokens;
        completionTokens += u.completion_tokens;
        totalTokens += u.total_tokens;
      }
    }
    const response: OpenAICompletion = {
      id: firstResponse.id,
      object: "text_completion",
      created: Math.floor(firstResponse.timestamp.getTime() / 1000),
      model: firstResponse.modelId,
      choices: results.map((r, i) => ({
        index: i,
        text: r.text,
        finish_reason: toOpenAIFinishReason(r.finishReason),
        logprobs: null,
      })),
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return upstreamError(e);
  }
};
