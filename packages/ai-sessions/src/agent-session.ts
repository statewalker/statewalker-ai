// One agent session (statewalker/statewalker-root#89), run by its own DO: it holds its
// configuration and capability, never the user's access token, and owns its turns, its items and
// its event log (statewalker/statewalker-root#83, #108, #125):
// - messages arrive as `next` (queued FIFO), `steer` (handed to the running turn, which takes it
//   at its next step) or `interrupt` (the running turn is cut short and the message runs next);
// - turns run one at a time, on their own: a message is accepted at once, and the turn's progress
//   is read from the event log;
// - the event log is durable and numbered; every stream is a cursor read of it, so a reader
//   going away never cancels anything, and each turn ends with a terminal event carrying the
//   full turn;
// - a change the mode asks about ends the turn `waiting` (statewalker/statewalker-root#124): the
//   exact call is stored in an `approval` item, the user's User DO is told, and the user's answer
//   (or the approval's expiry, as a denial) queues an answer turn that runs the stored call again
//   (re-checked at the gate) or records the refusal, and then the agent continues the work with
//   the result, with no new user message (statewalker/statewalker-root#214); while other approvals
//   of the waiting turn are unanswered, the answer turn waits on them and the last answer continues.
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";
import { limitOfMessage } from "@statewalker/ai-environment";
import type {
  AgentMessage,
  AgentPort,
  AgentSessionConfig,
  ApprovalAnswer,
  Delivery,
  EventsPage,
  EventsQuery,
  GateDecisionInput,
  Item,
  ItemInput,
  ItemsPage,
  ItemsQuery,
  LimitWarningView,
  MessageAccepted,
  ModelSubstitution,
  SessionEvent,
  SessionStatus,
  StopLimit,
  StopReason,
  StoredAction,
  TurnStatus,
  TurnView,
} from "./api.js";
import { type CompactionOptions, type ContextEntry, ContextShaper } from "./context/shaper.js";
import type { Summarizer } from "./context/summarizer.js";
import { type ItemRow, itemOf } from "./items.js";
import type { SqlLike } from "./sql.js";

/** A message handed to the running turn, to take at its next step. */
export interface Steer {
  id: string;
  text: string;
}

/** What the core (Flue) is given to run one turn. */
export interface TurnRun {
  config: AgentSessionConfig;
  /** The turn's id. */
  turn: string;
  /** The user's message (for a continuation, what the turn answers, never shown to the model). */
  content: string;
  /**
   * The turn continues the session after the user answered its approvals
   * (statewalker/statewalker-root#214): no user message, the context already ends with the
   * answered actions' results.
   */
  continues?: boolean;
  /**
   * The model context before the user's message: the session's top-level summaries and the items
   * no summary covers, with pins and tool-result trimming applied (statewalker/statewalker-root#131).
   */
  context: ContextEntry[];
  /** The model the message asked for, if any. */
  model?: string;
  /** Aborts when the turn is cancelled or interrupted. */
  signal: AbortSignal;
  /**
   * Subscribes to steering: the listener gets each message steered into this turn, those already
   * waiting first. The core reports one it took as a user message item carrying its `steer` id.
   */
  onSteer(listener: (steer: Steer) => void): void;
  /** Reports a change the gate stopped for an approval, with the exact call to store. */
  onApproval(request: ApprovalRequest, call: ActionCall): void;
  /** Whether a change of this turn waits on an approval: the core then ends the turn. */
  waiting(): boolean;
}

/** A change a turn made, exactly: what an approval stores and runs again. */
export interface ActionCall {
  method: StoredAction["method"];
  path: string;
  target?: string;
  content?: Uint8Array;
}

/**
 * Runs one stored change again through the gate, which re-checks it against the current mode and
 * roles: the gate's answer, or `{$approval}` when it still asks; throws its refusal.
 */
export type RunAction = (config: AgentSessionConfig, call: ActionCall) => Promise<unknown>;

/**
 * Tells the session's User DO the approvals a turn waits on; answers, if it can, when each expires
 * (`{id, expires}[]`): an approval no one answers by then continues its turn as a denial.
 */
export type RecordApprovals = (
  config: AgentSessionConfig,
  requests: ApprovalRequest[],
) => Promise<unknown>;

const toBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function storedOf(call: ActionCall): StoredAction {
  return {
    method: call.method,
    path: call.path,
    ...(call.target !== undefined ? { target: call.target } : {}),
    ...(call.content instanceof Uint8Array ? { content: toBase64(call.content) } : {}),
  };
}

function callOf(stored: StoredAction): ActionCall {
  return {
    method: stored.method,
    path: stored.path,
    ...(stored.target !== undefined ? { target: stored.target } : {}),
    ...(stored.method === "write" ||
    stored.method === "db" ||
    stored.method === "tool" ||
    stored.method === "memory"
      ? { content: fromBase64(stored.content ?? "") }
      : {}),
  };
}

/** Rows as the model reads them: JSON, big integers as text and BLOBs by their size. */
const rowsText = (rows: unknown): string =>
  JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint"
      ? value.toString()
      : value instanceof Uint8Array
        ? `<${value.length} bytes>`
        : value,
  );

