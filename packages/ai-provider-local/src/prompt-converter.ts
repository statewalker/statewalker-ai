import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Convert a LanguageModelV3Prompt to the simple `[{ role, content }]`
 * format expected by transformers.js `apply_chat_template()`.
 */
export function convertPrompt(prompt: LanguageModelV3Prompt): ChatMessage[] {
  return prompt.map((msg) => {
    switch (msg.role) {
      case "system":
        // V3 system content is a plain string
        return { role: "system", content: msg.content };
      case "user":
        return { role: "user", content: extractParts(msg.content) };
      case "assistant":
        return { role: "assistant", content: extractParts(msg.content) };
      case "tool":
        return { role: "user", content: extractToolParts(msg.content) };
      default:
        return { role: "user", content: "" };
    }
  });
}

function extractParts(
  content: Array<{
    type: string;
    text?: string;
    toolName?: string;
    input?: unknown;
  }>,
): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      parts.push(part.text);
    } else if (part.type === "tool-call" && part.toolName) {
      parts.push(
        `[Tool call: ${part.toolName}(${JSON.stringify(part.input)})]`,
      );
    }
  }
  return parts.join("");
}

function extractToolParts(
  content: Array<{ type: string; toolName?: string; output?: unknown }>,
): string {
  return content
    .filter((p) => p.type === "tool-result")
    .map((p) => `[Tool result for ${p.toolName}: ${JSON.stringify(p.output)}]`)
    .join("\n");
}
