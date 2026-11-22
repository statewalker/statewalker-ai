// The AI SDK UI message stream (statewalker/statewalker-root#140, decided in #71 and #83): a thin
// projection of an agent session's durable event log, which `useChat`-style UIs read. It holds no
// state of its own: every stream is a cursor read of the log (each read re-checks the caller's
// token), so a disconnect cancels nothing and a resume replays from the log.
//
// One stream is one assistant message: the turns it follows, from a cursor, until each has ended.
// - A turn's start and end are a step (`start-step`, `finish-step`).
// - An assistant message item is a text part (`text-start`, `text-delta` with the whole text,
//   `text-end`; the log holds whole items, no token deltas).
// - A tool call and its result are a dynamic tool part (the tools run on the server, the UI does
//   not define them): `tool-input-start`, `tool-input-available`, then `tool-output-available` or
//   `tool-output-error`.
// - "Ask": the waiting call's error result is held back, and the turn's approval item becomes
//   `tool-approval-request` on that call's part, plus a `data-approval` part with the gate's
//   request (method, path, permission, reason). The answer turn's result is `tool-output-denied`
//   (a denial) or the call's output.
// - A steer is a `steering-message`; every other item kind is a `data-<kind>` part
//   (`model_fallback` → `data-model-fallback`), and a sub-agent's approvals posted to this session
//   are a `data-sub-agent-approvals` part.
// - The stream ends with `finish` (`stop`; `tool-calls` when the turn waits on approvals), with
//   `error` then `finish` (`error`) when a turn failed, or with `abort` when one was cancelled or
//   interrupted; then `[DONE]`. A refused read (an expired token) is an `error` chunk.
import { codedError } from "@statewalker/ai-access";
import {
  type Delivery,
  type Item,
  type SessionApi,
  type SessionEvent,
  TERMINAL_TURN_STATUSES,
  type TurnView,
} from "./api.js";

/** One chunk of the AI SDK's UI message stream protocol (`x-vercel-ai-ui-message-stream: v1`). */
export type UIMessageChunk = { type: string; [key: string]: unknown };

