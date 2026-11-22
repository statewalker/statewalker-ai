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
//   of the waiting turn are unanswered, the answer turn waits on them and the last answer continues;
// - turns form a tree with a movable head (statewalker/statewalker-root#190, decided in #159): a
//   turn follows the head when it starts and becomes the head; the context is the path from the
//   first turn to the head. A rewind moves the head (the turns left off the path stay, as an
//   inactive branch; their pending approvals are cancelled, the sub-agents they started are listed
//   to be stopped, and their memory, database and outside effects are listed, not reverted); the
//   next turn starts with an item telling the model. Edit and regenerate are a rewind plus a turn;
//   a fork copies a turn and its ancestors into another session (`exportPath` / `importHistory`).
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";
import { limitOfMessage } from "@statewalker/ai-environment";
import type {
  AgentMessage,
  AgentPort,
  AgentSessionConfig,
  ApprovalAnswer,
  BranchesView,
  BranchTurn,
  Delivery,
  EditRequest,
  EventsPage,
  EventsQuery,
  FilesRevertResult,
  GateDecisionInput,
  Item,
  ItemInput,
  ItemsPage,
  ItemsQuery,
  LimitWarningView,
  MessageAccepted,
  ModelSubstitution,
  RegenerateRequest,
  RevertAnswered,
  RewindRequest,
  RewindResult,
  SessionEvent,
  SessionHistory,
  SessionStatus,
  StopLimit,
  StopReason,
  StoredAction,
  TurnEffect,
  TurnOrigin,
  TurnRef,
  TurnStatus,
  TurnView,
  UsageTotals,
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
  /**
   * The turn tree's active path at this turn (statewalker/statewalker-root#190): the turn ids from
   * the root to this turn, this one last. A core that keeps state per turn (a remote session's
   * continuation, statewalker/statewalker-ai#84) continues from the path, never from the turn
   * that ran last.
   */
  path?: string[];
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
export type RunAction = (
  config: AgentSessionConfig,
  call: ActionCall,
  /** The turn the action runs in: its changes are recorded under it (#191). */
  turn?: string,
) => Promise<unknown>;

/**
 * Reverts the files some turns of the session (and the sub-agents they started) changed, at the
 * gate (statewalker/statewalker-root#191): what it did, or the approval it waits on.
 */
export type RevertFiles = (
  config: AgentSessionConfig,
  scope: { turns: string[]; children: string[] },
) => Promise<
  Omit<FilesRevertResult, "approval"> & { approval?: ApprovalRequest; pending?: string[] }
>;

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
    stored.method === "memory" ||
    stored.method === "changeset"
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

/**
 * Tells the session's User DO that approvals of rewound turns are cancelled
 * (statewalker/statewalker-root#190): answering them is refused.
 */
export type CancelApprovals = (config: AgentSessionConfig, ids: string[]) => Promise<unknown>;

/** Which effect a tool call has that a rewind lists and does not revert, if any. */
export type EffectOf = (item: Item) => "memory" | "database" | "outside" | undefined;

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
  parent_turn: string | null;
  origin: string | null;
  copied_from: string | null;
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
  "rewind",
  "memory_primed",
  "question",
];
const MAX_PAGE = 1000;
/** Where the head is kept in `agent_config` ("" before the first turn). */
const HEAD = "head";
/** The note the next turn starts with after a rewind, in `agent_config`. */
const REWIND_NOTE = "rewind_note";

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
export class AgentSessionCore implements Omit<AgentPort, "mcp" | "limits" | "ownLimits"> {
  readonly #sql: SqlLike;
  readonly #runTurn: RunTurn;
  readonly #runAction: RunAction;
  readonly #recordApprovals: RecordApprovals;
  readonly #wake: ((at: number) => void) | undefined;
  readonly #resumable: ((turn: string) => boolean) | undefined;
  readonly #compacts: ((config: AgentSessionConfig) => boolean) | undefined;
  readonly #cancelApprovals: CancelApprovals | undefined;
  readonly #effectOf: EffectOf | undefined;
  readonly #revertFiles: RevertFiles | undefined;
  readonly #shaper: ContextShaper;
  readonly #summarizer: Summarizer | undefined;
  #running: Running | undefined;
  /** Set while the head moves: no queued turn starts meanwhile. */
  #moving = false;
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
    /** Told the pending approvals of rewound turns, cancelled (statewalker/statewalker-root#190). */
    cancelApprovals?: CancelApprovals;
    /** Picks out the tool calls whose effects a rewind lists (memory, database, outside). */
    effectOf?: EffectOf;
    /** A rewind's `revert_files` (statewalker/statewalker-root#191); refused without it. */
    revertFiles?: RevertFiles;
    /**
     * Whether a turn a host restart left running still runs elsewhere (a remote agent session's
     * task, statewalker/statewalker-root#144): it is then queued first and run again (its core picks
     * the task up), instead of failing.
     */
    resumable?: (turn: string) => boolean;
    /** Whether the session's context is compacted (default: yes); a remote session's never is. */
    compacts?: (config: AgentSessionConfig) => boolean;
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
    this.#resumable = options.resumable;
    this.#compacts = options.compacts;
    this.#cancelApprovals = options.cancelApprovals;
    this.#effectOf = options.effectOf;
    this.#revertFiles = options.revertFiles;
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
        used TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_children (turn TEXT NOT NULL, session TEXT NOT NULL,
        PRIMARY KEY (turn, session));
      CREATE TABLE IF NOT EXISTS cancelled_approvals (turn TEXT NOT NULL, approval TEXT NOT NULL,
        PRIMARY KEY (turn, approval));
      CREATE TABLE IF NOT EXISTS revert_approvals (approval TEXT PRIMARY KEY, scope TEXT NOT NULL,
        created INTEGER NOT NULL);`);
    this.#shaper = new ContextShaper({ sql: this.#sql, options: options.compaction?.options });
    this.#summarizer = options.compaction?.summarizer;
    this.#migrate();
    this.#recover();
  }

  /**
   * The turn tree's columns (statewalker/statewalker-root#190), added to a store made before it.
   * Every turn that ran with no origin (stored before the tree, or run by an earlier version after
   * a rollback) follows the head, in the order they came, `origin: run`, and the last becomes the
   * head; summaries with no `through_turn` run through their last item's turn. Rolling back
   * ignores the extra columns; deploying again chains what ran meanwhile.
   */
  #migrate(): void {
    const columns = new Set(
      this.#rows<{ name: string }>("SELECT name FROM pragma_table_info('agent_turns')").map((r) =>
        String(r.name),
      ),
    );
    for (const name of ["parent_turn", "origin", "copied_from"])
      if (!columns.has(name)) this.#sql.exec(`ALTER TABLE agent_turns ADD COLUMN ${name} TEXT`);
    let previous = this.#head();
    let moved = false;
    for (const row of this.#rows<{ id: string }>(
      "SELECT id FROM agent_turns WHERE started IS NOT NULL AND origin IS NULL ORDER BY created, rowid",
    )) {
      this.#sql.exec(
        "UPDATE agent_turns SET parent_turn = ?, origin = 'run' WHERE id = ?",
        previous,
        row.id,
      );
      previous = String(row.id);
      moved = true;
    }
    if (moved) this.#setHead(previous);
    this.#sql.exec(
      `UPDATE summaries SET through_turn = COALESCE((SELECT turn FROM items
        WHERE items.seq = summaries.to_seq), '') WHERE through_turn = '' OR through_turn IS NULL`,
    );
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

  /**
   * The model usage of the items matching `where`, totalled (statewalker/statewalker-root#181):
   * every request the items record, the failed ones a fallback names included. None without one.
   */
  #usage(where: string, ...args: unknown[]): UsageTotals | undefined {
    const row = this.#one<Record<string, unknown>>(
      `SELECT count(*) AS requests,
        total(json_extract(body, '$.usage.input_tokens')) AS input_tokens,
        total(json_extract(body, '$.usage.output_tokens')) AS output_tokens,
        total(json_extract(body, '$.usage.cached_tokens')) AS cached_tokens,
        total(json_extract(body, '$.usage.cost')) AS cost
        FROM items WHERE json_extract(body, '$.usage.model') IS NOT NULL${where ? ` AND ${where}` : ""}`,
      ...args,
    );
    if (!row || !Number(row.requests)) return undefined;
    return {
      requests: Number(row.requests),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cached_tokens: Number(row.cached_tokens),
      cost: Number(row.cost),
    };
  }

  /**
   * The session's model usage, totalled over the turns it ran (rewound branches included: their
   * requests were spent); turns a fork copied are the source session's spend, not this one's.
   */
  async usage(): Promise<UsageTotals | undefined> {
    this.#started();
    return this.#usage(
      "turn IN (SELECT id FROM agent_turns WHERE COALESCE(origin, 'run') = 'run')",
    );
  }

  /** The head: the turn the next one follows (null before the first turn). */
  #head(): string | null {
    const row = this.#one<{ value: string }>("SELECT value FROM agent_config WHERE key = ?", HEAD);
    return row?.value ? String(row.value) : null;
  }

  #setHead(turn: string | null): void {
    this.#sql.exec("INSERT OR REPLACE INTO agent_config VALUES (?, ?)", HEAD, turn ?? "");
  }

  /** The path of turns from the first one to `turn`, first turn first ([] for null). */
  #pathTo(turn: string | null): string[] {
    if (!turn) return [];
    return this.#rows<{ id: string }>(
      `WITH RECURSIVE p(id, parent, d) AS (
        SELECT id, parent_turn, 0 FROM agent_turns WHERE id = ?
        UNION ALL SELECT t.id, t.parent_turn, p.d + 1 FROM agent_turns t JOIN p ON t.id = p.parent
          WHERE p.d < 1000000)
      SELECT id FROM p ORDER BY d DESC`,
      turn,
    ).map((r) => String(r.id));
  }

  /**
   * Whether an approval waits on the active path: its latest asking on the path (`path`) was not
   * cancelled by a rewind (the same action asked again later is an approval of its own).
   */
  #pendingOnPath(approval: string, path: string[]): boolean {
    const asked = this.#one<{ turn: string }>(
      `SELECT turn FROM items WHERE kind IN ('approval', 'question', 'mode_decision')
        AND json_extract(body, '$.approval') = ? AND turn IN (SELECT value FROM json_each(?))
        ORDER BY seq DESC LIMIT 1`,
      approval,
      JSON.stringify(path),
    );
    return (
      !!asked &&
      !this.#one(
        "SELECT 1 FROM cancelled_approvals WHERE turn = ? AND approval = ?",
        asked.turn,
        approval,
      )
    );
  }

  /** A turn of the session's tree (one that ran or is running); ENOENT for any other. */
  #treeTurn(id: string): TurnRow {
    const row = this.#one<TurnRow>(
      "SELECT * FROM agent_turns WHERE id = ? AND started IS NOT NULL",
      String(id),
    );
    if (!row) throw codedError("ENOENT", "no such turn in the session's tree");
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
    const usage = this.#usage("turn = ?", row.id);
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
      ...(usage ? { usage } : {}),
      parent_turn: row.parent_turn ?? null,
      origin: (row.origin ?? "run") as TurnOrigin,
      ...(row.copied_from ? { copied_from: JSON.parse(row.copied_from) as TurnRef } : {}),
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
    )) {
      if (this.#resumable?.(row.id)) {
        const edge = this.#one<{ lo: number | null }>(
          "SELECT MIN(pos) AS lo FROM agent_turns WHERE status = 'queued'",
        );
        this.#sql.exec(
          "UPDATE agent_turns SET status = 'queued', pos = ? WHERE id = ?",
          Number(edge?.lo ?? 1) - 1,
          row.id,
        );
        this.#log("turn.resumed", row.id, { id: row.id });
      } else this.#finish(row.id, "failed", { type: "restart" }, { error: "the host restarted" });
    }
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
    if (this.#running || this.#moving || this.#archived()) return;
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
    // The turn follows the head, and becomes it. A turn resumed after a restart is the head
    // already: it keeps its parent (never its own, which would loop the path).
    const head = this.#head();
    this.#sql.exec(
      "UPDATE agent_turns SET status = 'running', started = ?, parent_turn = ?, origin = 'run' WHERE id = ?",
      Date.now(),
      head === row.id ? (row.parent_turn ?? null) : head,
      row.id,
    );
    this.#setHead(row.id);
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
      const context = await this.#context(config, row.id, before, running.abort.signal);
      return this.#runTurn(
        {
          config,
          turn: row.id,
          content: row.content,
          ...(continues ? { continues: true } : {}),
          context,
          path: this.#pathTo(row.id),
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
      // After a rewind, the turn starts by telling the model so.
      const note = this.#one<{ value: string }>(
        "SELECT value FROM agent_config WHERE key = ?",
        REWIND_NOTE,
      );
      if (note) {
        this.#sql.exec("DELETE FROM agent_config WHERE key = ?", REWIND_NOTE);
        this.#append(row.id, JSON.parse(String(note.value)) as ItemInput);
      }
      // A message another agent wrote (a sub-agent's task) is marked so: never the user's words.
      const byAgent = !!this.#one("SELECT 1 FROM agent_origin_turns WHERE turn = ?", row.id);
      // A turn resumed after a restart already holds its message.
      const held = this.#one<ItemRow>(
        "SELECT * FROM items WHERE turn = ? AND kind = 'message' AND json_extract(body, '$.role') = 'user' ORDER BY seq LIMIT 1",
        row.id,
      );
      const prompt = held
        ? itemOf(held)
        : this.#append(row.id, {
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
        this.#append(row.id, {
          // A remote harness's free-text question is a question (statewalker/statewalker-root#144).
          kind: request.input?.kind === "free_text" ? "question" : "approval",
          approval: request.id,
          request,
          stored,
        });
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
  async #context(
    config: AgentSessionConfig,
    turn: string,
    before: number,
    signal: AbortSignal,
  ): Promise<ContextEntry[]> {
    if (this.#summarizer && (this.#compacts?.(config) ?? true)) {
      try {
        await this.#shaper.compact(before, this.#summarizer, {
          path: this.#pathTo(turn),
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
    return this.#shaper.context(before, this.#pathTo(turn));
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
      "SELECT * FROM items WHERE kind IN ('approval', 'question', 'mode_decision') ORDER BY seq DESC",
    )
      .map(itemOf)
      .find((i) => i.approval === answer.approval && i.stored);
    if (!item?.stored || !item.request) throw codedError("ENOENT", "no such approval");
    const { method, path, target } = item.stored;
    const label = `${method} ${path}${target ? ` ${target}` : ""}`;
    const asked = item.kind === "approval" || item.kind === "question";
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
      const done = await this.#runAction(config, callOf(item.stored), turn);
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
      this.#rows<ItemRow>(
        "SELECT * FROM items WHERE turn = ? AND kind IN ('approval', 'question')",
        origin,
      )
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
    if (message.after_turn !== undefined) await this.#chain(config, String(message.after_turn));
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

  /**
   * Chains the next message on `turn` (statewalker/statewalker-root#159): nothing to do when it is
   * the latest turn (the last queued, else the running one, else the head); otherwise the head
   * moves there first, an implicit rewind that reverts no file, refused (EBUSY) while a turn runs
   * or waits in the queue. The next turn starts with an item saying so.
   */
  async #chain(config: AgentSessionConfig, turn: string): Promise<void> {
    const queued = this.#rows<TurnRow>(
      "SELECT * FROM agent_turns WHERE status = 'queued' ORDER BY pos, created",
    );
    const latest = queued.at(-1)?.id ?? this.#running?.id ?? this.#head();
    if (turn === latest) return;
    const row = this.#treeTurn(turn);
    if (row.id === this.#head() && !queued.length && !this.#running) return;
    await this.#move(config, row.id, { cancelRunning: false, rewind: true, reason: "chained" });
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
      "SELECT * FROM items WHERE kind IN ('approval', 'question', 'mode_decision')",
    )
      .map(itemOf)
      .some((i) => i.approval === approval && i.stored);
    if (!known) throw codedError("ENOENT", "no such approval");
    // Only an approval of a turn on the active path, run here: a rewind cancelled the others, and
    // a fork copies no pending approval (statewalker/statewalker-root#190).
    const of = this.#one<{ turn: string; origin: string | null }>(
      `SELECT i.turn, t.origin FROM items i JOIN agent_turns t ON t.id = i.turn
        WHERE i.kind IN ('approval', 'question', 'mode_decision') AND json_extract(i.body, '$.approval') = ?
        ORDER BY i.seq DESC LIMIT 1`,
      approval,
    );
    if (
      !of ||
      (of.origin ?? "run") !== "run" ||
      !this.#pendingOnPath(approval, this.#pathTo(this.#head()))
    )
      throw codedError("EINVAL", "the approval was cancelled: its turn is not on the active path");
    // Expired by the alarm while the User DO's answer was on its way: that expiry already
    // continued the turn, so the late answer continues nothing more.
    const asked = this.#one<{ turn: string }>(
      `SELECT turn FROM items WHERE kind IN ('approval', 'question') AND json_extract(body, '$.approval') = ?
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
        `SELECT * FROM items WHERE kind IN ('message', 'tool_call')
          AND turn IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT 200`,
        JSON.stringify(this.#pathTo(this.#head())),
      )
        .map(itemOf)
        .reverse()
        // A remote harness's items are untrusted output: never shown (statewalker/statewalker-root#144).
        .filter((i) => !i.external)
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
    // The active path by default; a branch's path (to one of its turns), or every item.
    const all = query.all === true || (query.all as unknown) === "true";
    if (!all) {
      let path: string[];
      if (query.branch !== undefined && query.branch !== null && query.branch !== "") {
        const row = this.#one<{ id: string }>(
          "SELECT id FROM agent_turns WHERE id = ? AND started IS NOT NULL",
          String(query.branch),
        );
        if (!row) throw codedError("EINVAL", `no turn '${query.branch}' in this session's tree`);
        path = this.#pathTo(String(row.id));
      } else path = this.#pathTo(this.#head());
      where.push("turn IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(path));
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
    // As its head stands (statewalker/statewalker-root#190): waiting while the head waits on
    // approvals (an answer continues it). A copied head is history: nothing to answer or fix here.
    const head = this.#head();
    const last = head
      ? this.#one<{ status: string; origin: string | null; stop_reason: string | null }>(
          "SELECT status, origin, stop_reason FROM agent_turns WHERE id = ?",
          head,
        )
      : undefined;
    if (!last || (last.origin ?? "run") !== "run") return "idle";
    if (last.status === "waiting") {
      // Unless a rewind cancelled what it waits on, and a branch switch came back to it.
      const ids = (JSON.parse(last.stop_reason ?? "{}") as StopReason).approval_ids ?? [];
      const path = this.#pathTo(head);
      return !ids.length || ids.some((id) => this.#pendingOnPath(id, path)) ? "waiting" : "idle";
    }
    return last.status === "failed" ? "error" : "idle";
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

  // --- the turn tree (statewalker/statewalker-root#190) -----------------------------------------

  /** Records a sub-agent session a turn started: a rewind of the turn stops it. */
  async childStarted(turn: string, session: string): Promise<void> {
    this.#turnRow(turn);
    this.#sql.exec("INSERT OR IGNORE INTO turn_children VALUES (?, ?)", turn, String(session));
  }

  /**
   * Moves the head to the end of `to_turn` (null: before the first turn), or before `before_turn`.
   * A running or queued turn refuses it (EBUSY) unless `cancel_running`, which cancels them first.
   */
  async rewind(req: RewindRequest): Promise<RewindResult> {
    const config = this.#started();
    const r = (req ?? {}) as RewindRequest;
    this.#canRevert(r.revert_files === true);
    const to = r.to_turn !== undefined;
    const before = r.before_turn !== undefined && r.before_turn !== null;
    if (to === before) throw codedError("EINVAL", "a rewind names to_turn or before_turn");
    const target = before
      ? (this.#treeTurn(String(r.before_turn)).parent_turn ?? null)
      : r.to_turn === null || r.to_turn === ""
        ? null
        : this.#treeTurn(String(r.to_turn)).id;
    return this.#move(config, target, {
      cancelRunning: r.cancel_running === true,
      rewind: true,
      revertFiles: r.revert_files === true,
    });
  }

