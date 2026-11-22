// The UHP projection's routes (statewalker/statewalker-root#139, decided in #108): UHP class Core
// plus `input_requests`, pinned to UHP `2026-10-19` at a recorded spec commit, a thin router onto
// the session API's methods. A deployment serves it under a base path (`/uhp`: UHP's paths start
// at `/v1/...`, beside the session API's own); REST serves it with the caller's token, and
// `uhpFetch` runs the same router in the caller's process over any session API (RPC included).
// Every answer carries `UHP-Version`; a request naming another version is refused.

import { isTerminal, sseResponse } from "@statewalker/ai-openai-compat";
import { bearerOf, bodyOf, type SessionApi } from "@statewalker/ai-sessions";
import { errorResponse, toUhpError, type UhpError, uhpError } from "./errors.js";
import {
  findHarness,
  harnessModels,
  harnessView,
  listHarnesses,
  modelCatalog,
} from "./harnesses.js";
import {
  createTask,
  inputItems,
  readSession,
  readTurn,
  responseOf,
  sessionDetail,
  type UhpApi,
  waitTurn,
} from "./responses.js";
import { taskEvents } from "./stream.js";

/** The UHP version served: the only one (each new date version is a deliberate change). */
export const UHP_VERSION = "2026-10-19";
/** The HarnessRouter repository commit whose `2026-10-19` spec, schema and suite this follows. */
export const UHP_SPEC_COMMIT = "300dc9da9baa8f1f6eb98090075e5c4482ca44d0";
/** Where a deployment serves the projection. */
export const UHP_BASE_PATH = "/uhp";

const DEFAULT_KEEP_ALIVE_MS = 30_000;

export interface UhpOptions {
  /** The base path the routes are under (`/uhp`). */
  basePath?: string;
  /** How long a stream stays silent before a keep-alive comment (30 s). */
  keepAliveMs?: number;
}

/** The discovery document (Lifecycle §2): nothing in it is the caller's. */
export const DISCOVERY = {
  object: "uhp.discovery",
  protocol: "uhp",
  versions: [UHP_VERSION],
  default_version: UHP_VERSION,
  conformance_class: "core",
  capabilities: {
    streaming: true,
    sessions: true,
    cancellation: true,
    files_input: false,
    files_output: false,
    session_listing: false,
    harness_management: false,
    harness_retirement: false,
    input_history: false,
    input_requests: true,
    resume: false,
    session_sharing: false,
    // A branch is a fork carrying its first message, but files are not restored into it
    // (statewalker/statewalker-root#159): not declared until they are.
    session_branching: false,
    idempotency: false,
    harness_idempotency: false,
    plugins: false,
    environments: false,
    // Memory stays native (statewalker/statewalker-root#157).
    memories: false,
  },
  implementation: {
    name: "StateWalker AI harness",
    spec: "https://github.com/HarnessRouter/harnessrouter/tree/main/protocol/versions/2026-10-19",
    spec_commit: UHP_SPEC_COMMIT,
  },
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "uhp-version": UHP_VERSION },
  });

/** The route a path names under the base path; undefined for another path. */
function segmentsOf(pathname: string, basePath: string): string[] | undefined {
  const base = basePath.replace(/\/+$/, "");
  if (base && pathname !== base && !pathname.startsWith(`${base}/`)) return undefined;
  const parts = pathname
    .slice(base.length)
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  return parts[0] === "v1" ? parts.slice(1) : undefined;
}

/**
 * Answers a request to the UHP projection's routes, or returns undefined when the request is not
 * one (another route of the deployment).
 */
