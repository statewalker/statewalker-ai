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
import type { FilesApi } from "@statewalker/webrun-files";
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
    sql.exec("CREATE TABLE IF NOT EXISTS limit_storage_scanned (project TEXT PRIMARY KEY)");
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
        ? [
            {
              level: "project" as const,
              target: project,
              limits: limitsFor(all, "project", project),
            },
          ]
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

  /**
   * The storage meter of a project (files; databases are measured live): counted from what the
   * store holds the first time, then kept by every change through the gate.
   */
  async ensureStorage(project: string, store: FilesApi): Promise<void> {
    if (
      this.#sql.exec("SELECT 1 FROM limit_storage_scanned WHERE project = ?", project).toArray()
        .length
    )
      return;
    let n = 0;
    try {
      // The system folder is the harness's, not the project's files.
      const system = `/${project}/${DEFAULT_SYSTEM_FOLDER}/`;
      for await (const e of store.list(`/${project}`, { recursive: true }))
        if (e.kind === "file" && !`${e.path}`.startsWith(system)) n += e.size;
    } catch {
      // A project with no folder yet holds nothing.
    }
    this.#sql.exec("INSERT OR IGNORE INTO limit_storage_scanned VALUES (?)", project);
    if (n)
      this.ledger.add(
        this.#storageScopes(await this.scopes(project, "")),
        { storage_bytes: n },
        this.meta(project, ""),
      );
  }

  /** Storage counts against the workspace (and the deployment's ceilings) and the project. */
  #storageScopes(scopes: LimitScope[]): LimitScope[] {
    return scopes.filter((s) => s.level !== "member");
  }

  /**
   * Refuses (ENOSPC) adding `delta` bytes to a project when its files and databases, or the
   * workspace's, would then cross a storage limit.
   */
  async admitStorage(
    project: string,
    delta: number,
    store: FilesApi,
    databases: () => Promise<{ project: string; bytes: number }[]>,
  ): Promise<void> {
    await this.ensureStorage(project, store);
    const scopes = this.#storageScopes(await this.scopes(project, ""));
    if (!scopes.some((s) => s.limits.some((l) => l.meter === "storage_bytes"))) return;
    const dbs = await databases();
    const total = dbs.reduce((n, d) => n + d.bytes, 0);
    const own = dbs.filter((d) => d.project === project).reduce((n, d) => n + d.bytes, 0);
    try {
      for (const scope of scopes)
        this.ledger.check([scope], {
          storage_bytes: delta + (scope.level === "project" ? own : total),
        });
    } catch (e) {
      throw refusal(e, "ENOSPC");
    }
  }

  /** Counts `delta` bytes of files in a project. */
  async adjustStorage(
    project: string,
    user: string,
    delta: number,
    store: FilesApi,
  ): Promise<void> {
    await this.ensureStorage(project, store);
    if (!delta) return;
    this.ledger.add(
      this.#storageScopes(await this.scopes(project, user)),
      { storage_bytes: delta },
      this.meta(project, user),
    );
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
    this.ledger.adjust(
      await this.scopes(project, user),
      "sessions",
      -1,
      this.meta(project, user, session),
    );
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

/**
 * The User DO's limits: the user level, which counts spend on the user's own keys across the
 * deployment. Its limits are the deployment's (`deployment` ceilings and `user` defaults) and the
 * user's own, in their profile's `/limits`.
 */
export class UserLimits {
  readonly ledger: LimitLedger;
  readonly #env: Env;
  readonly #user: string;
  readonly #sql: SqlLike;
  readonly #read: () => Promise<string | undefined>;

  /** Takes an approval for a raise: true the first time only, so one approval raises once. */
  useApproval(id: string): boolean {
    if (this.#sql.exec("SELECT 1 FROM limit_approvals_used WHERE id = ?", id).toArray().length)
      return false;
    this.#sql.exec("INSERT INTO limit_approvals_used VALUES (?)", id);
    return true;
  }

  constructor(sql: SqlLike, env: Env, user: string, read: () => Promise<string | undefined>) {
    this.ledger = new LimitLedger(sql, ledgerOptions(env));
    this.#sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS limit_approvals_used (id TEXT PRIMARY KEY)");
    this.#env = env;
    this.#user = user;
    this.#read = read;
  }

  async scopes(): Promise<LimitScope[]> {
    const { limits, problems } = parseLimits(await this.#read());
    if (problems.length) console.warn(`limits of ${this.#user}: ${problems.join("; ")}`);
    const deployment = deploymentLimits(this.#env);
    return [
      {
        level: "user",
        target: this.#user,
        limits: [
          ...deployment.filter((l) => l.level === "deployment"),
          ...limitsFor(deployment, "user", this.#user),
          ...limitsFor(limits, "user", this.#user),
        ],
      },
    ];
  }
}

/** What a metered file store asks of its owner: the storage meter of each project. */
export interface StoragePort {
  /** Counts what a project holds the first time it is metered. */
  ensure(project: string): Promise<void>;
  /** Refuses (ENOSPC) a change adding `delta` bytes to a project over a storage limit. */
  admit(project: string, delta: number): Promise<void>;
  /** Counts a change of `delta` bytes in a project (a negative one frees room). */
  adjust(project: string, delta: number): Promise<void>;
}

/**
 * A file store whose writes, copies and moves count against the storage limits of the project
 * they land in (statewalker/statewalker-root#179): a change that would cross one fails with
 * ENOSPC before it lands, reads are untouched, and removing always works and frees room.
 */
export function meteredFiles(store: FilesApi, port: StoragePort): FilesApi {
  const projectOf = (path: string) => path.split("/").filter(Boolean)[0] ?? "";
  const sizeOf = async (path: string): Promise<number> => {
    const st = await store.stats(path);
    if (!st) return 0;
    if (st.kind === "file") return st.size;
    let n = 0;
    for await (const e of store.list(path, { recursive: true })) if (e.kind === "file") n += e.size;
    return n;
  };
  return {
    read: (path, options) => store.read(path, options),
    list: (path, options) => store.list(path, options),
    stats: (path) => store.stats(path),
    exists: (path) => store.exists(path),
    mkdir: (path) => store.mkdir(path),
    async write(path, content) {
      const project = projectOf(path);
      if (!project) return store.write(path, content);
      await port.ensure(project);
      const old = await sizeOf(path);
      let written = 0;
      async function* counted() {
        for await (const chunk of content) {
          written += chunk.length;
          if (written > old) await port.admit(project, written - old);
          yield chunk;
        }
      }
      await store.write(path, counted());
      await port.adjust(project, written - old);
    },
    async remove(path) {
      const project = projectOf(path);
      if (project) await port.ensure(project);
      const size = project ? await sizeOf(path) : 0;
      const done = await store.remove(path);
      if (done && size) await port.adjust(project, -size);
      return done;
    },
    async copy(source, target) {
      const to = projectOf(target);
      if (to) await port.ensure(to);
      const delta = to ? (await sizeOf(source)) - (await sizeOf(target)) : 0;
      if (delta > 0) await port.admit(to, delta);
      const done = await store.copy(source, target);
      if (done && delta) await port.adjust(to, delta);
      return done;
    },
    async move(source, target) {
      const from = projectOf(source);
      const to = projectOf(target);
      if (from === to) return store.move(source, target);
      for (const p of [from, to]) if (p) await port.ensure(p);
      const size = await sizeOf(source);
      const replaced = await sizeOf(target);
      if (size - replaced > 0) await port.admit(to, size - replaced);
      const done = await store.move(source, target);
      if (done) {
        await port.adjust(to, size - replaced);
        await port.adjust(from, -size);
      }
      return done;
    },
  };
}
