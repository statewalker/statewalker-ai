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
import type { Database } from "./database-do.js";
import type { Issuer } from "./issuer-do.js";
import type { Profiles } from "./profiles-do.js";
import type { User } from "./user-do.js";
import type { Workspace } from "./workspace-do.js";

/** What the harness uses of a Worker Loader binding: code loaded fresh for each call. */
export interface WorkerLoaderLike {
  load(code: {
    compatibilityDate?: string;
    mainModule: string;
    modules: Record<string, string>;
    env?: Record<string, unknown>;
    globalOutbound?: null;
  }): { getEntrypoint(name?: string): unknown; dispose?(): void };
}

/** The deployment's bindings and vars (wrangler.jsonc). */
export interface Env {
  ISSUER: DurableObjectNamespace<Issuer>;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  USER: DurableObjectNamespace<User>;
  PROFILES: DurableObjectNamespace<Profiles>;
  AGENT: DurableObjectNamespace<AgentSession>;
  /** One DO per database, `<workspace>/<project>/<database>`, reached only from its Workspace DO. */
  DATABASE: DurableObjectNamespace<Database>;
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
  /**
   * The deployment's permission rules, JSON `{allow?, ask?, deny?}` (statewalker/statewalker-root#124);
   * they apply in every workspace, project and mode.
   */
  PERMISSION_RULES?: string;
  /** The deployment's own modes, JSON `{name: definition}`, beside the built-in ones. */
  MODES?: string;
  /**
   * Auto mode's risk classifier (statewalker/statewalker-root#137), JSON `{model?, timeout_ms?,
   * max_tokens?, max_denials_in_row?, max_denials?, protected?}`: the classifier's model (one the
   * deployment's MODELS configures; none: every classified action denies), its timeout (5000 ms)
   * and token cap (256), the denials after which a session falls back to `default` (3 in a row, 20
   * in all), and the paths (relative to each project) writes to which are never a safe class.
   */
  AUTO_MODE?: string;
  /** How long a pending approval waits before it counts as denied (default 24 hours). */
  APPROVAL_TTL_MS?: string;
  /**
   * The deployment's model configuration (statewalker/statewalker-root#134): JSON
   * `{providers, models, allow?, default?}`; workspaces add theirs in `/.system/models`, projects
   * in `<project>/.system/models`, users through the session API.
   */
  MODELS?: string;
  /**
   * Test-only: hosts a user's own provider may use over http or at a loopback or private address,
   * comma-separated (a local scripted model).
   */
  USER_PROVIDER_HOSTS?: string;
  /**
   * The deployment's key for workspace, project and user secrets (a runtime secret). Without it
   * the deployment keeps no secrets below deployment level.
   */
  SECRETS_KEY?: string;
  /**
   * "browser" for a deployment in a person's page (CellB in a browser): it holds no key of the
   * deployment's (SECRETS_KEY and DEPLOYMENT_SECRETS are ignored) and keeps only its users' own
   * secrets (statewalker/statewalker-root#132; `browserDeploymentConfig` builds its configuration).
   */
  HOSTING?: string;
  /**
   * The deployment secrets: JSON `{"NAME": {"plugins": [...], "hosts": [...]}}` naming runtime
   * variables (Worker secrets, `.dev.vars`, the Node environment) and their bindings.
   */
  DEPLOYMENT_SECRETS?: string;
  /**
   * Compaction of long sessions (statewalker/statewalker-root#131), JSON `{budget_tokens?,
   * tail_messages? | tail_tokens?, group_size?, promote_threshold?, max_passes?, pin_tools?,
   * trim_min_chars?}`; unset settings keep their defaults (100 000 tokens, the last 8 messages, 6
   * messages per summary, 4 summaries before promotion).
   */
  COMPACTION?: string;
  /**
   * The deployment's memory caps (statewalker/statewalker-root#157), JSON `{entries?: {preferences?,
   * user?, project?, agent?}, file?, files?}`: characters of each kind's entries (1375, 1375, 2200,
   * 2200), bytes of one attachment (8192) and of all a kind's attachments (65536). A project
   * overrides them in its `.system/memory-caps`.
   */
  MEMORY_CAPS?: string;
  /**
   * The deployment's UHP servers (statewalker/statewalker-root#144), JSON `[{id, baseUrl, secret,
   * harnesses}]`: `secret` names the secret holding its bearer token (bound to plugin `uhp` and the
   * server's host), `harnesses` the ones it may serve here (`{"<name>": "<UHP harness id>"}`), each
   * the remote agent `remote:<id>/<name>`. Workspaces add theirs in `/.system/uhp-servers`.
   */
  UHP_SERVERS?: string;
  /** How often a remote agent session's DO polls its running task, in ms (default 2000). */
  UHP_POLL_MS?: string;
  /** Bytes of project files copied in to a remote harness at start (default 4 MiB). */
  UHP_INPUT_MAX_BYTES?: string;
  /** Bytes of a remote harness's write-back (default 16 MiB). */
  UHP_WRITEBACK_MAX_BYTES?: string;
  /**
   * The deployment's plugin catalog: JSON `{"<path>": "<text>"}` of plugin sources, one folder per
   * plugin, in the Agent Plugins 1.0 or Claude Code layout (statewalker/statewalker-root#82).
   */
  CATALOG?: string;
  /** The deployment's default agent, `<plugin>/<agent>`, when a project names none. */
  DEFAULT_AGENT?: string;
  /**
   * The Worker Loader binding (`worker_loaders`): native tool scripts run in an isolate of their
   * own per call (statewalker/statewalker-root#130, #94). Without it they answer ENOSYS.
   */
  LOADER?: WorkerLoaderLike;
  /**
   * The deployment catalog's plugin bundles approved to run their native tools: their sha-256
   * hashes, comma- or whitespace-separated (a refusal names the hash to approve). Workspace and
   * project plugins need none: they pass the acceptance check, and adding them approves them.
   */
  APPROVED_BUNDLES?: string;
  /** How long one native tool call may run, in ms (30000). */
  TOOL_TIMEOUT_MS?: string;
  /**
   * The deployment's limits (statewalker/statewalker-root#179): JSON
   * `[{meter, level, target?, value, period, on_exceed, warn_at?, increment?}]`. A `deployment`
   * limit is a ceiling each workspace (and each user, for their own keys) is held to; limits of
   * other levels without a target are defaults for every target of that level.
   */
  LIMITS?: string;
  /** The deployment's time zone, for calendar days and months of limits (UTC). */
  TIME_ZONE?: string;
  /** How many months usage records are kept (13). */
  USAGE_RETENTION_MONTHS?: string;
  /**
   * The operator token (a runtime secret): `GET /v1/usage/records` with it as bearer exports the
   * usage records of every workspace (statewalker/statewalker-root#181). Unset: no operator export.
   */
  OPERATOR_KEY?: string;
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

/** The ledger options every owning DO keeps its limits with. */
export function ledgerOptions(env: Env): { timeZone: string; retentionMonths: number } {
  const months = Number(env.USAGE_RETENTION_MONTHS);
  return {
    timeZone: env.TIME_ZONE || "UTC",
    retentionMonths: Number.isFinite(months) && months > 0 ? months : 13,
  };
}
