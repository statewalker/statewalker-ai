import type {
  AgentMessage,
  Skill,
  ToolCallInfo,
  ToolResultInfo,
} from "./types.js";

const MASKED_PLACEHOLDER = "[Tool output cleared]";
const CHARS_PER_TOKEN = 4;

// ── Token Estimation ───────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.max(0, Math.round(text.length / CHARS_PER_TOKEN));
}

// ── System Prompt Builder ──────────────────────────────────

export function buildSystemPrompt(
  base: string | undefined,
  skills: Skill[],
): string {
  const parts: string[] = [];
  if (base) parts.push(base);
  for (const skill of skills) {
    parts.push(`<skill name="${skill.name}">\n${skill.content}\n</skill>`);
  }
  return parts.join("\n\n");
}

// ── Message → Vercel AI SDK Format ─────────────────────────

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: Array<
        | { type: "text"; text: string }
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            args: unknown;
          }
      >;
    }
  | {
      role: "tool";
      content: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        result: string;
        isError?: boolean;
      }>;
    };

type AssistantPart =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: unknown;
    };

export function toModelMessages(messages: AgentMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const parts: AssistantPart[] = [];
      if (msg.content) {
        parts.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          });
        }
      }
      result.push({ role: "assistant", content: parts });
    } else if (msg.role === "tool" && msg.toolResults) {
      result.push({
        role: "tool",
        content: msg.toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          result: tr.output,
          isError: tr.isError,
        })),
      });
    }
  }
  return result;
}

// ── Observation Masking ────────────────────────────────────

export function maskOldToolOutputs(
  messages: AgentMessage[],
  protectLastNTurns: number,
): AgentMessage[] {
  let userTurns = 0;
  let protectFromIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      userTurns++;
      if (userTurns >= protectLastNTurns) {
        protectFromIndex = i;
        break;
      }
    }
  }

  return messages.map((msg, i) => {
    if (i >= protectFromIndex) return msg;
    if (msg.role !== "tool" || !msg.toolResults) return msg;
    return {
      ...msg,
      content: MASKED_PLACEHOLDER,
      toolResults: msg.toolResults.map((tr) => ({
        ...tr,
        output: MASKED_PLACEHOLDER,
      })),
    };
  });
}

// ── AgentContext ────────────────────────────────────────────

export class AgentContext {
  messages: AgentMessage[] = [];
  turn = 0;
  totalTokens = 0;

  addUserMessage(content: string): void {
    this.messages.push({
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }

  addAssistantMessage(
    content: string,
    toolCalls?: ToolCallInfo[],
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    this.messages.push({
      role: "assistant",
      content,
      toolCalls,
      usage,
      timestamp: Date.now(),
    });
    if (usage) {
      this.totalTokens += usage.totalTokens;
    }
  }

  addToolResultMessage(results: ToolResultInfo[]): void {
    this.messages.push({
      role: "tool",
      content: results.map((r) => `${r.toolName}: ${r.output}`).join("\n"),
      toolResults: results,
      timestamp: Date.now(),
    });
  }

  getModelMessages(maskAfterTurns?: number): ModelMessage[] {
    const msgs =
      maskAfterTurns != null
        ? maskOldToolOutputs(this.messages, maskAfterTurns)
        : this.messages;
    return toModelMessages(msgs);
  }

  estimateTotalTokens(): number {
    let total = 0;
    for (const msg of this.messages) {
      total += estimateTokens(msg.content);
    }
    return total;
  }
}
