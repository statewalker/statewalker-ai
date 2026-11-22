// The model context of a turn, as pi-agent-core messages (statewalker/statewalker-root#131): the
// harness's context entries (top-level summaries and the items no summary covers, already shaped
// by ai-sessions) become the loop's initial messages. Flue's own compaction is not used: the
// harness compacts, so there are never two competing summaries.
import type { ContextEntry, Item } from "@statewalker/ai-sessions";

/** The model an assistant message came from: the turn's own (pi replays it as the same model's). */
export interface ContextModel {
  api: string;
  provider: string;
  id: string;
}

type Text = { type: "text"; text: string };
type ToolCallPart = { type: "toolCall"; id: string; name: string; arguments: unknown };
type Assistant = {
  role: "assistant";
  content: (Text | ToolCallPart)[];
  api: string;
  provider: string;
  model: string;
  usage: Record<string, unknown>;
  stopReason: "stop" | "toolUse";
  timestamp: number;
};
export type ContextMessage =
  | { role: "user"; content: string; timestamp: number }
  | Assistant
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Text[];
      isError: boolean;
      timestamp: number;
    };

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** What opens a summary's message in the model context. */
export const SUMMARY_MESSAGE_START = "[Summary of earlier messages]";

/** The loop's initial messages for a turn's context. */
export function contextMessages(context: ContextEntry[], model: ContextModel): ContextMessage[] {
  const out: ContextMessage[] = [];
  let assistant: Assistant | undefined;
  const calls = new Set<string>();
  const assistantOf = (): Assistant => {
    if (!assistant) {
      assistant = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: USAGE,
        stopReason: "stop",
        timestamp: 0,
      };
      out.push(assistant);
    }
    return assistant;
  };
  const user = (content: string) => {
    assistant = undefined;
    out.push({ role: "user", content, timestamp: 0 });
  };
  for (const entry of context) {
    if (entry.type === "summary") {
      const { content, sections } = entry.summary;
      user(
        [
          SUMMARY_MESSAGE_START,
          content,
          ...(sections ?? []).map((s) => `## ${s.title}\n${s.body}`),
        ].join("\n"),
      );
      continue;
    }
    const item: Item = entry.item;
    if (item.kind === "message") {
      if (item.role === "user") user(item.text ?? "");
      else {
        assistant = undefined;
        assistantOf().content.push({ type: "text", text: item.text ?? "" });
      }
    } else if (item.kind === "tool_call" && item.callId) {
      const a = assistantOf();
      a.content.push({
        type: "toolCall",
        id: item.callId,
        name: item.name ?? "",
        arguments: item.args ?? {},
      });
      a.stopReason = "toolUse";
      calls.add(item.callId);
    } else if (item.kind === "tool_result") {
      if (item.callId && calls.has(item.callId)) {
        out.push({
          role: "toolResult",
          toolCallId: item.callId,
          toolName: item.name ?? "",
          content: [{ type: "text", text: item.output ?? "" }],
          isError: !!item.isError,
          timestamp: 0,
        });
        assistant = undefined;
      } else {
        // A result with no call before it (an approved action run again): told as a message.
        user(`[Result of an approved action] ${item.output ?? ""}`);
      }
    }
    // Approval items are not part of the model context: the waiting call's result says it.
  }
  return out;
}
