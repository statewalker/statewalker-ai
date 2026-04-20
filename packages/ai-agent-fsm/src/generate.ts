import { streamText } from "ai";
import type { ModelMessage } from "./context.js";
import type {
  AgentConfig,
  AgentEvent,
  AgentTool,
  TokenUsage,
  ToolCallInfo,
} from "./types.js";

interface GenerateResult {
  text: string;
  toolCalls: ToolCallInfo[];
  usage: TokenUsage;
  finishReason: string;
}

export async function* generate(
  config: AgentConfig,
  system: string,
  messages: ModelMessage[],
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, GenerateResult> {
  const toolSet = buildToolSet(config.tools ?? []);

  const result = streamText({
    model: config.model,
    system,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: messages as any,
    tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
    abortSignal: signal,
  });

  let text = "";
  const toolCalls: ToolCallInfo[] = [];

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        text += part.text;
        yield { type: "text-delta", text: part.text };
        break;
      case "tool-call": {
        const input =
          (part as Record<string, unknown>).input ??
          (part as Record<string, unknown>).args;
        toolCalls.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: input,
        });
        yield {
          type: "tool-call",
          toolCall: {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: input,
          },
        };
        break;
      }
      case "error":
        yield { type: "error", error: String(part.error) };
        break;
    }
  }

  const usage = await result.usage;
  const finishReason = await result.finishReason;

  const u = usage as unknown as Record<string, number | undefined>;
  const tokenUsage: TokenUsage = {
    inputTokens: u.inputTokens ?? u.promptTokens ?? 0,
    outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };

  return { text, toolCalls, usage: tokenUsage, finishReason };
}

function buildToolSet(
  tools: AgentTool[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set: Record<string, any> = {};
  for (const t of tools) {
    set[t.name] = { description: t.description, parameters: t.parameters };
  }
  return set;
}
