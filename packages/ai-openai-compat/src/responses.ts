// Responses and Conversations (statewalker/statewalker-root#138, decided in #71, #83 and #159): a
// Conversation is an agent session and a Response is a turn, read and written through the session
// API's methods only, with the caller's token, so every call is the caller's own.
// - A Response's id is its turn's id, a Conversation's its session's.
// - `previous_response_id` chains on that turn (`after_turn`): the latest one appends, an earlier
//   one moves the session's head there first (an implicit rewind that never reverts files,
//   recorded by an item; refused with 409 while a turn runs or waits in the queue).
// - A Response holding `mcp_approval_response` items answers those approvals (scope "once"; the
//   deny reason goes to the model): the answer turns are the new Response, the last of them its id.
//   The Response created shows every answer turn of the request; read again later, a Response is
//   its own turn (the session keeps no record of which answers came in one request).
// - Conversations show only the active path; items and responses are never deleted.
import { codedError } from "@statewalker/ai-access";
import {
  type AgentSessionView,
  type Item,
  type SessionApi,
  sessionOfTurn,
  TERMINAL_TURN_STATUSES,
  type TurnView,
  waitsOnSubAgent,
} from "@statewalker/ai-sessions";
import {
  approvalRequest,
  type CallInfo,
  type CallOfApproval,
  mapItems,
  type OpenAiItem,
  OutputMapper,
} from "./output.js";

/** The session API methods the projection reads and writes through. */
export type OpenAiApi = Pick<
  SessionApi,
  | "startSession"
  | "getSession"
  | "updateSession"
  | "deleteSession"
  | "archiveSession"
  | "sendMessage"
  | "getTurn"
  | "cancelTurn"
  | "listItems"
  | "readEvents"
  | "listApprovals"
  | "answerApproval"
  | "listModels"
>;

/** The agent a base URL names: `<plugin>/<agent>`, or "default" (the project's default agent). */
export interface AgentRoute {
  project: string;
  agent: string;
}

export const DEFAULT_AGENT = "default";
const PAGE = 100;
const WAIT_MS = 10_000;

export const isTerminal = (status: string) =>
  (TERMINAL_TURN_STATUSES as readonly string[]).includes(status);

/** One of the caller's sessions, if it runs the base URL's agent in its project. */
export async function conversationOf(
  api: OpenAiApi,
  route: AgentRoute,
  id: string,
): Promise<AgentSessionView> {
  const session = await api.getSession(id);
  if (
    session.project !== route.project ||
    (route.agent !== DEFAULT_AGENT && session.agent !== route.agent)
  )
    throw codedError("ENOENT", "no such conversation");
  return session;
}

/** The start request of a session on the base URL's agent. */
export const startRequest = (route: AgentRoute) => ({
  project: route.project,
  ...(route.agent !== DEFAULT_AGENT ? { agent: route.agent } : {}),
});

/** Every item of a session the query names, in order. */
export async function allItems(
  api: Pick<OpenAiApi, "listItems">,
  session: string,
  query: { all?: boolean; types?: Item["kind"][] } = {},
): Promise<Item[]> {
  const items: Item[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api.listItems(session, {
      ...query,
      limit: PAGE,
      ...(after ? { after } : {}),
    });
    items.push(...page.items);
    if (!page.has_more || !page.last_id) return items;
    after = page.last_id;
  }
}

/**
 * Finds the call each approval of a session stands for, and its approval item: one scan of the
 * session's tool calls, results and approvals, on every branch, made when first needed.
 */
export function approvalLookup(api: OpenAiApi, session: string) {
  let scan: Promise<Item[]> | undefined;
  const items = () => {
    scan ??= allItems(api, session, { all: true, types: ["tool_call", "tool_result", "approval"] });
    return scan;
  };
  const callOf: CallOfApproval = async (approval) => {
    const list = await items();
    const waiting = list.find(
      (i) => i.kind === "tool_result" && i.callId && i.isError && i.output?.includes(approval),
    );
    const call = waiting
      ? list.find(
          (i) => i.kind === "tool_call" && i.callId === waiting.callId && i.turn === waiting.turn,
        )
      : undefined;
    return call
      ? ({ name: call.name ?? "tool", args: call.args, id: call.id } as CallInfo)
      : undefined;
  };
  const approvalItem = async (approval: string) =>
    (await items()).find((i) => i.kind === "approval" && i.approval === approval);
  return { callOf, approvalItem };
}

