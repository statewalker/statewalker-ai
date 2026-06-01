import type { FinishReason } from "ai";

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

export const toOpenAIFinishReason = (r: FinishReason): OpenAIFinishReason => {
  switch (r) {
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    case "stop":
    case "error":
    case "other":
      return "stop";
  }
};
