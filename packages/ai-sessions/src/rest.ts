// REST onto the session API's methods: a thin router. Errors keep their code; the status is
// derived from it (EAUTH 401, EACCES 403, ENOENT 404, EINVAL 400).
import { codedError, retryAfterOf, statusOf } from "@statewalker/ai-access";
import type { MemoryTarget, SessionApi, SessionsQuery } from "./api.js";
import { eventStream } from "./sse.js";
import { chatPlan, resumePlan, uiMessageStreamResponse } from "./ui-stream.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * An error as REST answers it: its message, the status its code maps to and, for a limit that
 * resets (429), `Retry-After` in seconds (statewalker/statewalker-root#179).
 */
export function errorResponse(e: unknown): Response {
  const status = statusOf(e);
  const retry = status === 429 ? retryAfterOf(e) : undefined;
  return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retry !== undefined ? { "retry-after": String(retry) } : {}),
    },
  });
}

/**
 * Every page of a usage records export as NDJSON, one record per line: the first page given, the
 * next ones read as the stream is pulled (statewalker/statewalker-root#181).
 */
export function ndjsonResponse(
  first: { records: unknown[]; next?: number },
  page: (after: number) => Promise<{ records: unknown[]; next?: number }>,
): Response {
  const encoder = new TextEncoder();
  let current: { records: unknown[]; next?: number } | undefined = first;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!current) {
        controller.close();
        return;
      }
      const lines = current.records.map((r) => `${JSON.stringify(r)}\n`).join("");
      if (lines) controller.enqueue(encoder.encode(lines));
      try {
        current = current.next === undefined ? undefined : await page(current.next);
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

const NOT_A_ROUTE = Symbol("not a route");

/** The bearer token of a request ("" when there is none). */
export const bearerOf = (request: Request): string =>
  /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";

/**
 * Answers a request to the session API's REST routes, or returns undefined when the request is
 * not one of them.
 */
export async function handleSessionRest(
  request: Request,
  open: (token: string) => SessionApi,
  options: { keepAliveMs?: number } = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "v1") return undefined;
  const route = `${request.method} /${parts.slice(1).join("/")}`;
  const api = () => open(bearerOf(request));
  const call = async (): Promise<unknown> => {
    if (route === "GET /me") return api().me();
    if (route === "GET /me/profile") return api().profile();
    if (route === "DELETE /me") return api().eraseUser();
    if (route === "DELETE /me/session") return api().revokeUserSession();
    if (route === "GET /service-accounts") return api().listServiceAccounts();
    if (route === "POST /service-accounts")
      return api().createServiceAccount((await bodyOf(request)) as never);
    if (route === "POST /sessions") return api().startSession((await bodyOf(request)) as never);
    if (route === "GET /sessions") return api().listSessions(sessionsQuery(url));
    if (route === "PUT /me/mode") return api().setMode((await bodyOf(request)) as never);
    if (route === "GET /me/models") return api().getModelConfig();
    if (route === "PUT /me/models") return api().setModelConfig((await bodyOf(request)) as never);
    if (route === "GET /models")
      return api().listModels({
        project: url.searchParams.get("project") ?? "",
        discover: url.searchParams.get("discover") === "true",
      });
    if (route === "GET /limits/effective")
      return api().effectiveLimits({
        project: url.searchParams.get("project") ?? undefined,
        session: url.searchParams.get("session") ?? undefined,
      });
    if (route === "GET /usage/records") {
      const since = url.searchParams.get("since") ?? undefined;
      // The first page is read before answering, so a refusal keeps its status.
      const first = await api().usageRecords({ since } as never);
      return ndjsonResponse(first, (after) => api().usageRecords({ since, after } as never));
    }
    if (route === "GET /usage")
      return api().usage({
        level: url.searchParams.get("level") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        period: url.searchParams.get("period") ?? undefined,
        group_by: url.searchParams.get("group_by") ?? undefined,
      } as never);
    if (parts[1] === "limits" && parts.length === 4 && parts[2] !== "effective") {
      const [, , level, target] = parts as [string, string, string, string];
      if (request.method === "GET") return api().getLimits(level, target);
      if (request.method === "PUT")
        return api().setLimits(level, target, (await bodyOf(request)) as never);
      if (request.method === "DELETE") return api().deleteLimits(level, target);
    }
    if (route === "GET /approvals") return api().listApprovals();
    if (request.method === "POST" && parts[1] === "approvals" && parts[2] && parts.length === 3)
      return api().answerApproval(parts[2], (await bodyOf(request)) as never);
    if (route === "GET /secrets")
      return api().listSecrets({
        level: url.searchParams.get("level") ?? "",
        project: url.searchParams.get("project") ?? undefined,
      } as never);
    if (route === "GET /me/profile/export")
      return new Response((await api().exportProfile()) as Uint8Array<ArrayBuffer>, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="profile.zip"',
        },
      });
    if (route === "DELETE /me/profile") return api().eraseProfile();
    const memory = memoryRoute(parts);
    if (memory) {
      const { target, rest } = memory;
      const [what, name] = rest;
      if (rest.length === 1 && what === "agents" && target === "agents" && request.method === "GET")
        return api().listAgentMemories(memory.project as string);
      if (
        typeof target !== "string" &&
        (rest.length === 0 || (rest.length === 1 && what === "entries"))
      ) {
        if (request.method === "GET") return api().listMemory(target);
        if (request.method === "POST") {
          const body = await bodyOf(request);
          return api().memoryBatch(target, body.actions as never);
        }
      }
      if (typeof target !== "string" && rest.length === 2 && name) {
        if (what === "entries" && request.method === "GET") return api().memoryEntry(target, name);
        if (what === "entries" && request.method === "DELETE")
          return api().eraseMemory(target, { id: name });
        if (what === "files" && request.method === "GET") return api().memoryFile(target, name);
        if (what === "files" && request.method === "DELETE")
          return api().eraseMemory(target, { name });
      }
    }
    const [, collection, id, sub] = parts;
    if (collection === "secrets" && id && sub && parts.length === 4) {
      const project = url.searchParams.get("project") ?? undefined;
      if (request.method === "PUT")
        return api().setSecret({ ...(await bodyOf(request)), level: id, name: sub } as never);
      if (request.method === "DELETE")
        return api().deleteSecret({ level: id, name: sub, project } as never);
    }
    if (
      collection === "service-accounts" &&
      id &&
      parts.length === 3 &&
      request.method === "DELETE"
    )
      return api().deleteServiceAccount(id);
    if (collection === "sessions" && id && parts.length === 3) {
      if (request.method === "GET") return api().getSession(id);
      if (request.method === "PATCH")
        return api().updateSession(id, (await bodyOf(request)) as never);
      if (request.method === "DELETE") return api().deleteSession(id);
    }
    if (collection === "sessions" && id && parts.length === 4) {
      if (request.method === "POST" && sub === "messages") {
        const accepted = await api().sendMessage(id, (await bodyOf(request)) as never);
        return new Response(JSON.stringify(accepted), {
          status: 202,
          headers: {
            "content-type": "application/json",
            location: `/v1/turns/${encodeURIComponent(accepted.turn_id)}`,
            "stream-next-offset": String(accepted.offset),
          },
        });
      }
      if (request.method === "POST" && sub === "mcp") {
        // MCP over Streamable HTTP, answered with JSON: a notification is accepted (202).
        const answered = await api().mcp(id, (await bodyOf(request)) as never);
        return answered === null ? new Response(null, { status: 202 }) : json(answered);
      }
      if (request.method === "POST" && sub === "revoke") return api().revokeSession(id);
      // The turn tree (statewalker/statewalker-root#190).
      if (request.method === "POST" && sub === "rewind")
        return api().rewind(id, (await bodyOf(request)) as never);
      if (request.method === "PUT" && sub === "head")
        return api().setHead(id, (await bodyOf(request)) as never);
      if (request.method === "GET" && sub === "branches") return api().listBranches(id);
      if (request.method === "POST" && sub === "fork") {
        const forked = await api().forkSession(id, (await bodyOf(request)) as never);
        return new Response(JSON.stringify(forked), {
          status: 201,
          headers: {
            "content-type": "application/json",
            location: `/v1/sessions/${encodeURIComponent(forked.session.id)}`,
          },
        });
      }
      if (request.method === "POST" && sub === "archive") return api().archiveSession(id);
      if (request.method === "GET" && sub === "items") return api().listItems(id, itemsQuery(url));
      if (request.method === "GET" && sub === "events") {
        const lastEventId = request.headers.get("last-event-id");
        return eventStream(api(), id, {
          // A reconnecting EventSource repeats the URL: its Last-Event-ID wins over `since`.
          since: Number(lastEventId ?? url.searchParams.get("since") ?? 0),
          turn: url.searchParams.get("turn") ?? undefined,
          keepAliveMs: options.keepAliveMs,
        });
      }
    }
    // The AI SDK UI message stream: `useChat` posts to /chat and resumes at /chat/<chat id>/stream
    // (the session in the path is the one followed; the chat id is the UI's).
    if (collection === "sessions" && id && sub === "chat") {
      if (request.method === "POST" && parts.length === 4) {
        const plan = await chatPlan(api(), id, (await bodyOf(request)) as never);
        return uiMessageStreamResponse(api(), id, plan, { keepAliveMs: options.keepAliveMs });
      }
      if (
        request.method === "GET" &&
        parts.at(-1) === "stream" &&
        (parts.length === 5 || parts.length === 6)
      ) {
        const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("since");
        const turn = url.searchParams.get("turn");
        const plan = await resumePlan(api(), id, {
          ...(turn ? { turn } : {}),
          ...(cursor !== null && cursor !== "" ? { since: Number(cursor) } : {}),
        });
        if (!plan) return new Response(null, { status: 204 });
        return uiMessageStreamResponse(api(), id, plan, { keepAliveMs: options.keepAliveMs });
      }
    }
    if (collection === "sessions" && id && sub === "items" && parts.length === 5)
      if (request.method === "GET") return api().getItem(id, String(parts[4]));
    if (collection === "sessions" && id && sub === "branches" && parts.length === 5)
      if (request.method === "DELETE") return api().eraseBranch(id, String(parts[4]));
    if (collection === "turns" && id) {
      if (request.method === "GET" && parts.length === 3) return api().getTurn(id);
      if (request.method === "POST" && sub === "cancel" && parts.length === 4)
        return api().cancelTurn(id);
      if (
        request.method === "POST" &&
        (sub === "edit" || sub === "regenerate") &&
        parts.length === 4
      ) {
        const body = (await bodyOf(request)) as never;
        const accepted =
          sub === "edit" ? await api().editTurn(id, body) : await api().regenerateTurn(id, body);
        return new Response(JSON.stringify(accepted), {
          status: 202,
          headers: {
            "content-type": "application/json",
            location: `/v1/turns/${encodeURIComponent(accepted.turn_id)}`,
            "stream-next-offset": String(accepted.offset),
          },
        });
      }
    }
    return NOT_A_ROUTE;
  };
  try {
    const result = await call();
    if (result === NOT_A_ROUTE) return undefined;
    if (result instanceof Response) return result;
    return json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * A memory route (statewalker/statewalker-root#157): `/v1/me/preferences[/…]`,
 * `/v1/projects/{p}/memory/agents` and `/v1/projects/{p}/memory/{kind}[/…]`, where an agent's
 * kind `agent:<plugin>/<agent>` may span two segments or be one with its slash encoded.
 */
function memoryRoute(
  parts: string[],
): { target: MemoryTarget | "agents"; project?: string; rest: string[] } | undefined {
  if (parts[1] === "me" && parts[2] === "preferences")
    return { target: { kind: "preferences" }, rest: parts.slice(3) };
  if (parts[1] !== "projects" || !parts[2] || parts[3] !== "memory" || !parts[4]) return undefined;
  const project = parts[2];
  if (parts[4] === "agents" && parts.length === 5)
    return { target: "agents", project, rest: ["agents"] };
  if (parts[4].startsWith("agent:") && !parts[4].includes("/"))
    return {
      target: { project, kind: `${parts[4]}/${parts[5] ?? ""}` },
      rest: parts.slice(6),
    };
  return { target: { project, kind: parts[4] }, rest: parts.slice(5) };
}

/** The body of a request as an object; EINVAL when it is not JSON. */
export async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // falls through
  }
  throw codedError("EINVAL", "the request body is not a JSON object");
}

/** `?after=&before=&limit=&order=&types[]=` (or `types=a,b`), `&branch=<turn>` or `&all=true`. */
function itemsQuery(url: URL) {
  const p = url.searchParams;
  const types = [...p.getAll("types[]"), ...p.getAll("types").flatMap((t) => t.split(","))].filter(
    Boolean,
  );
  return {
    ...(p.get("after") ? { after: p.get("after") as string } : {}),
    ...(p.get("before") ? { before: p.get("before") as string } : {}),
    ...(p.get("limit") ? { limit: Number(p.get("limit")) } : {}),
    ...(p.get("order") ? { order: p.get("order") as "asc" } : {}),
    ...(types.length ? { types: types as never } : {}),
    ...(p.get("branch") ? { branch: p.get("branch") as string } : {}),
    ...(p.get("all") === "true" ? { all: true } : {}),
  };
}

/** `?status=&metadata.<key>=<value>`. */
function sessionsQuery(url: URL): SessionsQuery {
  const metadata: Record<string, string> = {};
  for (const [k, v] of url.searchParams)
    if (k.startsWith("metadata.")) metadata[k.slice("metadata.".length)] = v;
  const status = url.searchParams.get("status");
  return {
    ...(status ? { status: status as never } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}
