// The harness's Worker: the session API over REST, and the test-only routes a conformance run
// enables through vars (see wrangler.jsonc). Every session call goes to the Workspace DO, which
// checks the caller's access token each time.
import { codedError, statusOf } from "@statewalker/ai-access";
import { bearerOf, bodyOf, createSessionApi, handleSessionRest } from "@statewalker/ai-sessions";
import { type Env, issuerOf, workspaceName, workspaceOf } from "./env.js";

export { Issuer } from "./issuer-do.js";
export { Workspace } from "./workspace-do.js";

const json = (value: unknown, status = 200) => Response.json(value, { status });

function sessionApi(env: Env, token: string) {
  const ws = workspaceOf(env);
  return createSessionApi(token, {
    workspace: { openUserSession: (t) => ws.openUserSession(t) },
  });
}

async function devRoutes(request: Request, env: Env, path: string) {
  if (path === "/v1/login" && request.method === "POST" && env.DEV_LOGIN === "true") {
    // Test-only: stands in for an identity provider, which would prove who the user is.
    const body = await bodyOf(request);
    if (typeof body.user !== "string" || !body.user) throw codedError("EINVAL", "user is required");
    const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : undefined;
    return json(await issuerOf(env).issue(body.user, workspaceName(env), ttlMs));
  }
  if (path === "/admin/seed" && request.method === "POST" && env.ADMIN_KEY) {
    if (bearerOf(request) !== env.ADMIN_KEY) throw codedError("EAUTH", "admin only");
    const body = await bodyOf(request);
    return json({ written: await workspaceOf(env).seed(body.files as Record<string, string>) });
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      const dev = await devRoutes(request, env, path);
      if (dev) return dev;
      const rest = await handleSessionRest(request, (token) => sessionApi(env, token));
      if (rest) return rest;
      return json({ error: "ENOENT: no such route" }, 404);
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, statusOf(e));
    }
  },
};
