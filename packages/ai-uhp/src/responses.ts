// Tasks, responses and input requests (Tasks §1–§4, Sessions §1 and §4, UHP 2026-10-19; decided in
// statewalker/statewalker-root#108, amended by #159), read and written through the session API's
// methods only, with the caller's token:
// - A UHP session is an agent session and a response is a turn: its id is `resp_<turn id>`.
// - A task without `previous_response_id` starts an agent session on the harness's agent; one
//   with it continues that turn's session (`after_turn`: an earlier turn moves the head there
//   first, an implicit rewind that reverts no file). A session with a turn running or queued
//   answers `409 session_busy`; UHP has no queue and no steering.
// - `branch: true` forks the session at that turn, carrying the task as its first message; the
//   response reports `metadata.branched_from`. Files are not restored into the fork, so
//   `session_branching` is not declared.
// - An approval the turn waits on is its last item, an `input_request` (`confirm`, options
//   `allow`/`deny`; a remote harness's question keeps its own kind), one at a time, and the turn
//   ends `incomplete` with reason `input_required`. An `input_response` answers it with scope
//   "once"; any other input passes it over (`void_approvals`), reported in
//   `metadata.voided_input_requests`.
// - Request fields the projection does not act on are reported in `metadata.ignored_fields`: they
//   are kept as the turn's ignored fields, so a response read back says the same.

import { allItems, isTerminal, messageText, textOf } from "@statewalker/ai-openai-compat";
import {
  type AgentSessionView,
  type ApprovalView,
  type Item,
  type SessionApi,
  sessionOfTurn,
  type TurnView,
} from "@statewalker/ai-sessions";
import { messageOf, toUhpError, uhpError } from "./errors.js";
import { findHarness, harnessId, listHarnesses } from "./harnesses.js";

/** The session API methods the projection reads and writes through. */
export type UhpApi = Pick<
  SessionApi,
  | "startSession"
  | "getSession"
  | "deleteSession"
  | "sendMessage"
  | "getTurn"
  | "cancelTurn"
  | "listItems"
  | "readEvents"
  | "listApprovals"
  | "answerApproval"
  | "forkSession"
  | "listBranches"
  | "listAgents"
  | "listModels"
>;

export const RESPONSE_PREFIX = "resp_";
export const INPUT_REQUEST_PREFIX = "inreq_";
const WAIT_MS = 10_000;

/** The request fields the projection acts on; any other is reported ignored. */
const KNOWN_FIELDS = [
  "input",
  "model",
  "metadata",
  "stream",
  "previous_response_id",
  "branch",
  "background",
];

/** How a request field the projection did not act on is kept among the turn's ignored fields. */
const IGNORED_MARK = "uhp:";

export const responseId = (turn: string) => `${RESPONSE_PREFIX}${turn}`;
export const inputRequestId = (approval: string) => `${INPUT_REQUEST_PREFIX}${approval}`;
const seconds = (ms: number) => Math.floor(ms / 1000);

/** The turn a response id names; `response_not_found` for an id that names none. */
export function turnOf(id: string, param?: string): string {
  const refused = () =>
    uhpError(404, "response_not_found", `no response '${id}'`, param ? { param } : {});
  if (!id.startsWith(RESPONSE_PREFIX)) throw refused();
  const turn = id.slice(RESPONSE_PREFIX.length);
  try {
    sessionOfTurn(turn);
  } catch {
    throw refused();
  }
  return turn;
}

/**
 * A response's session and turn, when the caller sees it through UHP: one of their top-level
 * agent sessions (sub-agents are not visible); `response_not_found` otherwise.
 */
export async function readTurn(
  api: UhpApi,
  id: string,
  param?: string,
): Promise<{ session: AgentSessionView; view: TurnView }> {
  const turn = turnOf(id, param);
  try {
    const session = await api.getSession(sessionOfTurn(turn));
    if (session.parent) throw uhpError(404, "response_not_found", `no response '${id}'`);
    return { session, view: await api.getTurn(turn) };
  } catch (e) {
    throw toUhpError(e, { notFound: "response_not_found" });
  }
}