/** The model spend limit an error names (`ELIMIT: … [limit {"meter":"model_spend", …}]`). */
function budgetOf(error: string): StopLimit | undefined {
  if (!error.includes("ELIMIT")) return undefined;
  const limit = limitOfMessage(error);
  if (!limit || !/^model_(spend|tokens)$/.test(String(limit.meter))) return undefined;
  return {
    meter: String(limit.meter),
    level: String(limit.level),
    target: String(limit.target),
    value: Number(limit.value),
    period: String(limit.period),
    used: Number(limit.used),
  };
}

type Pending = Map<string, { request: ApprovalRequest; stored: StoredAction }>;

/** What the core reports when a turn ends. */
export interface TurnOutcome {
  /** The model the turn ran on. */
  model?: string;
  /** The model its message asked for could not be used: what ran instead, and why. */
  substitution?: ModelSubstitution;
}

/** Runs one turn of the session's core (Flue), reporting each item as it happens. */
export type RunTurn = (
  turn: TurnRun,
  emit: (item: ItemInput) => void,
) => Promise<TurnOutcome | undefined>;

interface TurnRow {
  id: string;
  status: TurnStatus;
  delivery: Delivery;
  content: string;
  model_requested: string | null;
  pos: number;
  stop_reason: string | null;
  error: string | null;
  model: string | null;
  ignored: string;
  created: number;
  started: number | null;
  ended: number | null;
}

interface EventRow {
  seq: number;
  type: string;
  turn: string | null;
  data: string;
  created: number;
}

interface Running {
  id: string;
  abort: AbortController;
  steers: Steer[];
  listeners: ((steer: Steer) => void)[];
  applied: Set<string>;
  /** Set when the turn is being cut short: the status it ends with. */
  endAs?: "cancelled" | "interrupted";
  /** Why it was cut short, when not by the user. */
  endReason?: string;
  done: Promise<void>;
}

const eventOf = (row: EventRow): SessionEvent => ({
  seq: Number(row.seq),
  type: row.type,
  ...(row.turn ? { turn: row.turn } : {}),
  data: JSON.parse(row.data),
  created: Number(row.created),
});

const TERMINAL: readonly string[] = [
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "incomplete",
];
const KINDS: readonly string[] = [
  "message",
  "tool_call",
  "tool_result",
  "approval",
  "model_fallback",
  "mode_decision",
  "limit_warning",
  "memory_primed",
];
const MAX_PAGE = 1000;
/** Why an approval no one answered in its time counts as denied. */
const EXPIRED = "expired";
const MAX_WAIT_MS = 60_000;

function pageSize(limit: unknown, fallback: number): number {
  if (limit === undefined || limit === null || limit === "") return fallback;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) throw codedError("EINVAL", "limit must be a positive integer");
  return Math.min(n, MAX_PAGE);
}

/** The core is an agent session DO's side of the API, but for its MCP endpoint (the host's). */
export class AgentSessionCore implements Omit<AgentPort, "mcp"> {
  readonly #sql: SqlLike;
  readonly #runTurn: RunTurn;
  readonly #runAction: RunAction;
  readonly #recordApprovals: RecordApprovals;
  readonly #wake: ((at: number) => void) | undefined;
  readonly #shaper: ContextShaper;
  readonly #summarizer: Summarizer | undefined;
  #running: Running | undefined;
  readonly #waiters = new Set<() => void>();

