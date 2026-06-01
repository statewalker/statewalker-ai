export type OpenAIErrorType = "invalid_request_error" | "server_error";

export type OpenAIErrorCode = "invalid_request_error" | "model_not_found" | "upstream_error";

export interface OpenAIError {
  error: {
    message: string;
    type: OpenAIErrorType;
    code: OpenAIErrorCode;
    param?: string;
  };
}

export const errorResponse = (
  status: number,
  type: OpenAIErrorType,
  code: OpenAIErrorCode,
  message: string,
  param?: string,
): Response => {
  const body: OpenAIError = {
    error: param ? { message, type, code, param } : { message, type, code },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};
