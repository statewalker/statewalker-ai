// REST onto the session API's methods: a thin router. Errors keep their code; the status is
// derived from it (EAUTH 401, EACCES 403, ENOENT 404, EINVAL 400).
import { codedError, statusOf } from "@statewalker/ai-access";
import type { SessionApi } from "./api.js";

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
    if (route === "GET /sessions") return api().listSessions();
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
    if (collection === "sessions" && id && parts.length === 4) {
      if (request.method === "POST" && sub === "revoke") return api().revokeSession(id);
      if (request.method === "POST" && sub === "messages")
        return api().sendMessage(id, (await bodyOf(request)) as never);
      if (request.method === "GET" && sub === "items") return api().listItems(id);
    }
    return NOT_A_ROUTE;
  };
  try {
    const result = await call();
    if (result === NOT_A_ROUTE) return undefined;
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