  constructor(options: {
    sql: SqlLike;
    runTurn: RunTurn;
    runAction: RunAction;
    recordApprovals: RecordApprovals;
    /**
     * Asks the host to call `expire()` at `at` (its DO alarm): an approval expires then
     * (statewalker/statewalker-root#214).
     */
    wake?: (at: number) => void;
    /**
     * Compaction: without a summarizer, nothing is compacted (the context is every earlier item,
     * long tool results outside the tail trimmed).
     */
    compaction?: { summarizer?: Summarizer; options?: Partial<CompactionOptions> };
  }) {
    this.#sql = options.sql;
    this.#runTurn = options.runTurn;
    this.#runAction = options.runAction;
    this.#recordApprovals = options.recordApprovals;
    this.#wake = options.wake;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS agent_turns (id TEXT PRIMARY KEY, status TEXT NOT NULL,
        delivery TEXT NOT NULL, content TEXT NOT NULL, model_requested TEXT, pos INTEGER NOT NULL,
        stop_reason TEXT, error TEXT, model TEXT, ignored TEXT NOT NULL, created INTEGER NOT NULL,
        started INTEGER, ended INTEGER);
      CREATE TABLE IF NOT EXISTS items (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        turn TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
        turn TEXT, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_answers (turn TEXT PRIMARY KEY, approval TEXT NOT NULL,
        decision TEXT NOT NULL, message TEXT);
      CREATE TABLE IF NOT EXISTS agent_origin_turns (turn TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS approval_expiry (turn TEXT NOT NULL, approval TEXT NOT NULL,
        expires INTEGER NOT NULL, PRIMARY KEY (turn, approval));
      CREATE TABLE IF NOT EXISTS turn_substitutions (turn TEXT PRIMARY KEY, requested TEXT NOT NULL,
        used TEXT NOT NULL, reason TEXT NOT NULL);`);
    this.#shaper = new ContextShaper({ sql: this.#sql, options: options.compaction?.options });
    this.#summarizer = options.compaction?.summarizer;
    this.#recover();
  }

  // --- storage --------------------------------------------------------------------------------

  #rows<T>(query: string, ...args: unknown[]): T[] {
    return this.#sql.exec(query, ...args).toArray() as unknown as T[];
  }

  #one<T>(query: string, ...args: unknown[]): T | undefined {
    return this.#rows<T>(query, ...args)[0];
  }

  /** The session's configuration, once started. */
  config(): AgentSessionConfig | undefined {
    const row = this.#one<{ value: string }>("SELECT value FROM agent_config WHERE key = 'config'");
    return row ? (JSON.parse(String(row.value)) as AgentSessionConfig) : undefined;
  }

  #started(): AgentSessionConfig {
    const config = this.config();
    if (!config) throw codedError("ENOENT", "no such agent session");
    return config;
  }

  #archived(): boolean {
    return !!this.#one("SELECT value FROM agent_config WHERE key = 'archived'");
  }

  #offset(): number {
    return Number(this.#one<{ s: number }>("SELECT MAX(seq) AS s FROM events")?.s ?? 0);
  }

  #log(type: string, turn: string | undefined, data: unknown): void {
    this.#sql.exec(
      "INSERT INTO events (type, turn, data, created) VALUES (?, ?, ?, ?)",
      type,
      turn ?? null,
      JSON.stringify(data),
      Date.now(),
    );
    for (const wake of [...this.#waiters]) wake();
  }

  #append(turn: string, item: ItemInput): Item {
    const { kind, ...body } = item;
    const id = `it-${crypto.randomUUID()}`;
    this.#sql.exec(
      "INSERT INTO items (id, turn, kind, body) VALUES (?, ?, ?, ?)",
      id,
      turn,
      kind,
      JSON.stringify(body),
    );
    const stored = itemOf(this.#one<ItemRow>("SELECT * FROM items WHERE id = ?", id) as ItemRow);
    this.#log("item.created", turn, stored);
    // A warning of a limit is also its own event (statewalker/statewalker-root#179).
    if (kind === "limit_warning" && item.warning) this.#log("limit.warning", turn, item.warning);
    return stored;
  }

  #turnRow(id: string): TurnRow {
    const row = this.#one<TurnRow>("SELECT * FROM agent_turns WHERE id = ?", String(id));
    if (!row) throw codedError("ENOENT", "no such turn");
    return row;
  }

  #view(row: TurnRow, withItems = true): TurnView {
    const config = this.config();
    const ignored = JSON.parse(row.ignored) as string[];
    const model = row.model ?? undefined;
    // What the gateway said ran instead of the model the message asked for (#105).
    const substitution = this.#one<ModelSubstitution>(
      "SELECT requested, used, reason FROM turn_substitutions WHERE turn = ?",
      row.id,
    );
    const answers = this.#one<{ approval: string }>(
      "SELECT approval FROM approval_answers WHERE turn = ?",
      row.id,
    );
    return {
      id: row.id,
      session: config?.id ?? "",
      status: row.status,
      delivery: row.delivery,
      ...(row.stop_reason ? { stop_reason: JSON.parse(row.stop_reason) as StopReason } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(model ? { model } : {}),
      ...(substitution
        ? {
            model_substitution: {
              requested: String(substitution.requested),
              used: String(substitution.used),
              reason: String(substitution.reason),
            },
          }
        : {}),
      ...(ignored.length ? { ignored } : {}),
      ...(answers ? { answers: String(answers.approval) } : {}),
      created: Number(row.created),
      ...(row.started ? { started: Number(row.started) } : {}),
      ...(row.ended ? { ended: Number(row.ended) } : {}),
      items: withItems
        ? this.#rows<ItemRow>("SELECT * FROM items WHERE turn = ? ORDER BY seq", row.id).map(itemOf)
        : [],
    };
  }

  /** Ends a turn: its row, then its terminal event carrying the full turn. */
  #finish(
    id: string,
    status: TurnStatus,
    stop: StopReason,
    extra: { error?: string; model?: string } = {},
  ): void {
    this.#sql.exec(
      "UPDATE agent_turns SET status = ?, stop_reason = ?, error = ?, model = COALESCE(?, model), ended = ? WHERE id = ?",
      status,
      JSON.stringify(stop),
      extra.error ?? null,
      extra.model ?? null,
      Date.now(),
      id,
    );
    this.#log(`turn.${status}`, id, this.#view(this.#turnRow(id)));
  }

  /** Turns a host restart left running end as failed, with the reason. */
  #recover(): void {
    for (const row of this.#rows<TurnRow>(
      "SELECT * FROM agent_turns WHERE status = 'running' ORDER BY created",
    ))
      this.#finish(row.id, "failed", { type: "restart" }, { error: "the host restarted" });
    queueMicrotask(() => this.#pump());
  }

  #queue(
    config: AgentSessionConfig,
    turn: { content: string; delivery: Delivery; model?: string; ignored: string[] },
    first: boolean,
    before?: (turn: string) => void,
  ): string {
    const id = `${config.id}.tu-${crypto.randomUUID()}`;
    const edge = this.#one<{ lo: number | null; hi: number | null }>(
      "SELECT MIN(pos) AS lo, MAX(pos) AS hi FROM agent_turns WHERE status = 'queued'",
    );
    const pos = first ? Number(edge?.lo ?? 1) - 1 : Number(edge?.hi ?? 0) + 1;
    this.#sql.exec(
      "INSERT INTO agent_turns (id, status, delivery, content, model_requested, pos, ignored, created) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?)",
      id,
      turn.delivery,
      turn.content,
      turn.model ?? null,
      pos,
      JSON.stringify(turn.ignored),
      Date.now(),
    );
    before?.(id);
    this.#log("turn.queued", id, this.#view(this.#turnRow(id), false));
    return id;
  }

  // --- running turns --------------------------------------------------------------------------

  /** Starts the next queued turn when none runs. */
  #pump(): void {
    if (this.#running || this.#archived()) return;
    const config = this.config();
    if (!config) return;
    const next = this.#one<TurnRow>(
      "SELECT * FROM agent_turns WHERE status = 'queued' ORDER BY pos, created LIMIT 1",
    );
    if (!next) return;
    const running: Running = {
      id: next.id,
      abort: new AbortController(),
      steers: [],
      listeners: [],
      applied: new Set(),
      done: Promise.resolve(),
    };
    this.#running = running;
    running.done = this.#run(config, next, running)
      .catch(() => {})
      .finally(() => {
        this.#running = undefined;
        this.#pump();
      });
  }

  async #run(config: AgentSessionConfig, row: TurnRow, running: Running): Promise<void> {
    this.#sql.exec(
      "UPDATE agent_turns SET status = 'running', started = ? WHERE id = ?",
      Date.now(),
      row.id,
    );
    this.#log("turn.started", row.id, { id: row.id });
    const answer = this.#one<{ approval: string; decision: string; message: string | null }>(
      "SELECT * FROM approval_answers WHERE turn = ?",
      row.id,
    );
    const pending: Pending = new Map();
    /** Approvals asked earlier that the turn this one continues still waits on. */
    let unanswered: string[] = [];
    let error: string | undefined;
    let outcome: TurnOutcome | undefined;
    /** Runs the core with the context before item `before` (a continuation has no message). */
    const runCore = async (before: number, continues: boolean) => {
      const context = await this.#context(row.id, before, running.abort.signal);
      return this.#runTurn(
        {
          config,
          turn: row.id,
          content: row.content,
          ...(continues ? { continues: true } : {}),
          context,
          ...(row.model_requested ? { model: row.model_requested } : {}),
          signal: running.abort.signal,
          onSteer: (listener) => {
            running.listeners.push(listener);
            for (const steer of running.steers) listener(steer);
          },
          onApproval: (request, call) => {
            if (!pending.has(request.id))
              pending.set(request.id, { request, stored: storedOf(call) });
          },
          waiting: () => pending.size > 0,
        },
        (item) => {
          if (item.steer) running.applied.add(item.steer);
          this.#append(row.id, item);
        },
      );
    };
    if (answer) {
      try {
        const answered = await this.#answerTurn(config, row.id, answer, pending);
        unanswered = answered.unanswered;
        // Every approval of the turn answered: the agent continues it with the results.
        if (answered.continues && !unanswered.length && !pending.size && !running.endAs)
          outcome = await runCore(this.#nextSeq(), true);
      } catch (e) {
        error = String((e as Error)?.message ?? e);
      }
    } else {
      // A message another agent wrote (a sub-agent's task) is marked so: never the user's words.
      const byAgent = !!this.#one("SELECT 1 FROM agent_origin_turns WHERE turn = ?", row.id);
      const prompt = this.#append(row.id, {
        kind: "message",
        role: "user",
        text: row.content,
        ...(byAgent ? { origin: "agent" as const } : {}),
      });
      try {
        outcome = await runCore(prompt.seq, false);
      } catch (e) {
        error = String((e as Error)?.message ?? e);
      }
    }
    // Steering the turn did not take before it ended runs next, in the order it came; after an
    // interruption, queued as next messages (behind the interrupting one). An archived session
    // runs nothing more.
    const left = running.steers.filter((s) => !running.applied.has(s.id));
    if (!this.#archived()) {
      const first = running.endAs !== "interrupted";
      for (const steer of first ? left.reverse() : left)
        this.#queue(config, { content: steer.text, delivery: "steer", ignored: [] }, first);
    }
    const model = outcome?.model;
    if (outcome?.substitution)
      this.#sql.exec(
        "INSERT OR REPLACE INTO turn_substitutions VALUES (?, ?, ?, ?)",
        row.id,
        outcome.substitution.requested,
        outcome.substitution.used,
        outcome.substitution.reason,
      );
    // The changes the turn waits on: stored in its items, and told to the user's User DO before
    // the turn ends, so the turn's terminal event and the user's approvals agree.
    if (!running.endAs && !error && pending.size) {
      for (const { request, stored } of pending.values())
        this.#append(row.id, { kind: "approval", approval: request.id, request, stored });
      try {
        const recorded = await this.#recordApprovals(
          config,
          [...pending.values()].map((p) => p.request),
        );
        // When each expires: unanswered by then, it continues this turn as a denial.
        for (const { id, expires } of (Array.isArray(recorded) ? recorded : []) as {
          id: string;
          expires: number;
        }[])
          if (pending.has(id) && Number.isFinite(expires))
            this.#sql.exec(
              "INSERT OR REPLACE INTO approval_expiry VALUES (?, ?, ?)",
              row.id,
              id,
              Number(expires),
            );
        const next = this.nextExpiry();
        if (next !== undefined) this.#wake?.(next);
      } catch (e) {
        error = `the approvals could not be recorded: ${String((e as Error)?.message ?? e)}`;
      }
    }
    if (running.endAs)
      this.#finish(
        row.id,
        running.endAs,
        { type: running.endAs, ...(running.endReason ? { message: running.endReason } : {}) },
        model ? { model } : {},
      );
    else if (error && budgetOf(error))
      // A limit on model spend refused a request: the turn ends incomplete, naming the limit.
      this.#finish(
        row.id,
        "incomplete",
        {
          type: "budget",
          message: error.slice(error.indexOf("ELIMIT")),
          limit: budgetOf(error) as StopLimit,
        },
        model ? { model } : {},
      );
    else if (error)
      this.#finish(
        row.id,
        "failed",
        { type: "error", message: error },
        { error, ...(model ? { model } : {}) },
      );
    else if (pending.size || unanswered.length)
      this.#finish(
        row.id,
        "waiting",
        { type: "approval", approval_ids: [...new Set([...unanswered, ...pending.keys()])] },
        model ? { model } : {},
      );
    else this.#finish(row.id, "completed", { type: "end_turn" }, model ? { model } : {});
  }

  /** The model context of a turn whose user message is item `before`. */
  async #context(turn: string, before: number, signal: AbortSignal): Promise<ContextEntry[]> {
    if (this.#summarizer) {
      try {
        await this.#shaper.compact(before, this.#summarizer, {
          signal,
          onSummary: (summary) => this.#log("summary.created", turn, summary),
          onThrash: (info) => this.#log("context.over_budget", turn, info),
        });
      } catch (e) {
        // A failed summary leaves the context uncompacted; the turn still runs.
        if (signal.aborted) throw e;
        this.#log("compaction.failed", turn, { message: String((e as Error)?.message ?? e) });
      }
    }
    return this.#shaper.context(before);
  }

  /**
   * A turn continuing the session with the user's answer to an approval
   * (statewalker/statewalker-root#214): a denial (or an approval that expired unanswered) is told
   * as the action's result, with the user's message; an allow runs exactly the stored call again
   * through the gate, which re-checks it against the current mode and roles. Then the agent
   * continues the turn (`continues`) once every approval the turn waited on is answered: the
   * approvals still `unanswered` leave this turn waiting on them, and the answer to the last one
   * continues. A block of auto mode's classifier continues only when allowed: its turn already
   * carried on with the refusal.
   */
  async #answerTurn(
    config: AgentSessionConfig,
    turn: string,
    answer: { approval: string; decision: string; message: string | null },
    pending: Pending,
  ): Promise<{ continues: boolean; unanswered: string[] }> {
    const item = this.#rows<ItemRow>(
      "SELECT * FROM items WHERE kind IN ('approval', 'mode_decision') ORDER BY seq DESC",
    )
      .map(itemOf)
      .find((i) => i.approval === answer.approval && i.stored);
    if (!item?.stored || !item.request) throw codedError("ENOENT", "no such approval");
    const { method, path, target } = item.stored;
    const label = `${method} ${path}${target ? ` ${target}` : ""}`;
    const asked = item.kind === "approval";
    const unanswered = asked ? this.#unanswered(item.turn, turn, answer.approval) : [];
    const result = (output: string, isError: boolean, denied = false) =>
      this.#append(turn, {
        kind: "tool_result",
        approval: answer.approval,
        output,
        isError,
        ...(denied ? { denied: true as const } : {}),
      });
    if (answer.decision === "expired") {
      result(`${label}: denied: ${EXPIRED}`, true, true);
      return { continues: asked, unanswered };
    }
    if (answer.decision !== "allow") {
      result(
        `${label}: denied by the user${answer.message ? `: ${answer.message}` : ""}`,
        true,
        true,
      );
      return { continues: asked, unanswered };
    }
    try {
      const done = await this.#runAction(config, callOf(item.stored));
      if (done && typeof done === "object" && "$approval" in done) {
        const request = (done as { $approval: ApprovalRequest }).$approval;
        pending.set(request.id, { request, stored: item.stored });
      } else if (
        (method === "tool" || method === "memory") &&
        done &&
        typeof done === "object" &&
        "output" in done
      ) {
        // A tool's answer, as the tool would have answered it (the secrets it used by name).
        const r = done as { output: unknown; isError?: boolean; secrets?: string[] };
        this.#append(turn, {
          kind: "tool_result",
          approval: answer.approval,
          output: String(r.output),
          isError: !!r.isError,
          ...(r.secrets?.length ? { secrets: r.secrets } : {}),
        });
      } else if (method === "limit") result("the user raised the limit: carry on", false);
      else if (method === "db" && done !== null && done !== undefined)
        // A database query's answer: its rows, as the tool would have answered them.
        result(`db ${path}: ${rowsText(done)}`, false);
      else result(`${label}: done`, false);
    } catch (e) {
      result(String((e as Error)?.message ?? e), true);
    }
    return { continues: true, unanswered };
  }

  /**
   * The approvals turn `origin` asked that no answer has continued yet, but `approval` (answered
   * by turn `self`): an answer still queued counts as not yet given, so its own turn continues.
   */
  #unanswered(origin: string, self: string, approval: string): string[] {
    const asked = new Set(
      this.#rows<ItemRow>("SELECT * FROM items WHERE turn = ? AND kind = 'approval'", origin)
        .map(itemOf)
        .map((i) => String(i.approval ?? ""))
        .filter((id) => id && id !== approval),
    );
    const since = Number(this.#turnRow(origin).created);
    return [...asked].filter(
      (id) =>
        !this.#one(
          `SELECT 1 FROM approval_answers a JOIN agent_turns t ON t.id = a.turn
           WHERE a.approval = ? AND a.turn != ? AND t.created >= ? AND t.status != 'queued'`,
          id,
          self,
          since,
        ),
    );
  }

  #nextSeq(): number {
    return Number(this.#one<{ s: number }>("SELECT MAX(seq) AS s FROM items")?.s ?? 0) + 1;
  }

  /** When the next approval a turn waits on expires, if any does. */
  nextExpiry(): number | undefined {
    const row = this.#one<{ at: number | null }>("SELECT MIN(expires) AS at FROM approval_expiry");
    return row?.at === null || row?.at === undefined ? undefined : Number(row.at);
  }

  /**
   * Continues, as a denial with reason "expired", each turn waiting on an approval no one answered
   * in its time (statewalker/statewalker-root#214): called from the host's alarm. Returns when the
   * next one expires.
   */
  expire(now: number = Date.now()): number | undefined {
    const config = this.config();
    if (!config) return undefined;
    for (const due of this.#rows<{ turn: string; approval: string }>(
      "SELECT turn, approval FROM approval_expiry WHERE expires <= ? ORDER BY expires",
      now,
    )) {
      this.#sql.exec(
        "DELETE FROM approval_expiry WHERE turn = ? AND approval = ?",
        due.turn,
        due.approval,
      );
      const since = this.#one<{ created: number }>(
        "SELECT created FROM agent_turns WHERE id = ?",
        due.turn,
      );
      // Answered meanwhile (its answer turn queued after the turn that asked it): nothing to do.
      const answered = this.#one(
        `SELECT 1 FROM approval_answers a JOIN agent_turns t ON t.id = a.turn
         WHERE a.approval = ? AND t.created >= ?`,
        due.approval,
        Number(since?.created ?? 0),
      );
      if (answered || !since || this.#archived()) continue;
      this.#queueAnswer(config, due.approval, { decision: "expired", message: null });
    }
    this.#pump();
    return this.nextExpiry();
  }

  /** Cuts the running turn short, and waits for it to end. */
  async #cut(running: Running, as: "cancelled" | "interrupted"): Promise<void> {
    running.endAs ??= as;
    running.abort.abort(new Error(`EINTR: the turn was ${as}`));
    await running.done;
  }

  // --- the port -------------------------------------------------------------------------------

  /** Leaves the limits a turn's start crossed the warning share of, as items of that turn. */
  warn(turn: string, warnings: LimitWarningView[]): void {
    this.#turnRow(turn);
    for (const warning of warnings) this.#append(turn, { kind: "limit_warning", warning });
  }

  async start(config: AgentSessionConfig): Promise<void> {
    if (this.config()) throw codedError("EINVAL", `agent session ${config.id} already started`);
    this.#sql.exec("INSERT INTO agent_config VALUES ('config', ?)", JSON.stringify(config));
  }

  async send(message: AgentMessage): Promise<Omit<MessageAccepted, "stream_url">> {
    const config = this.#started();
    if (this.#archived()) throw codedError("EBUSY", "the agent session is archived");
    const offset = this.#offset();
    const running = this.#running;
    if (message.delivery === "steer" && running && !running.endAs) {
      // The model can't change mid-turn: a steer's model is ignored.
      const ignored = [...message.ignored, ...(message.model ? ["model"] : [])];
      const steer: Steer = { id: `st-${crypto.randomUUID()}`, text: message.content };
      running.steers.push(steer);
      this.#log("turn.steered", running.id, { steer: steer.id, content: steer.text });
      for (const listener of running.listeners) listener(steer);
      return {
        turn_id: running.id,
        session_id: config.id,
        delivery: "steer",
        offset,
        ...(ignored.length ? { ignored } : {}),
      };
    }
    // `steer` with no running turn acts as `next`.
    const delivery: Delivery = message.delivery === "interrupt" ? "interrupt" : "next";
    const id = this.#queue(
      config,
      {
        content: message.content,
        delivery,
        ...(message.model ? { model: message.model } : {}),
        ignored: message.ignored,
      },
      delivery === "interrupt",
    );
    if (message.origin === "agent")
      this.#sql.exec("INSERT OR IGNORE INTO agent_origin_turns VALUES (?)", id);
    if (delivery === "interrupt" && running) void this.#cut(running, "interrupted");
    else this.#pump();
    return {
      turn_id: id,
      session_id: config.id,
      delivery,
      offset,
      ...(message.ignored.length ? { ignored: message.ignored } : {}),
    };
  }

  /** Queues the turn that continues the session with the user's answer to an approval. */
  async answer(
    approval: string,
    answer: ApprovalAnswer,
  ): Promise<Omit<MessageAccepted, "stream_url">> {
    const config = this.#started();
    if (this.#archived()) throw codedError("EBUSY", "the agent session is archived");
    const offset = this.#offset();
    // An approval a turn waits on, or a block of auto mode's classifier (a retry).
    const known = this.#rows<ItemRow>(
      "SELECT * FROM items WHERE kind IN ('approval', 'mode_decision')",
    )
      .map(itemOf)
      .some((i) => i.approval === approval && i.stored);
    if (!known) throw codedError("ENOENT", "no such approval");
    // Expired by the alarm while the User DO's answer was on its way: that expiry already
    // continued the turn, so the late answer continues nothing more.
    const asked = this.#one<{ turn: string }>(
      `SELECT turn FROM items WHERE kind = 'approval' AND json_extract(body, '$.approval') = ?
       ORDER BY seq DESC LIMIT 1`,
      approval,
    );
    const expired = asked
      ? this.#one<{ turn: string }>(
          `SELECT a.turn FROM approval_answers a JOIN agent_turns t ON t.id = a.turn
           WHERE a.approval = ? AND a.decision = 'expired' AND t.created >= ?`,
          approval,
          Number(this.#turnRow(asked.turn).created),
        )
      : undefined;
    if (expired) return { turn_id: expired.turn, session_id: config.id, delivery: "next", offset };
    const id = this.#queueAnswer(config, approval, {
      decision: answer.decision,
      message: answer.message ?? null,
    });
    this.#pump();
    return { turn_id: id, session_id: config.id, delivery: "next", offset };
  }

  /** Queues the turn that continues the session with an answer (`expired`: no one answered). */
  #queueAnswer(
    config: AgentSessionConfig,
    approval: string,
    answer: { decision: string; message: string | null },
  ): string {
    const said =
      answer.decision === "allow"
        ? "allowed"
        : answer.decision === "expired"
          ? "expired"
          : "denied";
    // The answer is stored before the turn is logged, so its queued event names the approval.
    return this.#queue(
      config,
      { content: `${said}: ${approval}`, delivery: "next", ignored: [] },
      false,
      (turn) =>
        this.#sql.exec(
          "INSERT INTO approval_answers VALUES (?, ?, ?, ?)",
          turn,
          approval,
          answer.decision,
          answer.message,
        ),
    );
  }

  /**
   * Keeps one decision of auto mode (statewalker/statewalker-root#137) as an item of the running
   * turn (or the latest one), told by the gate while the turn's file call waits on it. A denial
   * that made an unattended session fall back stops the running turn.
   */
  async gateDecision(decision: GateDecisionInput): Promise<void> {
    this.#started();
    const running = this.#running;
    const turn =
      running?.id ??
      this.#one<{ id: string }>("SELECT id FROM agent_turns ORDER BY created DESC LIMIT 1")?.id;
    if (!turn) return;
    const { stored, stop, ...rest } = decision;
    this.#append(turn, {
      kind: "mode_decision",
      ...rest,
      ...(stored ? { stored: storedOf(stored) } : {}),
    });
    if (stop && running && !running.endAs) {
      running.endReason = stop;
      // Not awaited: the turn's file call is waiting on this very decision.
      void this.#cut(running, "cancelled");
    }
  }

  /**
   * What auto mode's risk classifier may be shown of the session: the user's messages and the
   * agent's tool calls, the latest ones. Tool results and every other item never leave here for it.
   */
  async classifierItems(): Promise<
    { kind: string; role?: string; text?: string; name?: string; args?: unknown }[]
  > {
    this.#started();
    return (
      this.#rows<ItemRow>(
        "SELECT * FROM items WHERE kind IN ('message', 'tool_call') ORDER BY seq DESC LIMIT 200",
      )
        .map(itemOf)
        .reverse()
        // The user's own messages only: a message another agent wrote (a sub-agent's task) may carry
        // text that agent read, so it is never shown as the user's.
        .filter((i) => i.kind === "tool_call" || (i.role === "user" && i.origin !== "agent"))
        .map((i) =>
          i.kind === "message"
            ? { kind: i.kind, role: i.role, text: i.text }
            : { kind: i.kind, name: i.name, args: i.args },
        )
    );
  }

  /**
   * Posts the approvals a sub-agent's turn waits on to this session's events stream, as the root
   * of its tree (statewalker/statewalker-root#126): whoever follows the root sees every approval
   * of the tree. Told by the sub-agent's DO.
   */
  async subAgentApprovals(session: string, requests: ApprovalRequest[]): Promise<void> {
    this.#started();
    this.#log("approval.requested", undefined, { session, approvals: requests });
  }

  async turn(turnId: string): Promise<TurnView> {
    this.#started();
    return this.#view(this.#turnRow(turnId));
  }

  /** Waits for a turn to end, and returns it. */
  async waitTurn(turnId: string): Promise<TurnView> {
    for (;;) {
      const row = this.#turnRow(turnId);
      if (TERMINAL.includes(row.status)) return this.#view(row);
      await this.#next(MAX_WAIT_MS);
    }
  }

  async cancel(turnId: string): Promise<TurnView> {
    this.#started();
    const row = this.#turnRow(turnId);
    if (row.status === "queued") this.#finish(row.id, "cancelled", { type: "cancelled" });
    else if (this.#running?.id === row.id) await this.#cut(this.#running, "cancelled");
    else throw codedError("EBUSY", `the turn has already ended (${row.status})`);
    return this.#view(this.#turnRow(turnId));
  }

  async items(query: ItemsQuery = {}): Promise<ItemsPage> {
    this.#started();
    const limit = pageSize(query.limit, 100);
    const order = query.order ?? "asc";
    if (order !== "asc" && order !== "desc") throw codedError("EINVAL", "order is asc or desc");
    const types = query.types ?? [];
    if (!Array.isArray(types) || types.some((t) => !KINDS.includes(t)))
      throw codedError("EINVAL", `types are among ${KINDS.join(", ")}`);
    const seqOf = (id: string) => {
      const row = this.#one<{ seq: number }>("SELECT seq FROM items WHERE id = ?", String(id));
      if (!row) throw codedError("EINVAL", `no item '${id}' in this session`);
      return Number(row.seq);
    };
    const where: string[] = [];
    const args: unknown[] = [];
    // `after` and `before` follow the listing's order.
    if (query.after) {
      where.push(order === "asc" ? "seq > ?" : "seq < ?");
      args.push(seqOf(query.after));
    }
    if (query.before) {
      where.push(order === "asc" ? "seq < ?" : "seq > ?");
      args.push(seqOf(query.before));
    }
    if (types.length) {
      where.push(`kind IN (${types.map(() => "?").join(", ")})`);
      args.push(...types);
    }
    const rows = this.#rows<ItemRow>(
      `SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
      ...args,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(itemOf);
    return {
      items,
      has_more: rows.length > limit,
      ...(items.length ? { first_id: items[0]?.id, last_id: items[items.length - 1]?.id } : {}),
    };
  }

  async item(itemId: string): Promise<Item> {
    this.#started();
    const row = this.#one<ItemRow>("SELECT * FROM items WHERE id = ?", String(itemId));
    if (!row) throw codedError("ENOENT", "no such item");
    return itemOf(row);
  }

  /** Resolves on the next logged event, or after `ms`. */
  #next(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.#waiters.add(wake);
    });
  }

  async events(query: EventsQuery = {}): Promise<EventsPage> {
    this.#started();
    const since = query.since === undefined ? 0 : Number(query.since);
    if (!Number.isInteger(since) || since < 0)
      throw codedError("EINVAL", "since must be an event's offset");
    const limit = pageSize(query.limit, 100);
    const wait = Math.min(Math.max(Number(query.wait ?? 0) || 0, 0), MAX_WAIT_MS);
    const read = () =>
      this.#rows<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", since, limit);
    let rows = read();
    if (!rows.length && wait > 0) {
      await this.#next(wait);
      // The session may have been purged meanwhile.
      if (!this.config()) throw codedError("ENOENT", "no such agent session");
      rows = read();
    }
    const events = rows.map(eventOf);
    const offset = events.length ? (events[events.length - 1]?.seq ?? since) : since;
    return { events, offset, up_to_date: offset >= this.#offset() };
  }

  async status(): Promise<SessionStatus> {
    this.#started();
    if (this.#one("SELECT id FROM agent_turns WHERE status IN ('running', 'queued') LIMIT 1"))
      return "running";
    const last = this.#one<{ status: string }>(
      "SELECT status FROM agent_turns WHERE ended IS NOT NULL ORDER BY ended DESC, rowid DESC LIMIT 1",
    );
    // Waiting while its last turn waits on approvals: an answer continues it.
    if (last?.status === "waiting") return "waiting";
    return last?.status === "failed" ? "error" : "idle";
  }

  async archive(): Promise<void> {
    this.#started();
    if (this.#archived()) return;
    this.#sql.exec("INSERT INTO agent_config VALUES ('archived', ?)", String(Date.now()));
    for (const row of this.#rows<TurnRow>("SELECT * FROM agent_turns WHERE status = 'queued'"))
      this.#finish(row.id, "cancelled", { type: "cancelled" });
    if (this.#running) await this.#cut(this.#running, "cancelled");
    this.#log("session.archived", undefined, { id: this.config()?.id });
  }

  async purge(): Promise<void> {
    this.#started();
    if (this.#running || (await this.status()) === "running")
      throw codedError("EBUSY", "the agent session is running");
    this.#sql.exec(
      "DELETE FROM agent_config; DELETE FROM agent_turns; DELETE FROM items; DELETE FROM events; DELETE FROM approval_answers; DELETE FROM approval_expiry; DELETE FROM turn_substitutions; DELETE FROM summaries;",
    );
    for (const wake of [...this.#waiters]) wake();
  }
}
