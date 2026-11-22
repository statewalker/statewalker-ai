// Where each Durable Object reads its limits and keeps its counters (statewalker/statewalker-root#179,
// decision #158). The Workspace DO holds the workspace, project and member levels (and the
// deployment's ceilings for the workspace); the Agent DO the session level; the User DO the user
// level, which counts the user's own keys (and the deployment's ceilings for the user). No DO
// keeps another's counter, and none is global.
import { codedError, DEFAULT_SYSTEM_FOLDER } from "@statewalker/ai-access";
import {
  breachText,
  type Limit,
  LimitExceeded,
  LimitLedger,
  type LimitLevel,
  type LimitScope,
  type LimitWarning,
  limitsFor,
  parseLimits,
  type SqlLike,
  type UsageMeta,
  withDelay,
} from "@statewalker/ai-environment";
import { type Env, ledgerOptions } from "./env.js";

/** The limits file in the workspace's and each project's system folder, and a user's profile. */
export const LIMITS_FILE = "limits";

/** A warning as the agent session keeps it: an item, and an event. */
export interface WarningView {
  meter: string;
  level: LimitLevel;
  target: string;
  /** The limit's own level (a deployment ceiling held by a workspace says `deployment`). */
  limit_level: LimitLevel;
  period: string;
  used: number;
  value: number;
  warn_at: number;
}

export const warningView = (w: LimitWarning): WarningView => ({
  meter: w.limit.meter,
  level: w.level,
  target: w.target,
  limit_level: w.limit.level,
  period: w.limit.period,
  used: w.used,
  value: w.value,
  warn_at: w.limit.warn_at,
});

const deploymentCache = new WeakMap<Env, Limit[]>();

/** The deployment's limits, read once from LIMITS (problems are reported, those limits left out). */
export function deploymentLimits(env: Env): Limit[] {
  let found = deploymentCache.get(env);
  if (!found) {
    const { limits, problems } = parseLimits(env.LIMITS);
    if (problems.length) console.warn(`LIMITS: ${problems.join("; ")}`);
    found = limits;
    deploymentCache.set(env, found);
  }
  return found;
}

/** Turns a refusal of the ledger into the coded error its meter answers with. */
export function refusal(e: unknown, code: "ELIMIT" | "ENOSPC" = "ELIMIT"): unknown {
  if (!(e instanceof LimitExceeded)) return e;
  return codedError(code, breachText(e.breach));
}

/**
 * The Workspace DO's limits: the deployment's (LIMITS), the workspace's `/.system/limits` (every
 * level but project-only ones may be there: workspace, project and member limits, and session
 * defaults) and each project's `<project>/.system/limits` (its project and session limits).
 */
export class WorkspaceLimits {
  readonly ledger: LimitLedger;
  readonly #sql: SqlLike;
  readonly #env: Env;
  readonly #workspace: string;
  readonly #read: (path: string) => Promise<string | undefined>;

