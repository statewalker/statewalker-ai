import { codedError, fromBase64, verifyAccessToken } from "@statewalker/ai-access";
import type { AgentSession } from "./agent-session-do.js";
import type { Issuer } from "./issuer-do.js";
import type { Profiles } from "./profiles-do.js";
import type { User } from "./user-do.js";
import type { Workspace } from "./workspace-do.js";

/** The deployment's bindings and vars (wrangler.jsonc). */
export interface Env {
  ISSUER: DurableObjectNamespace<Issuer>;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  USER: DurableObjectNamespace<User>;
  PROFILES: DurableObjectNamespace<Profiles>;
  AGENT: DurableObjectNamespace<AgentSession>;
  /** The workspaces this deployment serves, comma-separated; the first is the default. */
  WORKSPACES?: string;
  /**
   * The role sources, comma-separated, asked in order: "file" (each project's access file, the
   * default), "sql" (the workspace's SQL). Each project is answered by the first that knows it.
   */
  ROLE_SOURCES?: string;
  /** Each workspace's store: "sql" (the default), "memory", "local" or "s3" (./workspace-store.ts). */
  WORKSPACE_BACKEND?: string;
  /** "local": the folder holding one folder per workspace. */
  WORKSPACE_ROOT?: string;
  /** "s3": the bucket, and optionally the endpoint, region and key prefix. */
  WORKSPACE_S3_BUCKET?: string;
  WORKSPACE_S3_ENDPOINT?: string;
  WORKSPACE_S3_REGION?: string;
  WORKSPACE_S3_PREFIX?: string;
  /** "s3": its keys, set as secrets. */
  WORKSPACE_S3_ACCESS_KEY_ID?: string;
  WORKSPACE_S3_SECRET_ACCESS_KEY?: string;
  /** The workspace's default ignore rules for agent sessions, in gitignore syntax. */
  IGNORE?: string;
  /** Bytes per block of a file stream (default 1 MiB). */
  FILE_BLOCK_SIZE?: string;
  /** The profiles file system's backend: "sql" (the default) or "memory". */
  PROFILES_BACKEND?: string;
  TOKEN_TTL_MS?: string;
  /** The OpenAI-compatible model every agent uses, until the model gateway (a later ticket). */
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  /**
   * The deployment's key for workspace, project and user secrets (a runtime secret). Without it
   * the deployment keeps no secrets below deployment level.
   */
  SECRETS_KEY?: string;
  /**
   * The deployment secrets: JSON `{"NAME": {"plugins": [...], "hosts": [...]}}` naming runtime
   * variables (Worker secrets, `.dev.vars`, the Node environment) and their bindings.
   */
  DEPLOYMENT_SECRETS?: string;
  /**
   * Test-only, until tool definitions (statewalker/statewalker-root#129): JSON REST tools offered
   * to every agent, `[{plugin, name, method?, url, headers?, query?}]`, called through the gateway.
   */
  REST_TOOLS?: string;
  /** Test-only: the SSE keep-alive interval in ms (30 s otherwise). */
  SSE_KEEPALIVE_MS?: string;
  /** Test-only: enables POST /v1/login, which stands in for an identity provider. */
  DEV_LOGIN?: string;
  /** Test-only: enables the /admin/* routes with this bearer key. */
  ADMIN_KEY?: string;
}

/** Bytes per block of every file stream in the deployment. */
export function blockSizeOf(env: Env): number {
  const n = Number(env.FILE_BLOCK_SIZE);
  return Number.isInteger(n) && n > 0 ? n : 1024 * 1024;
}

export const workspacesOf = (env: Env): string[] =>
  (env.WORKSPACES || "default")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);

export const defaultWorkspace = (env: Env): string => workspacesOf(env)[0] ?? "default";

export const issuerOf = (env: Env) => env.ISSUER.get(env.ISSUER.idFromName("issuer"));

export const workspaceOf = (env: Env, name: string) =>
  env.WORKSPACE.get(env.WORKSPACE.idFromName(name));

export const userOf = (env: Env, user: string) => env.USER.get(env.USER.idFromName(user));

/** The deployment's one profiles file system. */
export const profilesOf = (env: Env) => env.PROFILES.get(env.PROFILES.idFromName("profiles"));

export const agentOf = (env: Env, id: string) => env.AGENT.get(env.AGENT.idFromName(id));

const issuerKeys = new WeakMap<Env, Promise<Uint8Array>>();

/** The claims of a valid access token for a workspace this deployment serves; EAUTH otherwise. */
export function verifyToken(env: Env, token: string) {
  let key = issuerKeys.get(env);
  if (!key) {
    key = issuerOf(env)
      .publicKey()
      .then((k) => fromBase64(k));
    key.catch(() => issuerKeys.delete(env));
    issuerKeys.set(env, key);
  }
  return key.then((k) => verifyAccessToken(token, k, { workspace: workspacesOf(env) }));
}

/** The name a Durable Object was reached by (`idFromName`): its workspace, or its user. */
export function nameOf(ctx: DurableObjectState): string {
  const name = (ctx.id as { name?: string }).name;
  if (!name) throw codedError("EIO", "this Durable Object was not reached by name");
  return name;
}
