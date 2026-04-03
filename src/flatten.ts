import type { LlmMessage } from "@statewalker/ai/messages";
import type { Message } from "./wrappers/message.js";
import { NodeType } from "./wrappers/node-types.js";
import type { Session } from "./wrappers/session.js";
import type { ToolCall } from "./wrappers/tool-call.js";
import type { Turn } from "./wrappers/turn.js";

// ---------------------------------------------------------------------------
// Default selection strategy: yield all messages from all turns
// ---------------------------------------------------------------------------

export async function* selectAll(session: Session): AsyncGenerator<LlmMessage> {
  for (const turn of session.turns) {
    yield* flattenTurn(turn);
  }
}

// ---------------------------------------------------------------------------
// Flatten a single turn to LlmMessages
// ---------------------------------------------------------------------------

export function* flattenTurn(turn: Turn): Generator<LlmMessage> {
  const agentMessages: Message[] = [];
  const toolCalls: ToolCall[] = [];

  for (const child of turn.children) {
    switch (child.type) {
      case NodeType.userMessage:
        yield { role: "user", content: (child as Message).text };
        break;
      case NodeType.agentMessage:
        agentMessages.push(child as Message);
        break;
      case NodeType.toolCall:
        toolCalls.push(child as ToolCall);
        break;
    }
  }

  if (agentMessages.length === 0 && toolCalls.length === 0) return;

  const parts: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }
  > = [];

  for (const msg of agentMessages) {
    for (const thinking of msg.thinkingBlocks) {
      if (thinking.text) {
        parts.push({ type: "reasoning", text: thinking.text });
      }
    }
    if (msg.text) {
      parts.push({ type: "text", text: msg.text });
    }
  }

  for (const tc of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: tc.callId,
      toolName: tc.toolName,
      args: (tc.args as Record<string, unknown>) ?? {},
    });
  }

  if (parts.length > 0) {
    yield { role: "assistant", content: parts };
  }

  for (const tc of toolCalls) {
    if (tc.response) {
      yield {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: tc.callId,
            toolName: tc.toolName,
            result: tc.result ?? "",
            isError: tc.isError || undefined,
          },
        ],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: flatten selected turns (for custom strategies)
// ---------------------------------------------------------------------------

export function flattenTurns(turns: Turn[]): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const turn of turns) {
    for (const msg of flattenTurn(turn)) {
      messages.push(msg);
    }
  }
  return messages;
}