  constructor(
    sql: SqlLike,
    env: Env,
    workspace: string,
    read: (path: string) => Promise<string | undefined>,
  ) {
    this.ledger = new LimitLedger(sql, ledgerOptions(env));
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_sessions (session TEXT PRIMARY KEY,
      user TEXT NOT NULL, project TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS limit_streams (id TEXT PRIMARY KEY, user TEXT NOT NULL,
      expires INTEGER NOT NULL)`);
    this.#env = env;
    this.#workspace = workspace;
    this.#read = read;
  }

  async #file(path: string, levels: readonly LimitLevel[], project?: string): Promise<Limit[]> {
    const { limits, problems } = parseLimits(await this.#read(path));
    if (problems.length) console.warn(`limits of ${path}: ${problems.join("; ")}`);
    const kept: Limit[] = [];
    for (const l of limits) {
      if (!levels.includes(l.level)) {
        console.warn(`limits of ${path}: no ${l.level} limit is set here`);
        continue;
      }
      // A project's own file caps that project only.
      kept.push(project && l.level === "project" ? { ...l, target: project } : l);
    }
    return kept;
  }

  /** Every limit that may apply in a project: the deployment's, the workspace's, the project's. */
  async #all(project: string): Promise<Limit[]> {
    return [
      ...deploymentLimits(this.#env),
      ...(await this.#file(`/${DEFAULT_SYSTEM_FOLDER}/${LIMITS_FILE}`, [
        "workspace",
        "project",
        "member",
        "session",
      ])),
      ...(project
        ? await this.#file(
            `/${project}/${DEFAULT_SYSTEM_FOLDER}/${LIMITS_FILE}`,
            ["project", "session"],
            project,
          )
        : []),
    ];
  }

  /**
   * The scopes a user's usage in a project is charged to: the workspace (held to the deployment's
   * ceilings too), the project and the member. `project` empty: the workspace and member only.
   */
  async scopes(project: string, user: string): Promise<LimitScope[]> {
    const all = await this.#all(project);
    return [
      {
        level: "workspace",
        target: this.#workspace,
        limits: [
          ...limitsFor(all, "workspace", this.#workspace),
          ...all.filter((l) => l.level === "deployment"),
        ],
      },
      ...(project
        ? [{ level: "project" as const, target: project, limits: limitsFor(all, "project", project) }]
        : []),
      { level: "member", target: user, limits: limitsFor(all, "member", user) },
    ];
  }

  /** The session limits a new session in a project starts with (deployment, workspace, project). */
  async sessionLimits(project: string): Promise<Limit[]> {
    return (await this.#all(project)).filter((l) => l.level === "session" && !l.target);
  }

  meta(project: string, user: string, session?: string, turn?: string): UsageMeta {
    return {
      workspace: this.#workspace,
      project,
      user,
      ...(session ? { session } : {}),
      ...(turn ? { turn } : {}),
    };
  }

  /** Charges a flow meter, waiting on a `delay` limit; ELIMIT when a limit refuses. */
  async charge(
    project: string,
    user: string,
    amounts: Record<string, number>,
    meta: UsageMeta,
    detail?: Record<string, unknown>,
  ): Promise<LimitWarning[]> {
    const scopes = await this.scopes(project, user);
    try {
      return await withDelay(() => this.ledger.charge(scopes, amounts, meta, detail));
    } catch (e) {
      throw refusal(e);
    }
  }

  /** Counts a new active agent session; ELIMIT (429) over a limit on sessions. */
  async startSession(project: string, user: string, session: string): Promise<void> {
    const scopes = await this.scopes(project, user);
    try {
      this.ledger.adjust(scopes, "sessions", 1, this.meta(project, user, session));
    } catch (e) {
      throw refusal(e);
    }
    this.#sql.exec("INSERT OR IGNORE INTO limit_sessions VALUES (?, ?, ?)", session, user, project);
  }

  /** An agent session ended (archived, revoked, deleted): it no longer counts, once. */
  async endSession(session: string): Promise<void> {
    const row = this.#sql
      .exec("SELECT user, project FROM limit_sessions WHERE session = ?", session)
      .toArray()[0];
    if (!row) return;
    this.#sql.exec("DELETE FROM limit_sessions WHERE session = ?", session);
    const project = String(row.project);
    const user = String(row.user);
    this.ledger.adjust(await this.scopes(project, user), "sessions", -1, this.meta(project, user, session));
  }
}

/** The Agent DO's limits: the session level, from the session's config, counted in its DO. */
export class SessionLimits {
  readonly ledger: LimitLedger;

  constructor(sql: SqlLike, env: Env) {
    this.ledger = new LimitLedger(sql, ledgerOptions(env));
  }

  scopes(config: { id: string; limits?: Limit[] }): LimitScope[] {
    return [{ level: "session", target: config.id, limits: config.limits ?? [] }];
  }

  meta(
    config: { id: string; workspace: string; project: string; user: string },
    turn?: string,
  ): UsageMeta {
    return {
      workspace: config.workspace,
      project: config.project,
      user: config.user,
      session: config.id,
      ...(turn ? { turn } : {}),
    };
  }
}