/** One of the caller's top-level sessions; `session_not_found` otherwise. */
export async function readSession(api: UhpApi, id: string): Promise<AgentSessionView> {
  try {
    const session = await api.getSession(id);
    if (session.parent) throw uhpError(404, "session_not_found", `no session '${id}'`);
    return session;
  } catch (e) {
    throw toUhpError(e, { notFound: "session_not_found" });
  }
}

/** A question a response asks: an approval its turn waits on, as UHP shows it. */
export interface InputRequest {
  approval: ApprovalView;
  item: Record<string, unknown> & { id: string; type: "input_request" };
}

const CONFIRM_OPTIONS = [
  { id: "allow", label: "Allow, once" },
  { id: "deny", label: "Deny" },
];

/** An approval as an `input_request`. */
export function inputRequestItem(approval: ApprovalView): InputRequest["item"] {
  const input = approval.input;
  const expires = Math.min(approval.expires, input?.expires ?? Number.POSITIVE_INFINITY);
  const { method, path, target } = approval.action;
  return {
    id: inputRequestId(approval.id),
    type: "input_request",
    status: "completed",
    kind: input?.kind ?? "confirm",
    prompt:
      input?.prompt ??
      `Allow ${method} ${path}${target ? ` → ${target}` : ""}? It needs ${approval.permission}: ${approval.reason}`,
    ...(input
      ? input.options?.length
        ? { options: input.options.map((o) => ({ id: o.id, label: o.label ?? o.id })) }
        : {}
      : { options: CONFIRM_OPTIONS }),
    expires_at: seconds(expires),
  };
}

/**
 * The question a turn ends on: the first approval it waits on that is still pending (one at a
 * time: the answer's turn asks the next).
 */
export async function inputRequestOf(
  api: UhpApi,
  view: TurnView,
  approvals?: ApprovalView[],
): Promise<InputRequest | undefined> {
  if (view.status !== "waiting") return undefined;
  const ids = view.stop_reason?.approval_ids ?? [];
  if (!ids.length) return undefined;
  const listed = approvals ?? (await api.listApprovals()).approvals;
  for (const id of ids) {
    const approval = listed.find(
      (a) => a.id === id && a.session === view.session && a.status === "pending",
    );
    if (approval) return { approval, item: inputRequestItem(approval) };
  }
  return undefined;
}

/** Finds the call an approval stood for: the call whose result waited on it (one scan, lazily). */
export function callLookup(api: UhpApi, session: string) {
  let scan: Promise<Item[]> | undefined;
  return async (approval: string): Promise<string | undefined> => {
    scan ??= allItems(api, session, { all: true, types: ["tool_result"] });
    const waiting = (await scan).find((i) => i.callId && i.isError && i.output?.includes(approval));
    return waiting?.callId;
  };
}

/** One session item as UHP output items (none for what stays native). */
export async function outputOf(
  item: Item,
  callOf: (approval: string) => Promise<string | undefined>,
): Promise<Record<string, unknown>[]> {
  switch (item.kind) {
    case "message":
      return item.role === "assistant" && item.text
        ? [
            {
              id: item.id,
              type: "message",
              role: "assistant",
              status: item.incomplete ? "incomplete" : "completed",
              content: [{ type: "output_text", text: item.text, annotations: [] }],
            },
          ]
        : [];
    case "tool_call":
      return item.callId
        ? [
            {
              id: item.id,
              type: "function_call",
              call_id: item.callId,
              name: item.name ?? "tool",
              arguments: JSON.stringify(item.args ?? {}),
              status: "completed",
            },
          ]
        : [];
    case "tool_result": {
      const callId =
        item.callId ??
        (item.approval ? ((await callOf(item.approval)) ?? `call_${item.approval}`) : undefined);
      return callId
        ? [
            {
              id: item.id,
              type: "function_call_output",
              call_id: callId,
              output: item.output ?? "",
              status: "completed",
            },
          ]
        : [];
    }
    default:
      return [];
  }
}

/** What a response says beyond its turn: what the request it came from did. */
export interface ResponseContext {
  /** The response the request chained on (a turn not started yet has no parent yet). */
  previous?: string;
  requestedModel?: string;
  /** The model shown before the turn ran: the agent's. */
  defaultModel?: string;
  voided?: string[];
  branchedFrom?: string;
  approvals?: ApprovalView[];
}

