// Chat Completions (statewalker/statewalker-root#138, decided in #83): stateless. Each request is
// a fresh agent session on the base URL's agent, started unattended, so "ask" is a deny with a
// reason (as in `dontAsk`) and the agent carries on; the messages sent are its one message (the
// earlier ones as a transcript), and the session is archived once the turn has ended. The answer
// is the turn's assistant text; the agent's own tool calls stay inside it.
import { codedError } from "@statewalker/ai-access";
import type { Item, TurnView } from "@statewalker/ai-sessions";
import {
  type AgentRoute,
  isTerminal,
  messageText,
  type OpenAiApi,
  startRequest,
  textOf,
  waitTurns,
} from "./responses.js";

/** The session metadata Chat Completions sessions carry, to be found later. */
export const CHAT_METADATA = { openai: "chat.completions" } as const;

/** A Chat Completions turn started: its session and turn, read from `since`. */
export interface StartedChat {
  session: string;
  turn: string;
  since: number;
  requestedModel?: string;
}

/** Starts the turn of a Chat Completions request in a fresh, unattended session. */
export async function startChat(
  api: OpenAiApi,
  route: AgentRoute,
  body: Record<string, unknown>,
): Promise<StartedChat> {
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw codedError("EINVAL", "messages is a non-empty list");
  const content = messageText(
    body.messages.map((m) => {
      const message = (m ?? {}) as Record<string, unknown>;
      if (typeof message.role !== "string") throw codedError("EINVAL", "a message has a role");
      return { role: message.role, text: message.content == null ? "" : textOf(message.content) };
    }),
  );
  const requestedModel = typeof body.model === "string" && body.model ? body.model : undefined;
  const session = await api.startSession({
    ...startRequest(route),
    unattended: true,
    metadata: { ...CHAT_METADATA },
  });
  try {
    const accepted = await api.sendMessage(session.id, {
      content,
      ...(requestedModel ? { model: requestedModel } : {}),
    });
    return {
      session: session.id,
      turn: accepted.turn_id,
      since: accepted.offset,
      ...(requestedModel ? { requestedModel } : {}),
    };
  } catch (e) {
    await api.archiveSession(session.id).catch(() => {});
    throw e;
  }
}

const assistantTexts = (items: Item[]) =>
  items.filter((i) => i.kind === "message" && i.role === "assistant" && i.text).map((i) => i.text);

const usageOf = (items: Item[]) => {
  let prompt = 0;
  let completion = 0;
  for (const item of items)
    if (item.usage && item.kind !== "model_fallback") {
      // Cached tokens are among the prompt tokens, as OpenAI counts them.
      prompt += item.usage.input_tokens + item.usage.cached_tokens;
      completion += item.usage.output_tokens;
    }
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
};

const finishOf = (view: TurnView) => (view.status === "incomplete" ? "length" : "stop");

/** A failed or cut turn: the request fails with its reason. */
function refusal(view: TurnView): Error | undefined {
  if (view.status === "failed")
    return codedError("EIO", `the turn failed: ${view.error ?? view.stop_reason?.message ?? ""}`);
  if (view.status === "cancelled" || view.status === "interrupted")
    return codedError("EBUSY", `the turn was ${view.status}`);
  return undefined;
}

/** The `chat.completion` of a started turn, once it has ended; the session is archived. */
export async function chatCompletion(
  api: OpenAiApi,
  started: StartedChat,
): Promise<Record<string, unknown>> {
  try {
    const [view] = (await waitTurns(api, started.session, [started.turn], started.since)) as [
      TurnView,
    ];
    const failed = refusal(view);
    if (failed) throw failed;
    return {
      id: `chatcmpl-${view.id}`,
      object: "chat.completion",
      created: Math.floor(view.created / 1000),
      model: view.model ?? started.requestedModel ?? "",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: assistantTexts(view.items).join("\n\n"),
            refusal: null,
            annotations: [],
          },
          logprobs: null,
          finish_reason: finishOf(view),
        },
      ],
      usage: usageOf(view.items),
    };
  } finally {
    await api.archiveSession(started.session).catch(() => {});
  }
}

/**
 * The `chat.completion.chunk`s of a started turn as its log grows: the role first, each assistant
 * message's text as a delta, then the finish reason (and the usage, if asked for); an `error`
 * object if the turn failed. An idle frame stands for time with nothing new. The session is
 * archived when the stream ends.
 */
export async function* chatChunks(
  api: OpenAiApi,
  started: StartedChat,
  options: { keepAliveMs: number; includeUsage: boolean },
): AsyncGenerator<Record<string, unknown> | { idle: true }> {
  try {
    let view = await api.getTurn(started.turn);
    const id = `chatcmpl-${started.turn}`;
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(view.created / 1000),
      model: view.model ?? started.requestedModel ?? "",
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });
    yield chunk({ role: "assistant", content: "" });
    let since = started.since;
    let upToDate = false;
    let texts = 0;
    for (;;) {
      const page = await api.readEvents(started.session, {
        since,
        limit: 1000,
        wait: upToDate ? options.keepAliveMs : 0,
      });
      if (!page.events.length && upToDate) yield { idle: true };
      let ended = false;
      for (const logged of page.events) {
        since = logged.seq;
        if (logged.turn !== started.turn) continue;
        const item = logged.data as Item;
        if (logged.type === "item.created" && item.kind === "message" && item.role === "assistant")
          if (item.text) yield chunk({ content: `${texts++ ? "\n\n" : ""}${item.text}` });
        if (logged.type.startsWith("turn.") && isTerminal(logged.type.slice(5))) ended = true;
      }
      upToDate = page.up_to_date;
      // A turn that ended after this page was read may have logged its last events meanwhile:
      // they are read before the stream ends, as the next page (without waiting).
      if (!ended && upToDate && isTerminal((await api.getTurn(started.turn)).status)) {
        const rest = await api.readEvents(started.session, { since, limit: 1000 });
        if (rest.events.some((e) => e.turn === started.turn)) upToDate = false;
        else ended = true;
      }
      if (ended) break;
    }
    view = await api.getTurn(started.turn);
    const failed = refusal(view);
    if (failed) {
      yield { error: { message: failed.message, type: "server_error", code: null, param: null } };
      return;
    }
    yield chunk({}, finishOf(view));
    if (options.includeUsage) yield { ...chunk({}), choices: [], usage: usageOf(view.items) };
  } finally {
    await api.archiveSession(started.session).catch(() => {});
  }
}
