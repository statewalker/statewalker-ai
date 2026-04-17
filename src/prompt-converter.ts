import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

export interface LlamaCppChatMessage {
  type: "system" | "user" | "model";
  text: string;
}

/**
 * Convert an AI-SDK v3 prompt to a sequence of `LlamaChatSession`
 * history entries. System text is concatenated onto the first system
 * entry; user and assistant text parts are joined. Tool calls and tool
 * results are flattened to text with stable markers so the model sees
 * a consistent conversation.
 */
export function convertPrompt(prompt: LanguageModelV3Prompt): {
  systemPrompt: string;
  history: LlamaCppChatMessage[];
  lastUserText: string;
} {
  let systemPrompt = "";
  const history: LlamaCppChatMessage[] = [];
  let lastUserText = "";

  for (const message of prompt) {
    switch (message.role) {
      case "system":
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${message.content}`
          : message.content;
        break;
      case "user": {
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        history.push({ type: "user", text });
        lastUserText = text;
        break;
      }
      case "assistant": {
        const textParts: string[] = [];
        for (const part of message.content) {
          if (part.type === "text") textParts.push(part.text);
          else if (part.type === "tool-call") {
            const call = part as {
              toolCallId: string;
              toolName: string;
              input: unknown;
            };
            const args =
              typeof call.input === "string"
                ? call.input
                : JSON.stringify(call.input);
            textParts.push(
              `[tool_call:${call.toolName} id=${call.toolCallId}]${args}[/tool_call]`,
            );
          }
        }
        history.push({ type: "model", text: textParts.join("") });
        break;
      }
      case "tool": {
        const parts: string[] = [];
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          const result = part as {
            toolCallId: string;
            toolName: string;
            output: { value: unknown };
          };
          const out =
            typeof result.output.value === "string"
              ? result.output.value
              : JSON.stringify(result.output.value);
          parts.push(
            `[tool_result:${result.toolName} id=${result.toolCallId}]${out}[/tool_result]`,
          );
        }
        history.push({ type: "user", text: parts.join("\n") });
        break;
      }
      default:
        break;
    }
  }

  // `LlamaChatSession.prompt(text)` expects the last user message separately
  // from the history; pop it from the tail if present so we don't duplicate.
  if (
    history.length > 0 &&
    history[history.length - 1]?.type === "user" &&
    history[history.length - 1]?.text === lastUserText
  ) {
    history.pop();
  }

  return { systemPrompt, history, lastUserText };
}