/** The AI SDK's `ChatTransport`, structurally: what `useChat` takes as its `transport`. */
export interface ChatTransportLike {
  sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: unknown[];
    abortSignal: AbortSignal | undefined;
    body?: object;
  }): Promise<ReadableStream<UIMessageChunk>>;
  reconnectToStream(options: {
    chatId: string;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk> | null>;
}

/** What one UI message stream follows: turns of the session, read from a cursor of its log. */
export interface UiStreamPlan {
  turns: string[];
  /** The log offset to read after. */
  since: number;
  /** The assistant message's id, when the stream starts it (a new message, or a full replay). */
  messageId?: string;
}

/** The body `useChat` posts (the AI SDK's HTTP transport), with the harness's extra fields. */
export interface ChatRequestBody {
  id?: string;
  messages?: unknown[];
  trigger?: string;
  messageId?: string;
  /** How the user's message reaches the session (`next` by default). */
  delivery?: Delivery;
  /** A model to run the turn on, within the caller's rights. */
  model?: string;
}

/** The session API methods the projection reads and writes through. */
export type UiStreamApi = Pick<
  SessionApi,
  "readEvents" | "getTurn" | "getSession" | "listItems" | "sendMessage" | "listApprovals"
> &
  Pick<SessionApi, "answerApproval">;

export const UI_MESSAGE_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

const PAGE = 1000;
const DEFAULT_KEEP_ALIVE_MS = 30_000;
const TERMINAL = new Set(TERMINAL_TURN_STATUSES.map((s) => `turn.${s}`));
/** The error result of a call that waits on an approval, as the agent sees it. */
const WAITING = /waiting on the user's approval|EAPPROVAL/;
const DELIVERIES: Delivery[] = ["next", "steer", "interrupt"];

const isTerminal = (status: string) => (TERMINAL_TURN_STATUSES as string[]).includes(status);
const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

interface UiPart {
  type: string;
  state?: string;
  text?: string;
  approval?: { id?: unknown; approved?: unknown; reason?: unknown };
}
interface UiMessage {
  role?: string;
  parts?: UiPart[];
}

/**
 * What a `useChat` request asks: the last message is either the user's (sent to the session as a
 * message) or the assistant's with tool parts the user answered (`approval-responded`: each
 * answers its approval once). Answers only approvals of this session that are still pending.
 */
export async function chatPlan(
  api: UiStreamApi,
  session: string,
  body: ChatRequestBody,
): Promise<UiStreamPlan> {
  if (body.trigger === "regenerate-message")
    throw codedError("EINVAL", "regenerating a message is not supported");
  const last = (Array.isArray(body.messages) ? body.messages.at(-1) : undefined) as
    | UiMessage
    | undefined;
  const parts = Array.isArray(last?.parts) ? last.parts : [];
  if (last?.role === "user") {
    const content = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (!content) throw codedError("EINVAL", "the user's message holds no text");
    const delivery = DELIVERIES.includes(body.delivery as Delivery) ? body.delivery : undefined;
    const accepted = await api.sendMessage(session, {
      content,
      ...(delivery ? { delivery } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
    });
    return {
      turns: [accepted.turn_id],
      since: accepted.offset,
      ...(delivery === "steer" ? {} : { messageId: accepted.turn_id }),
    };
  }
  if (last?.role === "assistant") {
    const answers = parts
      .filter((p) => p?.state === "approval-responded" && typeof p.approval?.id === "string")
      .map((p) => ({
        id: String(p.approval?.id),
        allow: p.approval?.approved === true,
        reason: typeof p.approval?.reason === "string" ? p.approval.reason : undefined,
      }));
    if (!answers.length) throw codedError("EINVAL", "the message answers no approval");
    const { approvals } = await api.listApprovals();
    const pending = answers.filter((a) => {
      const approval = approvals.find((v) => v.id === a.id);
      if (!approval || approval.session !== session)
        throw codedError("EINVAL", `no approval ${a.id} in this session`);
      return approval.status === "pending";
    });
    if (!pending.length) throw codedError("EINVAL", "the message answers no pending approval");
    const turns: string[] = [];
    let since = Number.POSITIVE_INFINITY;
    for (const a of pending) {
      const { accepted } = await api.answerApproval(a.id, {
        decision: a.allow ? "allow" : "deny",
        scope: "once",
        ...(a.reason ? { message: a.reason } : {}),
      });
      turns.push(accepted.turn_id);
      since = Math.min(since, accepted.offset);
    }
    // No message id: the stream continues the assistant message the UI holds.
    return { turns, since };
  }
  throw codedError("EINVAL", "the request holds no user message and no approval answer");
}

interface TurnMark {
  id: string;
  queued: number;
  ended?: number;
  /** The turn whose message this turn is part of: itself, or the turn its answer continues. */
  head: string;
}

/**
 * What a resume follows, or undefined when there is nothing to follow (REST answers `204`). A
 * message is a turn of the user's message and the answer turns that continue it (an answer turn
 * continues the message of the turn whose approval it answers).
 * - With `turn`: that turn's message, replayed in full (or after `since`).
 * - With `since` alone: the turns not ended at that offset, from there.
 * - With neither: the message of the first turn not ended yet, replayed in full; nothing when no
 *   turn runs or waits in the queue.
 */
export async function resumePlan(
  api: UiStreamApi,
  session: string,
  options: { turn?: string; since?: number } = {},
): Promise<UiStreamPlan | undefined> {
  const since = Number.isFinite(options.since) ? Number(options.since) : undefined;
  if (options.turn) {
    const view = await api.getTurn(options.turn);
    if (view.session !== session) throw codedError("ENOENT", "no such turn in this session");
  } else if (since === undefined) {
    const { status } = await api.getSession(session);
    if (status !== "running") return undefined;
  }
  const marks = await scan(api, session);
  const open = (m: TurnMark) => m.ended === undefined || (since !== undefined && m.ended > since);
  if (!options.turn && since !== undefined) {
    const active = marks.filter(open);
    return active.length ? { turns: active.map((m) => m.id), since } : undefined;
  }
  const first = options.turn ? marks.find((m) => m.id === options.turn) : marks.find(open);
  if (!first) return undefined;
  const head = marks.find((m) => m.id === first.head) ?? first;
  const turns = marks.filter((m) => m.head === head.id).map((m) => m.id);
  if (since !== undefined) return { turns, since };
  return { turns, since: head.queued - 1, messageId: head.id };
}

/** The session's turns in log order: where each was queued and ended, and its message. */
async function scan(api: UiStreamApi, session: string): Promise<TurnMark[]> {
  const marks = new Map<string, TurnMark>();
  /** The turn each approval was asked in. */
  const asked = new Map<string, string>();
  let since = 0;
  for (;;) {
    const page = await api.readEvents(session, { since, limit: PAGE });
    for (const event of page.events) {
      if (!event.turn) continue;
      if (event.type === "turn.queued") {
        const answers = (event.data as TurnView | undefined)?.answers;
        const from = answers ? asked.get(answers) : undefined;
        const head = from ? (marks.get(from)?.head ?? from) : event.turn;
        marks.set(event.turn, { id: event.turn, queued: event.seq, head });
      } else if (event.type === "item.created") {
        const item = event.data as Item;
        if ((item.kind === "approval" || item.kind === "mode_decision") && item.approval)
          asked.set(item.approval, event.turn);
      } else if (TERMINAL.has(event.type)) {
        const mark = marks.get(event.turn);
        if (mark) mark.ended = event.seq;
      }
    }
    since = page.offset;
    if (page.up_to_date || !page.events.length) break;
  }
  return [...marks.values()].sort((a, b) => a.queued - b.queued);
}

/**
 * One frame of a UI message stream: the chunks of one log event (with its offset, if it has one),
 * written together so a resume after that offset never splits an event; or idle time.
 */
export type UiStreamFrame = { chunks: UIMessageChunk[]; seq?: number } | { idle: true };

/**
 * The frames of one UI message stream: chunks as the log grows, and an idle frame each time
 * nothing happened for `keepAliveMs` (a keep-alive over SSE).
 */
export async function* uiMessageFrames(
  api: UiStreamApi,
  session: string,
  plan: UiStreamPlan,
  options: { keepAliveMs?: number } = {},
): AsyncGenerator<UiStreamFrame> {
  const keepAliveMs = options.keepAliveMs || DEFAULT_KEEP_ALIVE_MS;
  const following = new Set(plan.turns);
  const ended = new Map<string, TurnView>();
  /** Error results of calls that may wait on an approval, by turn, until the turn's approvals. */
  const held = new Map<string, Item[]>();
  /** The tool call each approval stands for. */
  const calls = new Map<string, string>();
  let since = plan.since;

  const callOfApproval = async (approval: string): Promise<string | undefined> => {
    const known = calls.get(approval);
    if (known) return known;
    // An approval of an earlier stream: the call whose waiting result named it.
    let after: string | undefined;
    let found: string | undefined;
    for (;;) {
      const page = await api.listItems(session, {
        types: ["tool_result"],
        limit: 100,
        ...(after ? { after } : {}),
      });
      for (const item of page.items)
        if (item.callId && item.isError && item.output?.includes(approval)) found = item.callId;
      if (!page.has_more || !page.last_id) break;
      after = page.last_id;
    }
    if (found) calls.set(approval, found);
    return found;
  };

  const output = (callId: string, item: Item): UIMessageChunk =>
    item.denied
      ? { type: "tool-output-denied", toolCallId: callId }
      : item.isError
        ? {
            type: "tool-output-error",
            toolCallId: callId,
            errorText: item.output ?? "",
            dynamic: true,
          }
        : {
            type: "tool-output-available",
            toolCallId: callId,
            output: item.output ?? "",
            dynamic: true,
          };

  async function* itemChunks(item: Item): AsyncGenerator<UIMessageChunk> {
    switch (item.kind) {
      case "message":
        if (item.role === "assistant") {
          if (!item.text) return;
          yield { type: "text-start", id: item.id };
          yield { type: "text-delta", id: item.id, delta: item.text };
          yield { type: "text-end", id: item.id };
        } else if (item.steer && item.text)
          yield {
            type: "steering-message",
            id: item.id,
            parts: [{ type: "text", text: item.text }],
          };
        // The user's own message is the UI's: not repeated in the assistant's.
        return;
      case "tool_call": {
        const toolCallId = item.callId ?? item.id;
        const toolName = item.name ?? "tool";
        yield { type: "tool-input-start", toolCallId, toolName, dynamic: true };
        yield {
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: item.args ?? {},
          dynamic: true,
        };
        return;
      }
      case "tool_result": {
        if (item.callId) {
          if (item.isError && WAITING.test(item.output ?? "")) {
            // It may be a call waiting on an approval: decided at the turn's approval items.
            const list = held.get(item.turn) ?? [];
            list.push(item);
            held.set(item.turn, list);
            return;
          }
          yield output(item.callId, item);
          return;
        }
        const callId = item.approval ? await callOfApproval(item.approval) : undefined;
        if (callId) yield output(callId, item);
        else yield { type: "data-tool-result", id: item.id, data: item };
        return;
      }
      case "approval": {
        const approval = String(item.approval ?? "");
        const list = held.get(item.turn) ?? [];
        const waiting = list.find((r) => r.output?.includes(approval));
        if (waiting) list.splice(list.indexOf(waiting), 1);
        let callId = waiting?.callId ?? calls.get(approval);
        if (!callId) {
          // Asked again by an answer turn: the call of the approval that turn answers.
          const answers = (await api.getTurn(item.turn)).answers;
          if (answers) callId = await callOfApproval(answers);
        }
        if (callId) calls.set(approval, callId);
        yield {
          type: "data-approval",
          id: approval,
          data: {
            approval,
            ...(item.request ? { request: item.request } : {}),
            ...(callId ? { toolCallId: callId } : {}),
          },
        };
        if (callId)
          yield {
            type: "tool-approval-request",
            approvalId: approval,
            toolCallId: callId,
            ...(item.request?.reason ? { reason: item.request.reason } : {}),
          };
        return;
      }
      default:
        yield { type: `data-${item.kind.replace(/_/g, "-")}`, id: item.id, data: item };
    }
  }

  /** Error results held back that no approval claimed: plain errors after all. */
  function* flush(turn: string): Generator<UIMessageChunk> {
    for (const item of held.get(turn) ?? []) yield output(item.callId as string, item);
    held.delete(turn);
  }

  try {
    yield {
      chunks: [
        {
          type: "start",
          ...(plan.messageId ? { messageId: plan.messageId } : {}),
          messageMetadata: { session },
        },
      ],
    };
    let upToDate = false;
    let checked = false;
    while (following.size) {
      const page = await api.readEvents(session, {
        since,
        limit: PAGE,
        wait: upToDate ? keepAliveMs : 0,
      });
      if (!page.events.length && upToDate) yield { idle: true };
      for (const event of page.events as SessionEvent[]) {
        since = event.seq;
        if (event.type === "approval.requested" && !event.turn) {
          yield {
            chunks: [{ type: "data-sub-agent-approvals", id: `ev-${event.seq}`, data: event.data }],
            seq: event.seq,
          };
          continue;
        }
        if (!event.turn || !following.has(event.turn)) continue;
        const chunks: UIMessageChunk[] = [];
        if (event.type === "turn.started") chunks.push({ type: "start-step" });
        else if (event.type === "item.created")
          for await (const chunk of itemChunks(event.data as Item)) chunks.push(chunk);
        else if (TERMINAL.has(event.type)) {
          chunks.push(...flush(event.turn), { type: "finish-step" });
          ended.set(event.turn, event.data as TurnView);
          following.delete(event.turn);
        }
        if (chunks.length) yield { chunks, seq: event.seq };
        if (!following.size) break;
      }
      upToDate = page.up_to_date;
      if (upToDate && !checked && following.size) {
        // A turn that ended before the cursor has nothing more to show.
        checked = true;
        for (const turn of [...following]) {
          const view = await api.getTurn(turn);
          const rest = await api.readEvents(session, { since, limit: PAGE });
          if (
            isTerminal(view.status) &&
            !rest.events.some((e) => e.turn === turn && TERMINAL.has(e.type))
          ) {
            ended.set(turn, view);
            following.delete(turn);
          }
        }
      }
    }
    const views = plan.turns.map((t) => ended.get(t)).filter((v): v is TurnView => !!v);
    const last = views.at(-1);
    const metadata = {
      session,
      turns: views.map((v) => ({
        id: v.id,
        status: v.status,
        ...(v.stop_reason ? { stop_reason: v.stop_reason } : {}),
      })),
    };
    const failed = views.find((v) => v.status === "failed");
    const stopped = views.find((v) => v.status === "cancelled" || v.status === "interrupted");
    if (stopped) yield { chunks: [{ type: "abort", reason: stopped.status }] };
    else if (failed)
      yield {
        chunks: [
          {
            type: "error",
            errorText: failed.error ?? failed.stop_reason?.message ?? "the turn failed",
          },
          { type: "finish", finishReason: "error", messageMetadata: metadata },
        ],
      };
    else
      yield {
        chunks: [
          {
            type: "finish",
            finishReason: last?.status === "waiting" ? "tool-calls" : "stop",
            messageMetadata: metadata,
          },
        ],
      };
  } catch (e) {
    yield { chunks: [{ type: "error", errorText: messageOf(e) }] };
  }
}

/** The chunks of one UI message stream, for a caller in the same process or over RPC. */
export function uiMessageChunks(
  api: UiStreamApi,
  session: string,
  plan: UiStreamPlan,
  options: { keepAliveMs?: number; signal?: AbortSignal } = {},
): ReadableStream<UIMessageChunk> {
  const frames = uiMessageFrames(api, session, plan, options);
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        if (options.signal?.aborted) {
          await frames.return(undefined);
          controller.close();
          return;
        }
        const next = await frames.next();
        if (next.done) {
          controller.close();
          return;
        }
        if ("chunks" in next.value && next.value.chunks.length) {
          for (const chunk of next.value.chunks) controller.enqueue(chunk);
          return;
        }
      }
    },
    async cancel() {
      await frames.return(undefined);
    },
  });
}