  /** Switches branch: the head moves to `turn` (null: before the first turn); nothing runs. */
  async setHead(turn: string | null): Promise<RewindResult> {
    const config = this.#started();
    const target =
      turn === null || turn === undefined || turn === "" ? null : this.#treeTurn(turn).id;
    return this.#move(config, target, { cancelRunning: false, rewind: false });
  }

  /** Edits a turn's message: a rewind before it, then the edited message as a sibling turn. */
  async edit(
    turnId: string,
    req: EditRequest,
  ): Promise<Omit<MessageAccepted, "stream_url"> & { rewind: RewindResult }> {
    const content = (req as { content?: unknown } | undefined)?.content;
    if (typeof content !== "string" || !content)
      throw codedError("EINVAL", "content must be a non-empty string");
    return this.#again(turnId, content, req.model, !!req.revert_files);
  }

  /** Runs a turn's message again (on `model`, if given): a rewind before it, then a sibling turn. */
  async regenerate(
    turnId: string,
    req: RegenerateRequest = {},
  ): Promise<Omit<MessageAccepted, "stream_url"> & { rewind: RewindResult }> {
    return this.#again(turnId, undefined, req.model, !!req.revert_files);
  }

  async #again(
    turnId: string,
    content: string | undefined,
    model: string | undefined,
    revertFiles: boolean,
  ): Promise<Omit<MessageAccepted, "stream_url"> & { rewind: RewindResult }> {
    const config = this.#started();
    this.#canRevert(revertFiles);
    const row = this.#treeTurn(turnId);
    if (this.#one("SELECT 1 FROM approval_answers WHERE turn = ?", row.id))
      throw codedError("EINVAL", "an answer turn has no message of its own");
    const byAgent = !!this.#one("SELECT 1 FROM agent_origin_turns WHERE turn = ?", row.id);
    const rewind = await this.#move(config, row.parent_turn ?? null, {
      cancelRunning: false,
      rewind: true,
      revertFiles,
    });
    const asked = model ?? row.model_requested ?? undefined;
    const accepted = await this.send({
      content: content ?? row.content,
      delivery: "next",
      ...(asked ? { model: asked } : {}),
      ignored: [],
      ...(byAgent ? { origin: "agent" as const } : {}),
    });
    return { ...accepted, rewind };
  }

  /**
   * Moves the head to `target`: the turns of the old path left off the new one are rewound. Their
   * pending approvals are cancelled; their sub-agents and their memory, database and outside
   * effects are listed; the next turn starts with an item telling the model.
   */
  async #move(
    config: AgentSessionConfig,
    target: string | null,
    options: { cancelRunning: boolean; rewind: boolean; reason?: "chained"; revertFiles?: boolean },
  ): Promise<RewindResult> {
    if (this.#archived()) throw codedError("EBUSY", "the agent session is archived");
    if (this.#moving) throw codedError("EBUSY", "the session's head is already moving");
    const busy = this.#rows<TurnRow>(
      "SELECT * FROM agent_turns WHERE status IN ('running', 'queued') ORDER BY pos, created",
    );
    if (busy.length && !options.cancelRunning)
      throw codedError("EBUSY", "a turn is running or queued: cancel it, or pass cancel_running");
    this.#moving = true;
    try {
      const cancelled: string[] = [];
      const known = new Set(busy.map((b) => b.id));
      const cancelQueued = (only?: (row: TurnRow) => boolean) => {
        for (const row of this.#rows<TurnRow>(
          "SELECT * FROM agent_turns WHERE status = 'queued' ORDER BY pos, created",
        ))
          if (!only || only(row)) {
            this.#finish(row.id, "cancelled", { type: "cancelled" });
            cancelled.push(row.id);
          }
      };
      cancelQueued((row) => known.has(row.id));
      const running = this.#running;
      if (running) {
        cancelled.unshift(running.id);
        await this.#cut(running, "cancelled");
      }
      // The steering the cut turn had not taken was queued as it ended: cancelled too. A message
      // sent meanwhile runs after the move.
      cancelQueued((row) => known.has(row.id) || row.delivery === "steer");
      const previous = this.#head();
      const path = new Set(this.#pathTo(target));
      const rewound = this.#pathTo(previous).filter((id) => !path.has(id));
      // A revert still waiting on its approval no longer stands once the head moves again.
      await this.#cancelReverts(config);
      // The files first: a revert that fails leaves the head where it was.
      const files = options.revertFiles
        ? await this.#revert(config, rewound, this.#children(rewound))
        : undefined;
      const result: RewindResult = {
        head: target,
        previous,
        rewound,
        cancelled_turns: cancelled,
        cancelled_approvals: await this.#cancelPending(config, rewound),
        stopped_children: this.#children(rewound),
        ...this.#effects(rewound),
        ...(files ? { files } : {}),
      };
      this.#setHead(target);
      this.#note(previous, target, rewound, path, options.reason);
      if (options.rewind) this.#log("session.rewound", undefined, result);
      this.#log("session.head_changed", undefined, { head: target, previous });
      return result;
    } finally {
      this.#moving = false;
      this.#pump();
    }
  }

  /** A revert of files needs the gate's revert (#191). */
  #canRevert(revert: boolean): void {
    if (revert && !this.#revertFiles) throw codedError("ENOSYS", "this host cannot revert files");
  }

  /**
   * Reverts the files some turns and their sub-agents changed, at the gate. A revert the mode asks
   * about is recorded as an approval at the user's User DO, and runs when it is allowed.
   */
  async #revert(
    config: AgentSessionConfig,
    turns: string[],
    children: string[],
  ): Promise<FilesRevertResult> {
    const empty: FilesRevertResult = { reverted: [], conflicts: [], unavailable: [] };
    if (!turns.length || !this.#revertFiles) return empty;
    const done = await this.#revertFiles(config, { turns, children });
    const { approval, ...rest } = done;
    if (!approval) return { ...empty, ...rest };
    await this.#recordApprovals(config, [approval]);
    this.#sql.exec(
      "INSERT OR REPLACE INTO revert_approvals VALUES (?, ?, ?)",
      approval.id,
      JSON.stringify({ turns, children }),
      Date.now(),
    );
    return { ...empty, ...rest, approval: approval.id };
  }

  /** Cancels the reverts still waiting on their approvals, at the user's User DO too. */
  async #cancelReverts(config: AgentSessionConfig): Promise<void> {
    const ids = this.#rows<{ approval: string }>("SELECT approval FROM revert_approvals").map((r) =>
      String(r.approval),
    );
    if (!ids.length) return;
    this.#sql.exec("DELETE FROM revert_approvals");
    try {
      await this.#cancelApprovals?.(config, ids);
    } catch {
      // Answering them is refused here anyway.
    }
  }

  /** The answer to a revert's approval: an allow reverts the files now (the gate re-checks). */
  async answerRevert(approval: string, answer: ApprovalAnswer): Promise<RevertAnswered> {
    const config = this.#started();
    if (this.#archived()) throw codedError("EBUSY", "the agent session is archived");
    const row = this.#one<{ scope: string }>(
      "SELECT scope FROM revert_approvals WHERE approval = ?",
      approval,
    );
    if (!row) throw codedError("EINVAL", "the revert was cancelled: the head moved since");
    this.#sql.exec("DELETE FROM revert_approvals WHERE approval = ?", approval);
    const scope = JSON.parse(String(row.scope)) as { turns: string[]; children: string[] };
    let files: FilesRevertResult;
    if (answer.decision !== "allow")
      files = {
        reverted: [],
        conflicts: [],
        unavailable: [],
        refused: `denied by the user${answer.message ? `: ${answer.message}` : ""}`,
      };
    else files = await this.#revert(config, scope.turns, scope.children);
    this.#log("session.files_reverted", undefined, { approval, ...files });
    return { files };
  }

  /** Cancels the approvals rewound turns wait on: they expire no more, and their User DO is told. */
  async #cancelPending(config: AgentSessionConfig, turns: string[]): Promise<string[]> {
    if (!turns.length) return [];
    const ids: string[] = [];
    for (const item of this.#rows<ItemRow>(
      `SELECT * FROM items WHERE kind IN ('approval', 'question') AND turn IN (SELECT value FROM json_each(?))
        ORDER BY seq`,
      JSON.stringify(turns),
    ).map(itemOf)) {
      const since = Number(this.#turnRow(item.turn).created);
      const answered = this.#one(
        `SELECT 1 FROM approval_answers a JOIN agent_turns t ON t.id = a.turn
          WHERE a.approval = ? AND t.created >= ? AND t.status NOT IN ('queued', 'cancelled')`,
        String(item.approval),
        since,
      );
      if (answered || !item.approval) continue;
      this.#sql.exec(
        "INSERT OR IGNORE INTO cancelled_approvals VALUES (?, ?)",
        item.turn,
        item.approval,
      );
      if (!ids.includes(item.approval)) ids.push(item.approval);
    }
    this.#sql.exec(
      "DELETE FROM approval_expiry WHERE turn IN (SELECT value FROM json_each(?))",
      JSON.stringify(turns),
    );
    if (ids.length)
      try {
        await this.#cancelApprovals?.(config, ids);
      } catch {
        // The User DO is told what it can be: an answer to these is refused here anyway.
      }
    return ids;
  }

  #children(turns: string[]): string[] {
    return this.#rows<{ session: string }>(
      "SELECT session FROM turn_children WHERE turn IN (SELECT value FROM json_each(?))",
      JSON.stringify(turns),
    ).map((r) => String(r.session));
  }

  /** The memory, database and outside effects of some turns' tool calls (those that did not fail). */
  #effects(
    turns: string[],
  ): Pick<RewindResult, "memory_writes" | "database_changes" | "irreversible_effects"> {
    const out: Pick<RewindResult, "memory_writes" | "database_changes" | "irreversible_effects"> = {
      memory_writes: [],
      database_changes: [],
      irreversible_effects: [],
    };
    if (!turns.length || !this.#effectOf) return out;
    for (const item of this.#rows<ItemRow>(
      `SELECT * FROM items WHERE kind = 'tool_call' AND turn IN (SELECT value FROM json_each(?))
        ORDER BY seq`,
      JSON.stringify(turns),
    ).map(itemOf)) {
      const kind = this.#effectOf(item);
      if (!kind) continue;
      // A call that failed changed nothing.
      const failed =
        item.callId &&
        this.#one(
          `SELECT 1 FROM items WHERE turn = ? AND kind = 'tool_result'
            AND json_extract(body, '$.callId') = ? AND json_extract(body, '$.isError') = 1`,
          item.turn,
          item.callId,
        );
      if (failed) continue;
      const effect: TurnEffect = {
        turn: item.turn,
        item: item.id,
        name: String(item.name ?? ""),
        ...(item.args !== undefined ? { args: item.args } : {}),
      };
      if (kind === "memory") out.memory_writes.push(effect);
      else if (kind === "database") out.database_changes.push(effect);
      else out.irreversible_effects.push(effect);
    }
    return out;
  }

  /**
   * Keeps (or updates) the item the next turn starts with: where the head was before the first
   * move since the last turn, where it is, and the turns set aside meanwhile.
   */
  #note(
    previous: string | null,
    head: string | null,
    rewound: string[],
    path: Set<string>,
    reason?: "chained",
  ): void {
    const kept = this.#one<{ value: string }>(
      "SELECT value FROM agent_config WHERE key = ?",
      REWIND_NOTE,
    );
    const before = kept ? (JSON.parse(String(kept.value)) as ItemInput).rewind : undefined;
    const from = before ? before.previous : previous;
    const turns = [...new Set([...(before?.turns ?? []), ...rewound])].filter((t) => !path.has(t));
    if (from === head && !turns.length) {
      this.#sql.exec("DELETE FROM agent_config WHERE key = ?", REWIND_NOTE);
      return;
    }
    const effects = this.#effects(turns);
    const named = (list: TurnEffect[]) => [...new Set(list.map((e) => e.name))].join(", ");
    const kept_ = [
      effects.memory_writes.length ? `memory writes (${named(effects.memory_writes)})` : "",
      effects.database_changes.length
        ? `database changes (${named(effects.database_changes)})`
        : "",
      effects.irreversible_effects.length
        ? `outside effects (${named(effects.irreversible_effects)})`
        : "",
    ].filter(Boolean);
    const setAside =
      `${turns.length} later turn${turns.length === 1 ? "" : "s"} ` +
      "of it were set aside and are no longer part of it.";
    const text = [
      reason === "chained"
        ? `head moved: chained on an earlier response. ${setAside}`
        : `The conversation was rewound: ${setAside}`,
      kept_.length ? `Their effects stay as they are, not reverted: ${kept_.join("; ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const note: ItemInput = {
      kind: "rewind",
      text,
      rewind: { previous: from, head, turns, ...(reason ? { reason } : {}) },
    };
    this.#sql.exec(
      "INSERT OR REPLACE INTO agent_config VALUES (?, ?)",
      REWIND_NOTE,
      JSON.stringify(note),
    );
  }

  /** The session's tree: every turn that ran, the active path marked. */
  async branches(): Promise<BranchesView> {
    this.#started();
    const head = this.#head();
    const active = new Set(this.#pathTo(head));
    const rows = this.#rows<TurnRow>(
      "SELECT * FROM agent_turns WHERE started IS NOT NULL ORDER BY started, rowid",
    );
    const parents = new Set(rows.map((r) => r.parent_turn).filter(Boolean));
    const turns = rows.map((row): BranchTurn => {
      const message = this.#one<ItemRow>(
        "SELECT * FROM items WHERE turn = ? AND kind = 'message' ORDER BY seq LIMIT 1",
        row.id,
      );
      const text = message ? itemOf(message).text : undefined;
      return {
        id: row.id,
        parent_turn: row.parent_turn ?? null,
        origin: (row.origin ?? "run") as TurnOrigin,
        status: row.status,
        created: Number(row.created),
        active: active.has(row.id),
        ...(text ? { text: text.length > 200 ? `${text.slice(0, 200)}…` : text } : {}),
      };
    });
    return { head, turns, leaves: rows.filter((r) => !parents.has(r.id)).map((r) => r.id) };
  }

  /**
   * Erases an inactive branch: the turn and every turn after it, with their items, events and
   * summaries. The active path is never erased (EINVAL): rewind first.
   */
  async eraseBranch(turn: string): Promise<{ erased: string[] }> {
    this.#started();
    const row = this.#treeTurn(turn);
    if (this.#pathTo(this.#head()).includes(row.id))
      throw codedError("EINVAL", "the turn is on the active path: rewind or switch branch first");
    const erased = this.#rows<{ id: string }>(
      `WITH RECURSIVE d(id) AS (SELECT ? UNION SELECT t.id FROM agent_turns t JOIN d
        ON t.parent_turn = d.id) SELECT d.id FROM d JOIN agent_turns t ON t.id = d.id
        ORDER BY t.started, t.rowid`,
      row.id,
    ).map((r) => String(r.id));
    const set = JSON.stringify(erased);
    const IN = "IN (SELECT value FROM json_each(?))";
    // A summary under one that goes stands at the top again.
    this.#sql.exec(
      `UPDATE summaries SET parent_id = NULL WHERE parent_id IN (SELECT id FROM summaries
        WHERE through_turn ${IN}) AND through_turn NOT ${IN}`,
      set,
      set,
    );
    this.#sql.exec(`DELETE FROM summaries WHERE through_turn ${IN}`, set);
    for (const table of [
      "items",
      "events",
      "approval_answers",
      "approval_expiry",
      "turn_substitutions",
      "turn_children",
      "agent_origin_turns",
      "cancelled_approvals",
    ])
      this.#sql.exec(`DELETE FROM ${table} WHERE turn ${IN}`, set);
    this.#sql.exec(`DELETE FROM agent_turns WHERE id ${IN}`, set);
    this.#log("session.branch_erased", undefined, { turn: row.id, erased });
    return { erased };
  }

  /**
   * A turn and its ancestors, from any branch, with their items and the summaries on that path:
   * what a fork copies. A running turn refuses it (EBUSY).
   */
  async exportPath(atTurn: string): Promise<SessionHistory> {
    const config = this.#started();
    const at = this.#turnRow(atTurn);
    if (at.status === "running" || at.status === "queued")
      throw codedError("EBUSY", "the turn is running: fork from it once it ended");
    const path = this.#pathTo(this.#treeTurn(at.id).id);
    const json = JSON.stringify(path);
    const turns = path.map((id) => {
      const row = this.#turnRow(id);
      const answers = this.#one<{ approval: string; decision: string; message: string | null }>(
        "SELECT approval, decision, message FROM approval_answers WHERE turn = ?",
        id,
      );
      const substitution = this.#one<ModelSubstitution>(
        "SELECT requested, used, reason FROM turn_substitutions WHERE turn = ?",
        id,
      );
      return {
        id: row.id,
        parent_turn: row.parent_turn ?? null,
        status: row.status,
        delivery: row.delivery,
        content: row.content,
        model_requested: row.model_requested ?? null,
        stop_reason: row.stop_reason ?? null,
        error: row.error ?? null,
        model: row.model ?? null,
        ignored: row.ignored,
        created: Number(row.created),
        started: row.started === null ? null : Number(row.started),
        ended: row.ended === null ? null : Number(row.ended),
        ...(answers
          ? {
              answers: {
                approval: String(answers.approval),
                decision: String(answers.decision),
                message: answers.message === null ? null : String(answers.message),
              },
            }
          : {}),
        ...(substitution
          ? {
              substitution: {
                requested: String(substitution.requested),
                used: String(substitution.used),
                reason: String(substitution.reason),
              },
            }
          : {}),
      };
    });
    const items = this.#rows<ItemRow>(
      "SELECT seq, id, turn, kind, body FROM items WHERE turn IN (SELECT value FROM json_each(?)) ORDER BY seq",
      json,
    ).map((r) => ({
      seq: Number(r.seq),
      id: String(r.id),
      turn: String(r.turn),
      kind: String(r.kind),
      body: String(r.body),
    }));
    const summaries = this.#rows<SessionHistory["summaries"][number]>(
      "SELECT * FROM summaries WHERE through_turn IN (SELECT value FROM json_each(?)) ORDER BY depth, from_seq",
      json,
    ).map((r) => ({
      id: String(r.id),
      depth: Number(r.depth),
      from_seq: Number(r.from_seq),
      to_seq: Number(r.to_seq),
      parent_id: r.parent_id ? String(r.parent_id) : null,
      content: String(r.content),
      sections: r.sections ? String(r.sections) : null,
      tokens: Number(r.tokens),
      through_turn: String(r.through_turn),
      created: Number(r.created),
    }));
    return {
      session: config.id,
      at_turn: at.id,
      turns,
      items,
      summaries,
      ...(config.limits?.length ? { limits: config.limits } : {}),
    };
  }

  /**
   * Copies another session's history into this new session (a fork): new ids, each turn
   * `copied` with `copied_from`, the copy of `at_turn` the head. Nothing is charged, no approval
   * is pending and no sub-agent runs here: what was pending or running stays the source's.
   */
  async importHistory(history: SessionHistory): Promise<{ head: string | null }> {
    const config = this.#started();
    if (this.#one("SELECT 1 FROM agent_turns LIMIT 1"))
      throw codedError("EINVAL", "the session already has turns");
    const h = history as Partial<SessionHistory>;
    if (!Array.isArray(h.turns) || !Array.isArray(h.items) || typeof h.session !== "string")
      throw codedError("EINVAL", "not a session's history");
    const turnIds = new Map<string, string>();
    for (const t of h.turns) turnIds.set(String(t.id), `${config.id}.tu-${crypto.randomUUID()}`);
    for (const t of h.turns) {
      const id = turnIds.get(String(t.id)) as string;
      this.#sql.exec(
        `INSERT INTO agent_turns (id, status, delivery, content, model_requested, pos, stop_reason,
          error, model, ignored, created, started, ended, parent_turn, origin, copied_from)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'copied', ?)`,
        id,
        String(t.status),
        String(t.delivery),
        String(t.content),
        t.model_requested ?? null,
        t.stop_reason ?? null,
        t.error ?? null,
        t.model ?? null,
        String(t.ignored ?? "[]"),
        Number(t.created),
        Number(t.started ?? t.created),
        t.ended === null || t.ended === undefined ? null : Number(t.ended),
        t.parent_turn ? (turnIds.get(String(t.parent_turn)) ?? null) : null,
        JSON.stringify({ session: h.session, turn: String(t.id) }),
      );
      if (t.answers)
        this.#sql.exec(
          "INSERT INTO approval_answers VALUES (?, ?, ?, ?)",
          id,
          String(t.answers.approval),
          String(t.answers.decision),
          t.answers.message ?? null,
        );
      if (t.substitution)
        this.#sql.exec(
          "INSERT INTO turn_substitutions VALUES (?, ?, ?, ?)",
          id,
          String(t.substitution.requested),
          String(t.substitution.used),
          String(t.substitution.reason),
        );
    }
    const seqs = new Map<number, number>();
    const itemIds = new Map<string, string>();
    for (const item of [...h.items].sort((a, b) => Number(a.seq) - Number(b.seq))) {
      const turn = turnIds.get(String(item.turn));
      if (!turn) continue;
      const id = `it-${crypto.randomUUID()}`;
      this.#sql.exec(
        "INSERT INTO items (id, turn, kind, body) VALUES (?, ?, ?, ?)",
        id,
        turn,
        String(item.kind),
        String(item.body),
      );
      const row = this.#one<{ seq: number }>("SELECT seq FROM items WHERE id = ?", id);
      seqs.set(Number(item.seq), Number(row?.seq));
      itemIds.set(String(item.id), id);
    }
    // The summaries on the copied path, over the copied items (their refs too).
    const summaryIds = new Map<string, string>();
    for (const su of h.summaries ?? []) summaryIds.set(String(su.id), `su-${crypto.randomUUID()}`);
    for (const su of h.summaries ?? []) {
      const from = seqs.get(Number(su.from_seq));
      const to = seqs.get(Number(su.to_seq));
      const through = turnIds.get(String(su.through_turn));
      if (from === undefined || to === undefined || !through) continue;
      let sections = su.sections ?? null;
      if (sections)
        try {
          sections = JSON.stringify(
            (JSON.parse(sections) as { refs?: string[] }[]).map((section) => ({
              ...section,
              ...(Array.isArray(section.refs)
                ? { refs: section.refs.map((ref) => itemIds.get(ref) ?? ref) }
                : {}),
            })),
          );
        } catch {
          sections = null;
        }
      this.#sql.exec(
        "INSERT INTO summaries (id, depth, from_seq, to_seq, parent_id, content, sections, tokens, through_turn, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        summaryIds.get(String(su.id)),
        Number(su.depth),
        from,
        to,
        su.parent_id ? (summaryIds.get(String(su.parent_id)) ?? null) : null,
        String(su.content),
        sections,
        Number(su.tokens),
        through,
        Number(su.created),
      );
    }
    const head = turnIds.get(String(h.at_turn)) ?? null;
    this.#setHead(head);
    this.#log("session.head_changed", undefined, { head, previous: null });
    return { head };
  }

  async purge(): Promise<void> {
    this.#started();
    if (this.#running || (await this.status()) === "running")
      throw codedError("EBUSY", "the agent session is running");
    this.#sql.exec(
      "DELETE FROM agent_config; DELETE FROM agent_turns; DELETE FROM items; DELETE FROM events; DELETE FROM approval_answers; DELETE FROM approval_expiry; DELETE FROM turn_substitutions; DELETE FROM summaries; DELETE FROM turn_children; DELETE FROM agent_origin_turns; DELETE FROM cancelled_approvals; DELETE FROM revert_approvals;",
    );
    for (const wake of [...this.#waiters]) wake();
  }
}