const STATUS: Record<string, string> = {
  queued: "queued",
  running: "in_progress",
  // A turn waiting on approvals has ended: its output asks them (as OpenAI's hosted MCP does).
  waiting: "completed",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "cancelled",
  incomplete: "incomplete",
};

/** The OpenAI Response of the last of `turns` (the turns it shows, oldest first). */
export async function responseOf(
  api: OpenAiApi,
  session: AgentSessionView,
  turns: TurnView[],
  options: { requestedModel?: string; lookup?: ReturnType<typeof approvalLookup> } = {},
): Promise<Record<string, unknown> & { output: OpenAiItem[] }> {
  const last = turns.at(-1) as TurnView;
  const first = turns[0] as TurnView;
  const lookup = options.lookup ?? approvalLookup(api, session.id);
  const items = turns.flatMap((t) => t.items);
  const output = await mapItems(items, lookup.callOf);
  if (last.status === "waiting")
    for (const approval of last.stop_reason?.approval_ids ?? [])
      if (!output.some((o) => o.id === approval)) {
        // Still waiting on an approval asked earlier: asked again.
        const item = await lookup.approvalItem(approval);
        output.push(approvalRequest(approval, await lookup.callOf(approval), item ?? {}));
      }
  const usage = { input: 0, output: 0, cached: 0 };
  for (const item of items)
    if (item.usage && item.kind !== "model_fallback") {
      // OpenAI counts cached tokens among the input tokens; the gateway apart.
      usage.input += item.usage.input_tokens + item.usage.cached_tokens;
      usage.output += item.usage.output_tokens;
      usage.cached += item.usage.cached_tokens;
    }
  const failed = last.status === "failed";
  return {
    id: last.id,
    object: "response",
    created_at: Math.floor(first.created / 1000),
    status: STATUS[last.status] ?? last.status,
    background: false,
    model: last.model ?? options.requestedModel ?? "",
    output,
    previous_response_id: first.parent_turn,
    conversation: { id: session.id },
    error: failed
      ? { code: "server_error", message: last.error ?? last.stop_reason?.message ?? "failed" }
      : null,
    incomplete_details:
      last.status === "incomplete"
        ? { reason: last.stop_reason?.type === "budget" ? "max_output_tokens" : "content_filter" }
        : null,
    instructions: null,
    metadata: session.metadata,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    store: true,
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: usage.cached },
      output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input + usage.output,
    },
  };
}

/** An input message: its role and text. */
interface InputMessage {
  role: string;
  text: string;
}

/** An `mcp_approval_response`. */
export interface ApprovalAnswerInput {
  id: string;
  approve: boolean;
  reason?: string;
}

const TEXT_PARTS = ["input_text", "output_text", "text"];

/** A message's text: a string, or text parts only. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw codedError("EINVAL", "a message's content is text");
  return content
    .map((part) => {
      const p = (part ?? {}) as Record<string, unknown>;
      if (!TEXT_PARTS.includes(String(p.type)) || typeof p.text !== "string")
        throw codedError("EINVAL", `content parts of type '${String(p.type)}' are not supported`);
      return p.text;
    })
    .join("");
}

/**
 * The messages a client sent, as one message to the agent: the last user message alone, or, after
 * earlier messages (a client replaying history), those as a transcript before it. The agent's own
 * instructions stay its own: a client's system messages are part of the transcript.
 */
export function messageText(messages: InputMessage[]): string {
  const last = messages.at(-1);
  if (last?.role !== "user" || !last.text)
    throw codedError("EINVAL", "the input ends with no user message");
  if (messages.length === 1) return last.text;
  const earlier = messages
    .slice(0, -1)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n\n");
  return `[The conversation so far, as the client sent it]\n${earlier}\n\n[The message]\n${last.text}`;
}