/** Whether a turn is the first turn of a fork, and which response it branched from. */
async function branchedFromOf(
  api: UhpApi,
  session: AgentSessionView,
  view: TurnView,
): Promise<string | undefined> {
  if (!session.forked_from || view.origin !== "run" || !view.parent_turn) return undefined;
  const parent = await api.getTurn(view.parent_turn).catch(() => undefined);
  return parent?.origin === "copied" && parent.copied_from?.turn === session.forked_from.turn
    ? responseId(session.forked_from.turn)
    : undefined;
}

/** A turn as a UHP response. */
export async function responseOf(
  api: UhpApi,
  session: AgentSessionView,
  view: TurnView,
  context: ResponseContext = {},
): Promise<Record<string, unknown> & { status: string }> {
  const callOf = callLookup(api, session.id);
  const output: Record<string, unknown>[] = [];
  for (const item of view.items) output.push(...(await outputOf(item, callOf)));
  const asked = await inputRequestOf(api, view, context.approvals);
  if (asked) {
    // A client that renders only messages shows the question too (Tasks §3.2).
    output.push({
      id: `${asked.item.id}.prompt`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: String(asked.item.prompt), annotations: [] }],
    });
    output.push(asked.item);
  }
  const { status, error, incomplete } = statusOf(view, !!asked);
  const branchedFrom = context.branchedFrom ?? (await branchedFromOf(api, session, view));
  const previous = branchedFrom
    ? branchedFrom
    : view.parent_turn
      ? responseId(view.parent_turn)
      : (context.previous ?? null);
  const ignored = (view.ignored ?? [])
    .filter((f) => f.startsWith(IGNORED_MARK))
    .map((f) => f.slice(IGNORED_MARK.length));
  const usage = view.usage
    ? {
        input_tokens: view.usage.input_tokens + view.usage.cached_tokens,
        output_tokens: view.usage.output_tokens,
        total_tokens: view.usage.input_tokens + view.usage.cached_tokens + view.usage.output_tokens,
        cache_read_tokens: view.usage.cached_tokens,
      }
    : null;
  const substitution = view.model_substitution;
  return {
    id: responseId(view.id),
    object: "response",
    created_at: seconds(view.created),
    status,
    error,
    incomplete_details: incomplete ? { reason: incomplete } : null,
    previous_response_id: previous,
    model: view.model ?? context.requestedModel ?? context.defaultModel ?? "",
    output,
    store: true,
    usage: usage && usage.total_tokens > 0 ? usage : null,
    metadata: {
      session_id: session.id,
      harness_id: harnessId({ project: session.project, agent: session.agent }),
      ...(substitution
        ? {
            requested_model: substitution.requested,
            model_fallback: true,
            model_fallback_reason: substitution.reason,
          }
        : {}),
      ...(ignored.length ? { ignored_fields: ignored } : {}),
      ...(context.voided?.length
        ? { voided_input_requests: context.voided.map(inputRequestId) }
        : {}),
      ...(branchedFrom ? { branched_from: branchedFrom } : {}),
    },
  };
}

/** A turn's status as UHP names it, with the error or the incomplete reason it carries. */
function statusOf(
  view: TurnView,
  asks: boolean,
): { status: string; error: Record<string, unknown> | null; incomplete?: string } {
  const reason = view.stop_reason;
  switch (view.status) {
    case "queued":
    case "running":
      return { status: "in_progress", error: null };
    case "waiting":
      // Waiting on nothing still pending (a rewind cancelled it): the turn is over.
      return asks
        ? { status: "incomplete", error: null, incomplete: "input_required" }
        : { status: "completed", error: null };
    case "completed":
      return { status: "completed", error: null };
    case "cancelled":
      return { status: "cancelled", error: null };
    case "interrupted":
      // Cut by a restart: UHP's interrupted turn (Tasks §3.3). Cut by another message: incomplete.
      return reason?.type === "restart"
        ? {
            status: "failed",
            error: {
              type: "server_error",
              code: "statewalker_interrupted",
              message: "the turn was cut short when the server restarted",
              param: null,
              detail: { reason: "interrupted", workspace: "kept", effects_may_repeat: true },
            },
          }
        : { status: "incomplete", error: null, incomplete: "interrupted" };
    case "incomplete":
      return {
        status: "incomplete",
        error: null,
        incomplete: reason?.type === "budget" ? "budget" : (reason?.type ?? "budget"),
      };
    default:
      return {
        status: "failed",
        error: {
          type: "harness_error",
          code: "harness_error",
          message: view.error ?? reason?.message ?? "the turn failed",
          param: null,
          detail: null,
        },
      };
  }
}

