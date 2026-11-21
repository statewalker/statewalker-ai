import {
  codedError,
  fromBase64,
  type ModeDefinition,
  type PermissionRules,
  parseModes,
  parseRules,
  verifyAccessToken,
} from "@statewalker/ai-access";
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
  /** The profiles file system's backend: "sql" (the default) or "memory". */
  PROFILES_BACKEND?: string;
  TOKEN_TTL_MS?: string;
  /**
   * The deployment's permission rules, JSON `{allow?, ask?, deny?}` (statewalker/statewalker-root#124);
   * they apply in every workspace, project and mode.
   */
  PERMISSION_RULES?: string;
  /** The deployment's own modes, JSON `{name: definition}`, beside the built-in ones. */
  MODES?: string;
  /** How long a pending approval waits before it counts as denied (default 24 hours). */
  APPROVAL_TTL_MS?: string;
  /** The OpenAI-compatible model every agent uses, until the model gateway (a later ticket). */
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  /** Test-only: enables POST /v1/login, which stands in for an identity provider. */
  DEV_LOGIN?: string;
  /** Test-only: enables the /admin/* routes with this bearer key. */
  ADMIN_KEY?: string;
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

/** The deployment's own modes (problems are reported, and those modes are left out). */
export function deploymentModes(env: Env): Record<string, ModeDefinition> {
  let value: unknown;
  try {
    value = env.MODES ? JSON.parse(env.MODES) : undefined;
  } catch {
    console.warn("MODES is not JSON: no deployment modes");
    return {};
  }
  const { modes, problems } = parseModes(value);
  if (problems.length) console.warn(`MODES: ${problems.join("; ")}`);
  return modes;
}

export const deploymentRules = (env: Env): PermissionRules => parseRules(env.PERMISSION_RULES);

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a pending approval waits (APPROVAL_TTL_MS, default 24 hours). */
export function approvalTtlMs(env: Env): number {
  const ms = Number(env.APPROVAL_TTL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DAY_MS;
}