/** A Responses `input`: a message, or answers to approvals (never both). */
export function inputOf(input: unknown): { content?: string; answers: ApprovalAnswerInput[] } {
  if (typeof input === "string") {
    if (!input) throw codedError("EINVAL", "input is empty");
    return { content: input, answers: [] };
  }
  if (!Array.isArray(input) || !input.length)
    throw codedError("EINVAL", "input is a string or a list of items");
  const messages: InputMessage[] = [];
  const answers: ApprovalAnswerInput[] = [];
  for (const entry of input) {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (item.type === "mcp_approval_response") {
      if (typeof item.approval_request_id !== "string" || typeof item.approve !== "boolean")
        throw codedError(
          "EINVAL",
          "an mcp_approval_response names its request and approves or not",
        );
      answers.push({
        id: item.approval_request_id,
        approve: item.approve,
        ...(typeof item.reason === "string" && item.reason ? { reason: item.reason } : {}),
      });
    } else if (item.type === "message" || (item.type === undefined && "role" in item)) {
      messages.push({ role: String(item.role), text: textOf(item.content) });
    } else
      throw codedError("EINVAL", `input items of type '${String(item.type)}' are not supported`);
  }
  if (answers.length && messages.length)
    throw codedError("EINVAL", "an input answers approvals or holds a message, not both");
  return answers.length ? { answers } : { content: messageText(messages), answers };
}

/** What creating a Response started: its session, the turns it follows, and from where. */
export interface CreatedResponse {
  session: AgentSessionView;
  turns: string[];
  since: number;
  requestedModel?: string;
}

/** Starts a Response: sends its message, or answers its approvals. */
export async function createResponse(
  api: OpenAiApi,
  route: AgentRoute,
  body: Record<string, unknown>,
): Promise<CreatedResponse> {
  const { content, answers } = inputOf(body.input);
  const previous =
    typeof body.previous_response_id === "string" && body.previous_response_id
      ? body.previous_response_id
      : undefined;
  const conversationId =
    typeof body.conversation === "string"
      ? body.conversation
      : typeof (body.conversation as { id?: unknown } | undefined)?.id === "string"
        ? String((body.conversation as { id: string }).id)
        : undefined;
  let session: AgentSessionView | undefined;
  if (previous) session = await conversationOf(api, route, sessionOfTurn(previous));
  if (conversationId) {
    const named = await conversationOf(api, route, conversationId);
    if (session && session.id !== named.id)
      throw codedError("EINVAL", "previous_response_id is not a response of that conversation");
    session = named;
  }
  const requestedModel = typeof body.model === "string" && body.model ? body.model : undefined;
  if (answers.length) {
    const { approvals } = await api.listApprovals();
    const turns: string[] = [];
    let since = Number.POSITIVE_INFINITY;
    if (new Set(answers.map((a) => a.id)).size !== answers.length)
      throw codedError("EINVAL", "an approval request is answered once per input");
    for (const answer of answers) {
      const approval = approvals.find((a) => a.id === answer.id);
      if (!approval) throw codedError("EINVAL", `no approval request ${answer.id}`);
      // A sub-agent's approval is asked and answered as its root's (statewalker/statewalker-ai#88).
      session ??= await conversationOf(api, route, approval.root ?? approval.session);
      if (approval.session !== session.id && approval.root !== session.id)
        throw codedError("EINVAL", `approval request ${answer.id} is not of this conversation`);
      if (approval.status !== "pending")
        throw codedError("EINVAL", `approval request ${answer.id} is ${approval.status}`);
      // A sub-agent's: refused before answering when the Conversation no longer waits on it.
      if (approval.session !== session.id && !(await waitsOnSubAgent(api, session.id, answer.id)))
        throw codedError("EINVAL", `approval request ${answer.id} continues no turn here`);
    }
    for (const answer of answers) {
      const answered = await api.answerApproval(answer.id, {
        decision: answer.approve ? "allow" : "deny",
        // "For this session" stays native only.
        scope: "once",
        ...(answer.reason ? { message: answer.reason } : {}),
      });
      // The Conversation's own turn: a sub-agent's approval continues its root's last.
      const accepted = [answered.accepted, ...(answered.continued ?? [])].find(
        (a) => a.session_id === (session as AgentSessionView).id,
      );
      if (!accepted)
        throw codedError("EINVAL", `approval request ${answer.id} continues no turn here`);
      turns.push(accepted.turn_id);
      since = Math.min(since, accepted.offset);
    }
    return {
      session: session as AgentSessionView,
      turns,
      since,
      ...(requestedModel ? { requestedModel } : {}),
    };
  }
  session ??= await api.startSession({
    ...startRequest(route),
    ...(body.metadata && typeof body.metadata === "object"
      ? { metadata: body.metadata as Record<string, string> }
      : {}),
  });
  const accepted = await api.sendMessage(session.id, {
    content: content as string,
    ...(requestedModel ? { model: requestedModel } : {}),
    ...(previous ? { after_turn: previous } : {}),
  });
  return {
    session,
    turns: [accepted.turn_id],
    since: accepted.offset,
    ...(requestedModel ? { requestedModel } : {}),
  };
}