export async function handleUhpRest(
  request: Request,
  open: (token: string) => UhpApi | SessionApi,
  options: UhpOptions = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const rest = segmentsOf(url.pathname, options.basePath ?? UHP_BASE_PATH);
  if (!rest) return undefined;
  const method = request.method;
  const keepAliveMs = options.keepAliveMs || DEFAULT_KEEP_ALIVE_MS;
  try {
    const asked = request.headers.get("uhp-version");
    if (asked && asked !== UHP_VERSION)
      throw uhpError(400, "unsupported_protocol_version", `UHP ${asked} is not served here`, {
        detail: { supported: [UHP_VERSION] },
      });
    const [collection, id, sub] = rest;
    if (collection === "uhp" && rest.length === 1 && method === "GET") return json(DISCOVERY);
    const token = bearerOf(request);
    if (!token) throw uhpError(401, "missing_credential", "no bearer token");
    const api = open(token) as UhpApi;
    if (collection === "harnesses" && method === "GET") {
      if (rest.length === 1)
        return json({
          object: "list",
          harnesses: (await listHarnesses(api)).map(harnessView),
        });
      if (id && rest.length === 2) return json(harnessView(await findHarness(api, id)));
      if (id && sub === "models" && rest.length === 3)
        return json(await harnessModels(api, await findHarness(api, id)));
    }
    if (collection === "models" && rest.length === 1 && method === "GET")
      return json(await modelCatalog(api));
    if (collection === "responses") {
      if (rest.length === 1 && method === "POST") {
        const body = await bodyOf(request).catch(() => {
          throw uhpError(400, "invalid_input", "the request body is not a JSON object");
        });
        const task = await createTask(api, body);
        if (body.stream === true)
          return withVersion(sseResponse(taskEvents(api, task, { keepAliveMs }), { named: true }));
        const view =
          body.background === true ? await api.getTurn(task.turn) : await waitTurn(api, task);
        return json(await responseOf(api, task.session, view, task.context));
      }
      if (id && rest.length === 2) {
        const { session, view } = await readTurn(api, id);
        if (method === "GET") return json(await responseOf(api, session, view));
        if (method === "DELETE")
          throw uhpError(
            409,
            "statewalker_response_kept",
            "a response is a turn of its session, which keeps its history",
          );
      }
      if (id && sub === "cancel" && rest.length === 3 && method === "POST") {
        const { session, view } = await readTurn(api, id);
        // Cancelling a task that ended changes nothing (Sessions §4).
        const after = isTerminal(view.status)
          ? view
          : await api.cancelTurn(view.id).catch(() => api.getTurn(view.id));
        return json(await responseOf(api, session, after));
      }
      if (id && sub === "input_items" && rest.length === 3 && method === "GET") {
        const { view } = await readTurn(api, id);
        const data = inputItems(view);
        return json({
          object: "list",
          data,
          first_id: data[0]?.id ?? null,
          last_id: data.at(-1)?.id ?? null,
          has_more: false,
        });
      }
    }
    if (collection === "sessions" && id) {
      const session = await readSession(api, id);
      if (rest.length === 2 && method === "GET") return json(await sessionDetail(api, session));
      if (sub === "cancel" && rest.length === 3 && method === "POST") {
        // Whatever runs in the session: its running turn (UHP never queues one).
        const { turns } = await api.listBranches(session.id);
        for (const turn of turns)
          if (turn.status === "running" || turn.status === "queued")
            await api.cancelTurn(turn.id).catch(() => {});
        return json({ id: session.id, object: "session", status: "cancelled" });
      }
    }
    throw uhpError(404, "statewalker_no_route", `no such route: ${method} /v1/${rest.join("/")}`);
  } catch (e) {
    return errorResponse(toUhpError(e) as UhpError, UHP_VERSION);
  }
}

/** A response with the version header. */
function withVersion(res: Response): Response {
  res.headers.set("uhp-version", UHP_VERSION);
  return res;
}

/**
 * A UHP client's `fetch` that answers in this process over a session API (an RPC client, or the
 * API itself): the same router REST serves, with the API's own caller. Any other URL is 404.
 */
export function uhpFetch(
  api: UhpApi | SessionApi,
  options: UhpOptions = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return (
      (await handleUhpRest(request, () => api, options)) ??
      errorResponse(uhpError(404, "statewalker_no_route", "not a UHP route"), UHP_VERSION)
    );
  };
}
