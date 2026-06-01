import type {
  AssistantContent,
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  ToolModelMessage,
  ToolResultPart,
} from "ai";
import { errorResponse } from "../errors.js";
import type {
  OpenAIAssistantMessage,
  OpenAIChatMessage,
  OpenAISystemMessage,
  OpenAIToolMessage,
  OpenAIUserContentPart,
  OpenAIUserMessage,
} from "../openai-types.js";

/**
 * Thrown when an inbound OpenAI message can't be translated. The router
 * catches and converts to a 400 invalid_request_error.
 */
export class MessageTranslationError extends Error {
  constructor(
    message: string,
    public readonly param?: string,
  ) {
    super(message);
  }
}

const translateUserPart = (p: OpenAIUserContentPart): TextPart | ImagePart | FilePart => {
  if (p.type === "text") return { type: "text", text: p.text };
  if (p.type === "image_url") {
    return { type: "image", image: new URL(p.image_url.url) };
  }
  if (p.type === "file") {
    return {
      type: "file",
      data: p.file.file_data ?? "",
      mediaType: "application/octet-stream",
      filename: p.file.filename,
    };
  }
  // input_audio
  return {
    type: "file",
    data: p.input_audio.data,
    mediaType: p.input_audio.format === "mp3" ? "audio/mpeg" : "audio/wav",
  };
};

const translateUser = (m: OpenAIUserMessage): ModelMessage => ({
  role: "user",
  content: typeof m.content === "string" ? m.content : m.content.map(translateUserPart),
});

const translateSystem = (m: OpenAISystemMessage): ModelMessage => ({
  role: "system",
  content: typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join(""),
});

const translateAssistant = (m: OpenAIAssistantMessage): AssistantModelMessage => {
  const parts: AssistantContent = [];
  if (typeof m.content === "string") {
    if (m.content.length > 0) parts.push({ type: "text", text: m.content });
  } else if (Array.isArray(m.content)) {
    for (const p of m.content) parts.push({ type: "text", text: p.text });
  }
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      let parsed: unknown = {};
      try {
        parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        parsed = tc.function.arguments;
      }
      parts.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: parsed,
      });
    }
  }
  return { role: "assistant", content: parts };
};

const translateTool = (m: OpenAIToolMessage): ToolModelMessage => {
  const text = typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("");
  const part: ToolResultPart = {
    type: "tool-result",
    toolCallId: m.tool_call_id,
    toolName: m.tool_call_id,
    output: { type: "text", value: text },
  };
  return { role: "tool", content: [part] };
};

export const translateMessages = (messages: OpenAIChatMessage[]): ModelMessage[] => {
  if (!Array.isArray(messages)) {
    throw new MessageTranslationError("`messages` must be an array", "messages");
  }
  return messages.map((m): ModelMessage => {
    if (m.role === "user") return translateUser(m);
    if (m.role === "system" || m.role === "developer") {
      return translateSystem(m);
    }
    if (m.role === "assistant") return translateAssistant(m);
    if (m.role === "tool") return translateTool(m);
    throw new MessageTranslationError(
      `Unsupported message role: ${(m as { role: string }).role}`,
      "messages",
    );
  });
};

export const messageErrorToResponse = (e: unknown): Response => {
  if (e instanceof MessageTranslationError) {
    return errorResponse(400, "invalid_request_error", "invalid_request_error", e.message, e.param);
  }
  throw e;
};
