// The OpenAI projection's routes (statewalker/statewalker-root#138): an agent's base URL
// `/v1/projects/<project>/agents/<agent>/` serves `responses`, `conversations`,
// `chat/completions` and `models`, a thin router onto the session API's methods. The agent is
// `<plugin>/<agent>` (two segments, or one with its slash encoded) or `default` (the project's
// default agent). REST serves it with the caller's token; `openAiFetch` runs the same router in the
// caller's process over any session API (RPC included), as an OpenAI client's `fetch`.
import { codedError, retryAfterOf, statusOf } from "@statewalker/ai-access";
import { bearerOf, bodyOf, type SessionApi } from "@statewalker/ai-sessions";
import { chatChunks, chatCompletion, startChat } from "./chat.js";
import {
  type AgentRoute,
  conversationItems,
  conversationOf,
  conversationView,
  createdResponse,
  createResponse,
  DEFAULT_AGENT,
  inputItems,
  listPage,
  type OpenAiApi,
  readResponse,
  responseEvents,
  responseOf,
  startRequest,
} from "./responses.js";

const DEFAULT_KEEP_ALIVE_MS = 30_000;

export interface OpenAiOptions {
  /** How long a stream stays silent before a keep-alive comment (30 s). */
  keepAliveMs?: number;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  405: "invalid_request_error",
  409: "invalid_request_error",
  429: "rate_limit_error",
};

/** An error as OpenAI clients read it: `{error: {message, type, code, param}}`. */
export function openAiError(e: unknown, status = statusOf(e)): Response {
  const message = String((e as Error)?.message ?? e);
  const retry = status === 429 ? retryAfterOf(e) : undefined;
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: ERROR_TYPES[status] ?? "server_error",
        code: /^(E[A-Z]+):/.exec(message)?.[1] ?? null,
        param: null,
      },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...(retry !== undefined ? { "retry-after": String(retry) } : {}),
        ...(status === 405 ? { allow: "GET" } : {}),
      },
    },
  );
}

/** Items and responses stay: a conversation keeps its history (rewind instead, natively). */
const neverDeleted = (what: string) =>
  openAiError(
    codedError("EINVAL", `${what} are never deleted: the agent session keeps its history`),
    405,
  );

