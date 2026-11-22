// A session's items as OpenAI Responses items (statewalker/statewalker-root#138).
// - An assistant message is a `message` with one `output_text` part; a user message (listed as
//   input) a `message` with one `input_text` part.
// - A tool call and its result are one `mcp_call` (the harness runs its tools itself, as an OpenAI
//   hosted MCP server would): emitted once the result is there, with `output`, or `error` when the
//   call failed.
// - "Ask": the call's error result that waits on an approval is held back, and the turn's
//   approval item becomes an `mcp_approval_request` (its id is the approval's) naming that call.
//   The answer turn's result is an `mcp_call` with `approval_request_id`; listed as input, an
//   `mcp_approval_response` comes before it. Scope "session" stays native only.
// - Every other item kind (rewind notes, model fallbacks, limit warnings, memory priming) stays
//   native: the session API lists it.
import type { Item } from "@statewalker/ai-sessions";

/** The server label of the harness's own tools, as an OpenAI client sees them. */
export const SERVER_LABEL = "harness";

/** One OpenAI Responses item (output or conversation item). */
export type OpenAiItem = { type: string; id: string; [key: string]: unknown };

/** The error result of a call that waits on an approval, as the agent sees it. */
const WAITING = /waiting on the user's approval|EAPPROVAL/;

/** A tool call, by what it was called with. */
export interface CallInfo {
  name: string;
  args: unknown;
  id: string;
}

/** Finds the tool call an approval of the session stands for (asked in an earlier turn). */
export type CallOfApproval = (approval: string) => Promise<CallInfo | undefined>;

const json = (value: unknown) => JSON.stringify(value ?? {});

/**
 * Maps items in order to OpenAI items: `push` returns the items each one completes, `flush` the
 * calls held back that no approval claimed (plain failures after all).
 */
export class OutputMapper {
  readonly #calls = new Map<string, CallInfo>();
  readonly #held: { item: Item; call: CallInfo }[] = [];
  /** Approvals already shown, with the calls they stand for. */
  readonly #asked = new Map<string, CallInfo | undefined>();
  readonly #callOf: CallOfApproval;
  readonly #inputs: boolean;

  /** `inputs`: user messages and approval answers too (a conversation's items, input items). */
  constructor(callOf: CallOfApproval, options: { inputs?: boolean } = {}) {
    this.#callOf = callOf;
    this.#inputs = !!options.inputs;
  }

  async push(item: Item): Promise<OpenAiItem[]> {
    switch (item.kind) {
      case "message":
        if (item.role === "assistant")
          return item.text
            ? [
                {
                  type: "message",
                  id: item.id,
                  status: item.incomplete ? "incomplete" : "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: item.text, annotations: [] }],
                },
              ]
            : [];
        return this.#inputs && item.text
          ? [
              {
                type: "message",
                id: item.id,
                status: "completed",
                role: "user",
                content: [{ type: "input_text", text: item.text }],
              },
            ]
          : [];
      case "tool_call":
        if (item.callId)
          this.#calls.set(item.callId, {
            name: item.name ?? "tool",
            args: item.args,
            id: item.id,
          });
        return [];
      case "tool_result": {
        if (item.callId) {
          const call = this.#calls.get(item.callId) ?? {
            name: item.name ?? "tool",
            args: {},
            id: item.id,
          };
          if (item.isError && WAITING.test(item.output ?? "")) {
            // An approval shown already stands for it.
            for (const approval of this.#asked.keys())
              if (item.output?.includes(approval)) return [];
            // It may wait on an approval: decided at the turn's approval items.
            this.#held.push({ item, call });
            return [];
          }
          return [mcpCall(call, item)];
        }
        if (!item.approval) return [];
        // An answer turn's result: the call the approval stood for.
        const call = (await this.#callOf(item.approval)) ?? {
          name: "action",
          args: {},
          id: item.id,
        };
        const answered = mcpCall({ ...call, id: item.id }, item, item.approval);
        if (!this.#inputs) return [answered];
        return [
          {
            type: "mcp_approval_response",
            id: `${item.id}.answer`,
            approval_request_id: item.approval,
            approve: !item.denied,
            ...(item.denied ? { reason: item.output ?? null } : {}),
          },
          answered,
        ];
      }
      case "approval": {
        const approval = String(item.approval ?? "");
        if (!approval) return [];
        const held = this.#held.find((h) => h.item.output?.includes(approval));
        if (held) this.#held.splice(this.#held.indexOf(held), 1);
        const call = held?.call ?? (await this.#callOf(approval));
        this.#asked.set(approval, call);
        return [approvalRequest(approval, call, item)];
      }
      default:
        return [];
    }
  }

  /** The held results no approval claimed. */
  flush(): OpenAiItem[] {
    const out = this.#held.map((h) => mcpCall(h.call, h.item));
    this.#held.length = 0;
    return out;
  }
}

function mcpCall(call: CallInfo, result: Item, approval?: string): OpenAiItem {
  const failed = !!result.isError;
  return {
    type: "mcp_call",
    id: call.id,
    server_label: SERVER_LABEL,
    name: call.name,
    arguments: json(call.args),
    output: failed ? null : (result.output ?? ""),
    error: failed ? (result.output ?? "failed") : null,
    status: failed ? "failed" : "completed",
    ...(approval ? { approval_request_id: approval } : {}),
  };
}

/** An approval as an `mcp_approval_request`: the call it stands for, else the gate's action. */
export function approvalRequest(
  approval: string,
  call: CallInfo | undefined,
  item: Pick<Item, "request">,
): OpenAiItem {
  return {
    type: "mcp_approval_request",
    id: approval,
    server_label: SERVER_LABEL,
    name: call?.name ?? item.request?.action.method ?? "action",
    arguments: json(call ? call.args : item.request?.action),
  };
}

/** Maps a list of items at once. */
export async function mapItems(
  items: Item[],
  callOf: CallOfApproval,
  options: { inputs?: boolean } = {},
): Promise<OpenAiItem[]> {
  const mapper = new OutputMapper(callOf, options);
  const out: OpenAiItem[] = [];
  for (const item of items) out.push(...(await mapper.push(item)));
  out.push(...mapper.flush());
  return out;
}