/** A task's input: its message, or the answer to the question the previous response asked. */
interface TaskInput {
  content?: string;
  answer?: { request: string; answer: string };
}

/** Reads `input` (Tasks §2): a string, or items (messages, or one `input_response`). */
function taskInput(input: unknown): TaskInput {
  const invalid = (message: string) => uhpError(400, "invalid_input", message, { param: "input" });
  if (typeof input === "string") {
    if (!input) throw invalid("input is empty");
    return { content: input };
  }
  if (!Array.isArray(input) || !input.length) throw invalid("input is a string or a list of items");
  const messages: { role: string; text: string }[] = [];
  const answers: { request: string; answer: string }[] = [];
  for (const entry of input) {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (item.type === "input_response") {
      if (typeof item.input_request_id !== "string" || typeof item.answer !== "string")
        throw invalid("an input_response names its input_request_id and carries an answer");
      answers.push({ request: item.input_request_id, answer: item.answer });
    } else if (item.type === "resume")
      throw invalid("resuming a turn is not offered here (capability resume)");
    else if (item.type === "message" || (item.type === undefined && "role" in item)) {
      let text: string;
      try {
        text = textOf(item.content);
      } catch (e) {
        throw invalid(`${messageOf(e)} (files are not taken at class core)`);
      }
      messages.push({ role: String(item.role), text });
    } else throw invalid(`input items of type '${String(item.type)}' are not taken`);
  }
  if (answers.length > 1) throw invalid("a request carries at most one input_response");
  if (answers.length && messages.length) throw invalid("an input_response stands alone in input");
  if (answers.length) return { answer: answers[0] };
  try {
    return { content: messageText(messages) };
  } catch (e) {
    throw invalid(messageOf(e));
  }
}

/** What creating a response started: its session and turn, and what to say about it. */
export interface CreatedTask {
  session: AgentSessionView;
  turn: string;
  /** The session's event log offset before the turn. */
  since: number;
  context: ResponseContext;
}

const present = (v: unknown) => v !== undefined && v !== null;