/** Waits until every turn has ended: cursor reads of the session's log, each waiting a while. */
export async function waitTurns(
  api: OpenAiApi,
  session: string,
  turns: string[],
  since: number,
): Promise<TurnView[]> {
  let cursor = since;
  for (;;) {
    const views = await Promise.all(turns.map((t) => api.getTurn(t)));
    if (views.every((v) => isTerminal(v.status))) return views;
    const page = await api.readEvents(session, { since: cursor, wait: WAIT_MS });
    cursor = page.offset;
  }
}

/** The Response a created one is once its turns have ended (or now, for `background`). */
export async function createdResponse(
  api: OpenAiApi,
  created: CreatedResponse,
  wait: boolean,
): Promise<Record<string, unknown>> {
  const views = wait
    ? await waitTurns(api, created.session.id, created.turns, created.since)
    : await Promise.all(created.turns.map((t) => api.getTurn(t)));
  const response = await responseOf(api, created.session, views, {
    ...(created.requestedModel ? { requestedModel: created.requestedModel } : {}),
  });
  return wait ? response : { ...response, background: true };
}

/** One Response by id: a turn of the caller's sessions on the base URL's agent. */
export async function readResponse(
  api: OpenAiApi,
  route: AgentRoute,
  id: string,
): Promise<{ session: AgentSessionView; view: TurnView }> {
  const session = await conversationOf(api, route, sessionOfTurn(id));
  return { session, view: await api.getTurn(id) };
}

/** A Response's input: the user's message, or the approval answers, of its turns. */
export async function inputItems(
  api: OpenAiApi,
  session: AgentSessionView,
  turns: TurnView[],
): Promise<OpenAiItem[]> {
  const lookup = approvalLookup(api, session.id);
  const items = await mapItems(
    turns.flatMap((t) => t.items.filter((i) => !(i.kind === "message" && i.steer))),
    lookup.callOf,
    { inputs: true },
  );
  return items.filter(
    (i) => (i.type === "message" && i.role === "user") || i.type === "mcp_approval_response",
  );
}

/** A Conversation's items: the active path, as OpenAI items. */
export async function conversationItems(
  api: OpenAiApi,
  session: AgentSessionView,
): Promise<OpenAiItem[]> {
  const lookup = approvalLookup(api, session.id);
  return mapItems(await allItems(api, session.id), lookup.callOf, { inputs: true });
}

/** A page of a list, OpenAI style: `after` an id, `limit` (20, at most 100), `order` (desc). */
export function listPage(
  items: OpenAiItem[],
  query: { after?: string | null; limit?: string | null; order?: string | null },
) {
  const ordered = query.order === "asc" ? items : [...items].reverse();
  const at = query.after ? ordered.findIndex((i) => i.id === query.after) : -1;
  if (query.after && at < 0) throw codedError("EINVAL", `no item ${query.after} in the list`);
  const start = at + 1;
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const data = ordered.slice(start, start + limit);
  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: start + limit < ordered.length,
  };
}

/** A Conversation as OpenAI shows it. */
export const conversationView = (session: AgentSessionView) => ({
  id: session.id,
  object: "conversation",
  created_at: Math.floor(session.created / 1000),
  metadata: session.metadata,
});

/**
 * The events of a streamed Response (OpenAI's `response.*` sequence), as the session's log grows:
 * `response.created`, `response.in_progress` once a turn starts, each output item as
 * `output_item.added` … `output_item.done` (a message with its one text part and its whole text as
 * one delta: the log holds whole items), then `response.completed`, `response.failed` or
 * `response.incomplete` (also for a cancelled turn) with the whole Response. An idle frame stands
 * for time with nothing new (a keep-alive).
 */
