// A remote harness's output items as the session's items: messages, function calls and their
// outputs, every one marked `external` (untrusted output the risk classifier never sees,
// statewalker/statewalker-root#109). Reasoning and the question item are left out: a question
// becomes an approval or a question of the session.
import type { ItemInput } from "@statewalker/ai-sessions";
import type { UhpItem } from "./protocol.js";

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Record<string, unknown>[])
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("")
    : typeof content === "string"
      ? content
      : "";

/** The items one output item stands for (none for what the session does not show). */
export function itemsOf(item: UhpItem): ItemInput[] {
  if (item.type === "message" && item.role !== "user")
    return [{ kind: "message", role: "assistant", text: textOf(item.content), external: true }];
  if (item.type === "function_call") {
    let args: unknown = item.arguments;
    try {
      args = JSON.parse(String(item.arguments));
    } catch {
      // kept as the text it was
    }
    return [
      {
        kind: "tool_call",
        callId: String(item.call_id ?? item.id ?? ""),
        name: String(item.name ?? ""),
        args,
        external: true,
      },
    ];
  }
  if (item.type === "function_call_output")
    return [
      {
        kind: "tool_result",
        callId: String(item.call_id ?? ""),
        output: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        isError: false,
        external: true,
      },
    ];
  return [];
}