/** Starts a task (`POST /v1/responses`). */
export async function createTask(api: UhpApi, body: Record<string, unknown>): Promise<CreatedTask> {
  const input = taskInput(body.input);
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata !== "object" || Array.isArray(metadata))
    throw uhpError(400, "invalid_input", "metadata is an object", { param: "metadata" });
  const branch = body.branch;
  if (present(branch) && typeof branch !== "boolean")
    throw uhpError(400, "invalid_input", "branch is true or false", { param: "branch" });
  const previousId = present(body.previous_response_id)
    ? String(body.previous_response_id)
    : undefined;
  if (branch === true && !previousId)
    throw uhpError(400, "invalid_input", "a branch starts from a previous_response_id", {
      param: "branch",
    });
  if (branch === true && input.answer)
    throw uhpError(400, "invalid_input", "a branch neither answers nor passes over a question", {
      param: "branch",
    });
  if (input.answer && !previousId)
    throw uhpError(400, "invalid_input", "an input_response answers the previous response", {
      param: "input",
    });
  const model = typeof body.model === "string" && body.model ? body.model : undefined;
  // The fields not acted on: kept as the turn's ignored fields, so a read-back says the same.
  const ignored = Object.keys(body)
    .filter((k) => present(body[k]) && !KNOWN_FIELDS.includes(k))
    .filter((k) => !(k === "store" && body.store === true));
  for (const k of Object.keys(metadata))
    if (k !== "harness_id" && present(metadata[k])) ignored.push(`metadata.${k}`);
  // Marked apart, so no request field can stand for one the session API reads.
  const marks = Object.fromEntries(ignored.map((k) => [`${IGNORED_MARK}${k}`, true]));
  const harnessParam = "metadata.harness_id";
  const named =
    typeof metadata.harness_id === "string" && metadata.harness_id
      ? await findHarness(api, metadata.harness_id, harnessParam)
      : undefined;

  if (previousId) {
    const { session, view } = await readTurn(api, previousId, "previous_response_id");
    if (named && (named.project !== session.project || named.id !== session.agent))
      throw uhpError(409, "harness_mismatch", "the response is of another harness's session", {
        param: harnessParam,
      });
    if (session.archived)
      throw uhpError(404, "session_expired", "the session is archived: it takes no more tasks");
    const context: ResponseContext = {
      previous: previousId,
      ...(model ? { requestedModel: model } : {}),
    };
    if (branch === true) {
      if (!isTerminal(view.status))
        throw uhpError(409, "branch_unavailable", "a response still running is no branch point", {
          param: "previous_response_id",
        });
      const forked = await api
        .forkSession(session.id, {
          at_turn: view.id,
          message: input.content as string,
          ...(model ? { model } : {}),
        })
        .catch((e) => {
          throw toUhpError(e, { notFound: "response_not_found", busy: "branch_unavailable" });
        });
      const accepted = forked.accepted;
      if (!accepted) throw uhpError(500, "statewalker_server_error", "the fork took no message");
      return {
        session: forked.session,
        turn: accepted.turn_id,
        since: accepted.offset,
        context: { ...context, branchedFrom: previousId },
      };
    }
    if (input.answer) return answerTask(api, session, view, input.answer, context);
    if (!isTerminal(view.status) || session.status === "running")
      throw uhpError(409, "session_busy", "a task is already running in this session");
    const accepted = await api
      .sendMessage(session.id, {
        content: input.content as string,
        ...(model ? { model } : {}),
        after_turn: view.id,
        void_approvals: true,
        ...marks,
      } as never)
      .catch((e) => {
        throw toUhpError(e, { notFound: "response_not_found" });
      });
    return {
      session,
      turn: accepted.turn_id,
      since: accepted.offset,
      context: {
        ...context,
        ...(accepted.voided_approvals ? { voided: accepted.voided_approvals } : {}),
      },
    };
  }

  // A new session, on the harness named or the caller's default one.
  let agent = named;
  if (!agent) {
    const agents = await listHarnesses(api);
    agent = agents.find((a) => a.default) ?? agents[0];
    if (!agent)
      throw uhpError(404, "harness_not_found", "no harness here: no agent you may start", {
        param: harnessParam,
      });
  }
  const session = await api.startSession({ project: agent.project, agent: agent.id }).catch((e) => {
    throw toUhpError(e, { notFound: "harness_not_found" });
  });
  let accepted: { turn_id: string; offset: number };
  try {
    accepted = await api.sendMessage(session.id, {
      content: input.content as string,
      ...(model ? { model } : {}),
      ...marks,
    } as never);
  } catch (e) {
    // A refused first message leaves no empty session behind.
    await api.deleteSession(session.id).catch(() => {});
    throw toUhpError(e);
  }
  return {
    session,
    turn: accepted.turn_id,
    since: accepted.offset,
    context: {
      ...(model ? { requestedModel: model } : {}),
      ...(agent.model ? { defaultModel: agent.model } : {}),
    },
  };
}

