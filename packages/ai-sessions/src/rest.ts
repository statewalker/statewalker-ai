// REST onto the session API's methods: a thin router. Errors keep their code; the status is
// derived from it (EAUTH 401, EACCES 403, ENOENT 404, EINVAL 400).
import { codedError, statusOf } from "@statewalker/ai-access";
import type { SessionApi, SessionsQuery } from "./api.js";
import { eventStream } from "./sse.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

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
    if (route === "GET /secrets")
      return api().listSecrets({
        level: url.searchParams.get("level") ?? "",
        project: url.searchParams.get("project") ?? undefined,
      } as never);
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
      if (request.method === "POST" && sub === "revoke") return api().revokeSession(id);
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
    if (collection === "sessions" && id && sub === "items" && parts.length === 5)
      if (request.method === "GET") return api().getItem(id, String(parts[4]));
    if (collection === "turns" && id) {
      if (request.method === "GET" && parts.length === 3) return api().getTurn(id);
      if (request.method === "POST" && sub === "cancel" && parts.length === 4)
        return api().cancelTurn(id);
    }
    return NOT_A_ROUTE;
  };
  try {
    const result = await call();
    if (result === NOT_A_ROUTE) return undefined;
    if (result instanceof Response) return result;
    return json(result);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, statusOf(e));
  }
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

/** `?after=&before=&limit=&order=&types[]=` (or `types=a,b`). */
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
