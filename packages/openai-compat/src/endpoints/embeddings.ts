import { embedMany } from "ai";
import { errorResponse } from "../errors.js";
import type { Init } from "../index.js";
import type { OpenAIEmbeddingsRequest, OpenAIEmbeddingsResponse } from "../openai-types.js";
import { modelNotFound, parseJsonBody, requireModelField, upstreamError } from "../util.js";

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export const handleEmbeddings = async (req: Request, init: Init): Promise<Response> => {
  const parsed = await parseJsonBody<OpenAIEmbeddingsRequest>(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  const modelErr = requireModelField(body);
  if (modelErr) return modelErr;
  if (body.input === undefined) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "`input` is required",
      "input",
    );
  }
  const model = init.embeddingModels?.[body.model];
  if (!model) return modelNotFound(body.model);

  let values: string[];
  if (typeof body.input === "string") {
    values = [body.input];
  } else if (isStringArray(body.input)) {
    values = body.input;
  } else {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "`input` must be a string or array of strings; token arrays are not supported",
      "input",
    );
  }

  try {
    const result = await embedMany({
      model,
      values,
      ...(req.signal ? { abortSignal: req.signal } : {}),
    });
    const response: OpenAIEmbeddingsResponse = {
      object: "list",
      data: result.embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model: body.model,
      usage: {
        prompt_tokens: result.usage.tokens,
        total_tokens: result.usage.tokens,
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