/** Answers the question the previous response asked: the approval, with scope "once". */
async function answerTask(
  api: UhpApi,
  session: AgentSessionView,
  view: TurnView,
  answer: { request: string; answer: string },
  context: ResponseContext,
): Promise<CreatedTask> {
  const asked = await inputRequestOf(api, view);
  const param = "input";
  if (!asked || asked.item.id !== answer.request) {
    // Expired: no longer pending, and past its time.
    const id = answer.request.startsWith(INPUT_REQUEST_PREFIX)
      ? answer.request.slice(INPUT_REQUEST_PREFIX.length)
      : undefined;
    const approval = id
      ? (await api.listApprovals()).approvals.find((a) => a.id === id && a.session === session.id)
      : undefined;
    if (
      approval?.status === "expired" &&
      (view.stop_reason?.approval_ids ?? []).includes(approval.id)
    )
      throw uhpError(410, "input_request_expired", "the question expired: send a new task", {
        param,
      });
    throw uhpError(409, "input_not_pending", "the response has no such pending question", {
      param,
    });
  }
  const item = asked.item;
  if (Number(item.expires_at) * 1000 < Date.now())
    throw uhpError(410, "input_request_expired", "the question expired: send a new task", {
      param,
    });
  const options = (item.options as { id: string }[] | undefined)?.map((o) => o.id);
  const kind = String(item.kind);
  if (
    (kind === "choice" || kind === "confirm") &&
    !(options ? options.includes(answer.answer) : ["yes", "no"].includes(answer.answer))
  )
    throw uhpError(422, "input_response_invalid", "the answer is not one of the options", {
      param,
      detail: { options: options ?? ["yes", "no"] },
    });
  const gate = !asked.approval.input;
  let accepted: { turn_id: string; offset: number } | undefined;
  try {
    ({ accepted } = await api.answerApproval(asked.approval.id, {
      decision: gate ? (answer.answer === "allow" ? "allow" : "deny") : "allow",
      // "For this session" stays native only.
      scope: "once",
      ...(gate ? {} : { message: answer.answer }),
    }));
  } catch (e) {
    // Answered meanwhile, or cancelled: no longer pending.
    if (/^E(INVAL|BUSY|NOENT):/.test(String((e as Error)?.message)))
      throw uhpError(409, "input_not_pending", messageOf(e), { param });
    throw toUhpError(e);
  }
  // A rewind's revert of files (statewalker/statewalker-root#191) is never an input request.
  if (!accepted) throw uhpError(409, "input_not_pending", "the approval runs no turn", { param });
  return { session, turn: accepted.turn_id, since: accepted.offset, context };
}

/** Waits until a turn has ended: cursor reads of the session's log, each waiting a while. */
export async function waitTurn(api: UhpApi, task: CreatedTask): Promise<TurnView> {
  let cursor = task.since;
  for (;;) {
    const view = await api.getTurn(task.turn);
    if (isTerminal(view.status)) return view;
    const page = await api.readEvents(task.session.id, { since: cursor, wait: WAIT_MS });
    cursor = page.offset;
  }
}

/** A response's input (`GET /v1/responses/{id}/input_items`): its message, or its answer. */
export function inputItems(view: TurnView): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const item of view.items)
    if (item.kind === "message" && item.role === "user" && item.text && !item.steer)
      out.push({
        id: item.id,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: item.text }],
      });
    else if (item.kind === "tool_result" && item.approval && !item.callId && view.answers)
      // A remote question's answer is never repeated (a secret's never kept); an approval's is.
      out.push({
        id: `${item.id}.answer`,
        type: "input_response",
        input_request_id: inputRequestId(item.approval),
        ...(item.denied
          ? { answer: "deny" }
          : /: denied/.test(item.output ?? "")
            ? {}
            : { answer: "allow" }),
      });
  return out;
}

/** The depth of a turn on its path, counting from 1 (Sessions §3). */
export async function depthOf(api: UhpApi, session: string, turn: string): Promise<number> {
  const { turns } = await api.listBranches(session);
  const parent = new Map(turns.map((t) => [t.id, t.parent_turn]));
  let depth = 0;
  for (let at: string | null | undefined = turn; at; at = parent.get(at)) depth++;
  return depth;
}

/** A session as UHP's session detail shows it (beyond class core; it names a fork's origin). */
export async function sessionDetail(
  api: UhpApi,
  session: AgentSessionView,
): Promise<Record<string, unknown>> {
  const from = session.forked_from;
  let branched: Record<string, unknown> | undefined;
  if (from) {
    // The source's path, when the caller can still read it.
    const turn = await depthOf(api, from.session, from.turn).catch(() => undefined);
    branched = {
      response_id: responseId(from.turn),
      session_id: from.session,
      ...(turn ? { turn } : {}),
    };
  }
  const STATUS: Record<string, string> = {
    idle: "completed",
    running: "in_progress",
    waiting: "incomplete",
    error: "failed",
  };
  return {
    id: session.id,
    object: "session",
    harness_id: harnessId({ project: session.project, agent: session.agent }),
    status: session.archived ? "archived" : (STATUS[session.status ?? "idle"] ?? "completed"),
    created_at: seconds(session.created),
    ...(branched ? { branched_from: branched } : {}),
  };
}
