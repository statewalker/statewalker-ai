// The Workspace DO's model state (statewalker/statewalker-root#105, #134): each user's own model
// configuration (the user level), each agent session's pinned models, and the workspace's model
// budget: one row per request to a model.
//
// New tables only: model_user_config(user, config, updated), session_models(session, user,
// project, pinned, created) and model_usage(...). Rolling back leaves them unused.
import type {
  ModelRequestMeta,
  ModelsConfig,
  ModelUsage,
  PinnedModels,
} from "@statewalker/ai-environment";

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** One request as the budget holds it. */
export interface ModelUsageRecord extends ModelUsage, ModelRequestMeta {}

export class ModelStore {
  readonly #sql: SqlLike;

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS model_user_config (
      user TEXT PRIMARY KEY, config TEXT NOT NULL, updated INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS session_models (
      session TEXT PRIMARY KEY, user TEXT NOT NULL, project TEXT NOT NULL, pinned TEXT NOT NULL,
      created INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS model_usage (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, turn TEXT, user TEXT NOT NULL,
      project TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
      cost REAL, latency_ms INTEGER NOT NULL, outcome TEXT NOT NULL, charged INTEGER NOT NULL,
      created INTEGER NOT NULL)`);
  }

  userConfig(user: string): ModelsConfig | undefined {
    const row = this.#sql
      .exec("SELECT config FROM model_user_config WHERE user = ?", user)
      .toArray()[0];
    return row ? (JSON.parse(String(row.config)) as ModelsConfig) : undefined;
  }

  setUserConfig(user: string, config: ModelsConfig): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO model_user_config VALUES (?, ?, ?)",
      user,
      JSON.stringify(config),
      Date.now(),
    );
  }

  deleteUser(user: string): void {
    this.#sql.exec("DELETE FROM model_user_config WHERE user = ?", user);
  }

  /** Pins a new session's models. A session's pins never change. */
  pin(session: string, user: string, project: string, pinned: PinnedModels): void {
    this.#sql.exec(
      "INSERT INTO session_models VALUES (?, ?, ?, ?, ?)",
      session,
      user,
      project,
      JSON.stringify(pinned),
      Date.now(),
    );
  }

  pinned(session: string): { user: string; project: string; pinned: PinnedModels } | undefined {
    const row = this.#sql
      .exec("SELECT * FROM session_models WHERE session = ?", session)
      .toArray()[0];
    if (!row) return undefined;
    return {
      user: String(row.user),
      project: String(row.project),
      pinned: JSON.parse(String(row.pinned)) as PinnedModels,
    };
  }

  record(usage: ModelUsage, meta: ModelRequestMeta): void {
    this.#sql.exec(
      `INSERT INTO model_usage (session, turn, user, project, provider, model, input_tokens,
        output_tokens, cached_tokens, cost, latency_ms, outcome, charged, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      meta.session,
      meta.turn ?? null,
      meta.user,
      meta.project,
      usage.provider,
      usage.model,
      usage.input_tokens,
      usage.output_tokens,
      usage.cached_tokens,
      usage.cost ?? null,
      usage.latency_ms,
      usage.outcome,
      usage.charged ? 1 : 0,
      Date.now(),
    );
  }

  /** Every request recorded, oldest first. */
  usage(): ModelUsageRecord[] {
    return this.#sql
      .exec("SELECT * FROM model_usage ORDER BY seq")
      .toArray()
      .map((r) => ({
        session: String(r.session),
        ...(r.turn ? { turn: String(r.turn) } : {}),
        user: String(r.user),
        project: String(r.project),
        provider: String(r.provider),
        model: String(r.model),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cached_tokens: Number(r.cached_tokens),
        ...(r.cost !== null && r.cost !== undefined ? { cost: Number(r.cost) } : {}),
        latency_ms: Number(r.latency_ms),
        outcome: String(r.outcome) as ModelUsage["outcome"],
        charged: Number(r.charged) === 1,
      }));
  }
}