export async function* responseEvents(
  api: OpenAiApi,
  created: CreatedResponse,
  options: { keepAliveMs: number },
): AsyncGenerator<Record<string, unknown> | { idle: true }> {
  const { session } = created;
  const lookup = approvalLookup(api, session.id);
  const following = new Set(created.turns);
  const last = created.turns.at(-1) as string;
  const mapper = new OutputMapper(lookup.callOf);
  const emitted = new Set<string>();
  const encoder = new EventEncoder();
  const event = encoder.event;
  const itemEvents = (item: OpenAiItem) => {
    emitted.add(item.id);
    return encoder.itemEvents(item);
  };
  const initial = await responseOf(api, session, [await api.getTurn(last)], {
    ...(created.requestedModel ? { requestedModel: created.requestedModel } : {}),
    lookup,
  });
  yield event("response.created", { response: { ...initial, output: [] } });
  let started = false;
  let since = created.since;
  let upToDate = false;
  while (following.size) {
    const page = await api.readEvents(session.id, {
      since,
      limit: 1000,
      wait: upToDate ? options.keepAliveMs : 0,
    });
    if (!page.events.length && upToDate) yield { idle: true };
    for (const logged of page.events) {
      since = logged.seq;
      if (!logged.turn || !following.has(logged.turn)) continue;
      if (logged.type === "turn.started" && !started) {
        started = true;
        const view = await api.getTurn(last);
        yield event("response.in_progress", {
          response: { ...initial, status: STATUS[view.status] ?? "in_progress", output: [] },
        });
      } else if (logged.type === "item.created") {
        for (const item of await mapper.push(logged.data as Item)) yield* itemEvents(item);
      } else if (logged.type.startsWith("turn.") && isTerminal(logged.type.slice(5))) {
        following.delete(logged.turn);
      }
      if (!following.size) break;
    }
    upToDate = page.up_to_date;
    if (upToDate && following.size)
      // A turn that ended before the cursor has nothing more to show.
      for (const turn of [...following])
        if (isTerminal((await api.getTurn(turn)).status)) {
          const rest = await api.readEvents(session.id, { since, limit: 1000 });
          if (!rest.events.some((e) => e.turn === turn)) following.delete(turn);
        }
  }
  for (const item of mapper.flush()) yield* itemEvents(item);
  const views = await Promise.all(created.turns.map((t) => api.getTurn(t)));
  const final = await responseOf(api, session, views, {
    ...(created.requestedModel ? { requestedModel: created.requestedModel } : {}),
    lookup,
  });
  for (const item of final.output) if (!emitted.has(item.id)) yield* itemEvents(item);
  const type =
    final.status === "completed"
      ? "response.completed"
      : final.status === "failed"
        ? "response.failed"
        : "response.incomplete";
  yield event(type, { response: final });
}

/**
 * Numbers a Responses event stream from 0 (`sequence_number`) and its output items
 * (`output_index`): `event` one event, `itemEvents` one whole item as `output_item.added` …
 * `output_item.done`, a message with its one text part and its whole text as one delta (the log
 * holds whole items). The UHP projection's stream is a subset of it (statewalker/statewalker-root#108).
 */
export class EventEncoder {
  #sequence = 0;
  #index = 0;

  readonly event = (type: string, data: Record<string, unknown>): Record<string, unknown> => ({
    type,
    sequence_number: this.#sequence++,
    ...data,
  });

  itemEvents(item: OpenAiItem): Record<string, unknown>[] {
    const event = this.event;
    const output_index = this.#index++;
    const part = item.type === "message" ? (item.content as { text?: string }[])[0] : undefined;
    if (!part || typeof part.text !== "string")
      return [
        event("response.output_item.added", { output_index, item }),
        event("response.output_item.done", { output_index, item }),
      ];
    const text = part.text;
    const at = { item_id: item.id, output_index, content_index: 0 };
    return [
      event("response.output_item.added", {
        output_index,
        item: { ...item, status: "in_progress", content: [] },
      }),
      event("response.content_part.added", {
        ...at,
        part: { type: "output_text", text: "", annotations: [] },
      }),
      event("response.output_text.delta", { ...at, delta: text, logprobs: [] }),
      event("response.output_text.done", { ...at, text, logprobs: [] }),
      event("response.content_part.done", { ...at, part }),
      event("response.output_item.done", { output_index, item }),
    ];
  }
}
