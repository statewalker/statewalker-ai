import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

type WebLLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

/**
 * Convert an AI-SDK v3 prompt into WebLLM's OpenAI-shaped message list.
 *
 * WebLLM's chat API accepts the same shape as OpenAI's ChatCompletion, so
 * the conversion is close to lossless: system/user/assistant/tool roles
 * map 1:1; multimodal text parts are concatenated into `content`; tool
 * calls round-trip through `tool_calls` / `tool_call_id`.
 */
export function convertPrompt(prompt: LanguageModelV3Prompt): WebLLMMessage[] {
  const out: WebLLMMessage[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;
      case "user": {
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        out.push({ role: "user", content: text });
        break;
      }
      case "assistant": {
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        const toolCalls = message.content
          .filter((part) => part.type === "tool-call")
          .map((part) => {
            const call = part as {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              input: unknown;
            };
            return {
              id: call.toolCallId,
              type: "function" as const,
              function: {
                name: call.toolName,
                arguments:
                  typeof call.input === "string"
                    ? call.input
                    : JSON.stringify(call.input),
              },
            };
          });
        out.push({
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          const result = part as {
            type: "tool-result";
            toolCallId: string;
            toolName: string;
            output: { type: string; value: unknown };
          };
          const content =
            typeof result.output.value === "string"
              ? result.output.value
              : JSON.stringify(result.output.value);
          out.push({
            role: "tool",
            content,
            tool_call_id: result.toolCallId,
            name: result.toolName,
          });
        }
        break;
      }
      default:
        // Unreachable: LanguageModelV3Message is a closed discriminated union.
        break;
    }
  }
  return out;
}

export type { WebLLMMessage };
