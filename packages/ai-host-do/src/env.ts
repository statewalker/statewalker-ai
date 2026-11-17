import type { Issuer } from "./issuer-do.js";
import type { Workspace } from "./workspace-do.js";

/** The deployment's bindings and vars (wrangler.jsonc). */
export interface Env {
  ISSUER: DurableObjectNamespace<Issuer>;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  WORKSPACE_NAME?: string;
  TOKEN_TTL_MS?: string;
  /** Test-only: enables POST /v1/login, which stands in for an identity provider. */
  DEV_LOGIN?: string;
  /** Test-only: enables POST /admin/seed with this bearer key. */
  ADMIN_KEY?: string;
}

export const workspaceName = (env: Env): string => env.WORKSPACE_NAME || "default";

export const issuerOf = (env: Env) => env.ISSUER.get(env.ISSUER.idFromName("issuer"));

export const workspaceOf = (env: Env) =>
  env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceName(env)));
