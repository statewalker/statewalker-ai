import { errorResponse } from "./errors.js";

export const upstreamError = (e: unknown): Response => {
  const message = e instanceof Error ? e.message : String(e);
  return errorResponse(500, "server_error", "upstream_error", message);
};

export const parseJsonBody = async <T>(req: Request): Promise<T | Response> => {
  try {
    return (await req.json()) as T;
  } catch (e) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_request_error",
      `Invalid JSON body: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export const requireModelField = (body: { model?: unknown }): Response | null => {
  if (!body.model || typeof body.model !== "string") {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "`model` is required",
      "model",
    );
  }
  return null;
};

export const modelNotFound = (modelId: string): Response =>
  errorResponse(
    404,
    "invalid_request_error",
    "model_not_found",
    `Model not found: ${modelId}`,
    "model",
  );