/**
 * The SSE response of one UI message stream: each chunk as `data:`, a keep-alive comment when
 * idle, then `data: [DONE]`. The chunks of one log event are written at once, and only the last
 * carries the event's offset as `id`: a client resuming with its `Last-Event-ID` gets every event
 * after the last one it saw whole.
 */
export function uiMessageStreamResponse(
  api: UiStreamApi,
  session: string,
  plan: UiStreamPlan,
  options: { keepAliveMs?: number } = {},
): Response {
  const frames = uiMessageFrames(api, session, plan, options);
  const encoder = new TextEncoder();
  let done = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      const next = await frames.next();
      if (next.done) {
        done = true;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const frame = next.value;
      if ("idle" in frame) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      else
        controller.enqueue(
          encoder.encode(
            frame.chunks
              .map(
                (chunk, i) =>
                  `${frame.seq !== undefined && i === frame.chunks.length - 1 ? `id: ${frame.seq}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`,
              )
              .join(""),
          ),
        );
    },
    async cancel() {
      done = true;
      await frames.return(undefined);
    },
  });
  return new Response(body, { status: 200, headers: UI_MESSAGE_STREAM_HEADERS });
}

/**
 * The AI SDK's `ChatTransport` on one agent session, over the session API's methods: for callers
 * in the same process or over RPC (`useChat({ transport })`), the same stream REST serves at
 * `/v1/sessions/<id>/chat`. `body` may carry `delivery` and `model`.
 */
export function sessionChatTransport(
  api: UiStreamApi,
  session: string,
  options: { keepAliveMs?: number } = {},
): ChatTransportLike {
  return {
    async sendMessages({ trigger, messages, messageId, abortSignal, body }) {
      const plan = await chatPlan(api, session, {
        ...(body as ChatRequestBody | undefined),
        trigger,
        messages,
        ...(messageId ? { messageId } : {}),
      });
      return uiMessageChunks(api, session, plan, {
        ...options,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
    },
    async reconnectToStream({ abortSignal }) {
      const plan = await resumePlan(api, session);
      if (!plan) return null;
      return uiMessageChunks(api, session, plan, {
        ...options,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
    },
  };
}