/** An SSE response of a stream of events (`data:` JSON, `event:` its type unless `plain`). */
function sse(
  frames: AsyncGenerator<Record<string, unknown> | { idle: true }>,
  options: { done?: boolean; named?: boolean } = {},
): Response {
  const encoder = new TextEncoder();
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      let next: IteratorResult<Record<string, unknown> | { idle: true }>;
      try {
        next = await frames.next();
      } catch (e) {
        // A refused read (an expired token): an error event ends the stream.
        const message = String((e as Error)?.message ?? e);
        const error = { type: "error", code: statusOf(e), message, param: null };
        controller.enqueue(
          encoder.encode(
            `${options.named ? "event: error\n" : ""}data: ${JSON.stringify(options.named ? error : { error })}\n\n`,
          ),
        );
        finished = true;
        controller.close();
        return;
      }
      if (next.done) {
        finished = true;
        if (options.done) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const frame = next.value;
      if ("idle" in frame) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      else
        controller.enqueue(
          encoder.encode(
            `${options.named && typeof frame.type === "string" ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`,
          ),
        );
    },
    async cancel() {
      finished = true;
      await frames.return(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

/** The agent a path names under `/v1/projects/<p>/agents/`, and the endpoint's segments after it. */
function routeOf(pathname: string): { route: AgentRoute; rest: string[] } | undefined {
  const raw = pathname.split("/").filter(Boolean);
  if (raw[0] !== "v1" || raw[1] !== "projects" || !raw[2] || raw[3] !== "agents" || !raw[4])
    return undefined;
  const parts = raw.map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const project = parts[2] as string;
  const first = parts[4] as string;
  if (first.includes("/") || first === DEFAULT_AGENT)
    return { route: { project, agent: first }, rest: parts.slice(5) };
  if (!parts[5]) return undefined;
  return { route: { project, agent: `${first}/${parts[5]}` }, rest: parts.slice(6) };
}

/**
 * Answers a request to an agent's OpenAI base URL, or returns undefined when the request is not
 * one (another route of the deployment).
 */
export async function handleOpenAiRest(
  request: Request,
  open: (token: string) => OpenAiApi | SessionApi,
  options: OpenAiOptions = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const routed = routeOf(url.pathname);
  if (!routed) return undefined;
  const { route, rest } = routed;
  const endpoint = rest.join("/");
  const method = request.method;
  const keepAliveMs = options.keepAliveMs || DEFAULT_KEEP_ALIVE_MS;
  const api = () => open(bearerOf(request)) as OpenAiApi;
  const q = url.searchParams;
  try {
    const [collection, id, sub, subId] = rest;
    if (endpoint === "models" && method === "GET") {
      const { models } = await api().listModels({ project: route.project });
      return json({
        object: "list",
        data: models.filter((m) => m.allowed && m.enabled).map(modelView),
      });
    }
    if (collection === "models" && rest.length > 1 && method === "GET") {
      const name = rest.slice(1).join("/");
      const { models } = await api().listModels({ project: route.project });
      const found = models.find(
        (m) => m.allowed && m.enabled && (m.id === name || m.aliases.includes(name)),
      );
      if (!found) throw codedError("ENOENT", `no model ${name}`);
      return json(modelView(found));
    }
    if (endpoint === "chat/completions" && method === "POST") {
      const body = await bodyOf(request);
      const started = await startChat(api(), route, body);
      if (body.stream === true)
        return sse(
          chatChunks(api(), started, {
            keepAliveMs,
            includeUsage:
              (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage ===
              true,
          }),
          { done: true },
        );
      return json(await chatCompletion(api(), started));
    }
    if (collection === "responses") {
      if (rest.length === 1 && method === "POST") {
        const body = await bodyOf(request);
        const created = await createResponse(api(), route, body);
        if (body.stream === true)
          return sse(responseEvents(api(), created, { keepAliveMs }), { named: true });
        return json(await createdResponse(api(), created, body.background !== true));
      }
      if (id && rest.length === 2) {
        if (method === "DELETE") {
          // Refused, once the caller may see the response at all.
          await readResponse(api(), route, id);
          return neverDeleted("responses");
        }
        if (method === "GET") {
          const { session, view } = await readResponse(api(), route, id);
          return json(await responseOf(api(), session, [view]));
        }
      }
      if (id && sub === "cancel" && rest.length === 3 && method === "POST") {
        const { session } = await readResponse(api(), route, id);
        const view = await api().cancelTurn(id);
        return json(await responseOf(api(), session, [view]));
      }
      if (id && sub === "input_items" && rest.length === 3 && method === "GET") {
        const { session, view } = await readResponse(api(), route, id);
        const items = await inputItems(api(), session, [view]);
        return json(listPage(items, pageQuery(q)));
      }
    }
    if (collection === "conversations") {
      if (rest.length === 1 && method === "POST") {
        const body = await bodyOf(request);
        if (Array.isArray(body.items) && body.items.length)
          throw codedError(
            "EINVAL",
            "a conversation's items come from its responses: create it empty, then a response",
          );
        const session = await api().startSession({
          ...startRequest(route),
          ...(body.metadata && typeof body.metadata === "object"
            ? { metadata: body.metadata as Record<string, string> }
            : {}),
        });
        return json(conversationView(session));
      }
      if (id && rest.length === 2) {
        const session = await conversationOf(api(), route, id);
        if (method === "GET") return json(conversationView(session));
        if (method === "POST") {
          const body = await bodyOf(request);
          return json(
            conversationView(
              await api().updateSession(session.id, {
                metadata: (body.metadata ?? {}) as Record<string, string>,
              }),
            ),
          );
        }
        if (method === "DELETE") {
          await api().deleteSession(session.id);
          return json({ id: session.id, object: "conversation.deleted", deleted: true });
        }
      }
      if (id && sub === "items") {
        const session = await conversationOf(api(), route, id);
        if (rest.length === 3 && method === "GET")
          return json(listPage(await conversationItems(api(), session), pageQuery(q)));
        if (rest.length === 3 && method === "POST")
          throw codedError(
            "EINVAL",
            "a conversation's items come from its responses: create a response instead",
          );
        if (subId && rest.length === 4) {
          if (method === "DELETE") return neverDeleted("conversation items");
          if (method === "GET") {
            const found = (await conversationItems(api(), session)).find((i) => i.id === subId);
            if (!found) throw codedError("ENOENT", "no such item in the conversation");
            return json(found);
          }
        }
      }
    }
    throw codedError("ENOENT", `no such route: ${method} ${endpoint}`);
  } catch (e) {
    return openAiError(e);
  }
}

const pageQuery = (q: URLSearchParams) => ({
  after: q.get("after"),
  limit: q.get("limit"),
  order: q.get("order"),
});

const modelView = (m: { id: string; provider: string }) => ({
  id: m.id,
  object: "model",
  created: 0,
  owned_by: m.provider,
});

/**
 * An OpenAI client's `fetch` that answers in this process over a session API (an RPC client, or
 * the API itself): the same router REST serves, with the API's own caller. Any other URL is 404.
 */
export function openAiFetch(
  api: OpenAiApi | SessionApi,
  options: OpenAiOptions = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return (
      (await handleOpenAiRest(request, () => api, options)) ??
      openAiError(codedError("ENOENT", "not an agent's OpenAI base URL"))
    );
  };
}
