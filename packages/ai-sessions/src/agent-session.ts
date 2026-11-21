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
//   continues the session as a turn that runs the stored call again (re-checked at the gate) or
//   tells the model the denial.
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";
import type {
  AgentMessage,
  AgentPort,
  AgentSessionConfig,
  ApprovalAnswer,
  Delivery,
  EventsPage,
  EventsQuery,
  Item,
  ItemInput,
  ItemsPage,
  ItemsQuery,
  MessageAccepted,
  SessionEvent,
  SessionStatus,
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
  /** The user's message. */
  content: string;
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

/** Tells the session's User DO the approvals a turn waits on. */
export type RecordApprovals = (
  config: AgentSessionConfig,
  requests: ApprovalRequest[],
) => Promise<void>;

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
    ...(stored.method === "write" ? { content: fromBase64(stored.content ?? "") } : {}),
  };
}

type Pending = Map<string, { request: ApprovalRequest; stored: StoredAction }>;

/** What the core reports when a turn ends. */
export interface TurnOutcome {
  /** The model the turn ran on. */
  model?: string;
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
  done: Promise<void>;
}

const eventOf = (row: EventRow): SessionEvent => ({
  seq: Number(row.seq),
  type: row.type,
  ...(row.turn ? { turn: row.turn } : {}),
  data: JSON.parse(row.data),
  created: Number(row.created),
});

const TERMINAL: readonly string[] = ["waiting", "completed", "failed", "cancelled", "interrupted"];
const KINDS: readonly string[] = ["message", "tool_call", "tool_result", "approval"];
const MAX_PAGE = 1000;
const MAX_WAIT_MS = 60_000;

function pageSize(limit: unknown, fallback: number): number {
  if (limit === undefined || limit === null || limit === "") return fallback;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) throw codedError("EINVAL", "limit must be a positive integer");
  return Math.min(n, MAX_PAGE);
}

export class AgentSessionCore implements AgentPort {
  readonly #sql: SqlLike;
  readonly #runTurn: RunTurn;
  readonly #runAction: RunAction;
  readonly #recordApprovals: RecordApprovals;
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
     * Compaction: without a summarizer, nothing is compacted (the context is every earlier item,
     * long tool results outside the tail trimmed).
     */
    compaction?: { summarizer?: Summarizer; options?: Partial<CompactionOptions> };
  }) {
    this.#sql = options.sql;
    this.#runTurn = options.runTurn;
    this.#runAction = options.runAction;
    this.#recordApprovals = options.recordApprovals;
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
        decision TEXT NOT NULL, message TEXT);`);
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
    const requested = row.model_requested ?? undefined;
    return {
      id: row.id,
      session: config?.id ?? "",
      status: row.status,
      delivery: row.delivery,
      ...(row.stop_reason ? { stop_reason: JSON.parse(row.stop_reason) as StopReason } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(model ? { model } : {}),
      ...(model && requested && requested !== model
        ? {
            model_substitution: {
              requested,
              used: model,
              reason: "the session's capability holds no right to the requested model",
            },
          }
        : {}),
      ...(ignored.length ? { ignored } : {}),
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
    let error: string | undefined;
    let outcome: TurnOutcome | undefined;
    if (answer) {
      try {
        await this.#answerTurn(config, row.id, answer, pending);
      } catch (e) {
        error = String((e as Error)?.message ?? e);
      }
    } else {
      const prompt = this.#append(row.id, { kind: "message", role: "user", text: row.content });
      try {
        const context = await this.#context(row.id, prompt.seq, running.abort.signal);
        outcome = await this.#runTurn(
          {
            config,
            content: row.content,
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
    // The changes the turn waits on: stored in its items, and told to the user's User DO before
    // the turn ends, so the turn's terminal event and the user's approvals agree.
    if (!running.endAs && !error && pending.size) {
      for (const { request, stored } of pending.values())
        this.#append(row.id, { kind: "approval", approval: request.id, request, stored });
      try {
        await this.#recordApprovals(
          config,
          [...pending.values()].map((p) => p.request),
        );
      } catch (e) {
        error = `the approvals could not be recorded: ${String((e as Error)?.message ?? e)}`;
      }
    }
    if (running.endAs)
      this.#finish(row.id, running.endAs, { type: running.endAs }, model ? { model } : {});
    else if (error)
      this.#finish(
        row.id,
        "failed",
        { type: "error", message: error },
        { error, ...(model ? { model } : {}) },
      );
    else if (pending.size)
      this.#finish(
        row.id,
        "waiting",
        { type: "approval", approval_ids: [...pending.keys()] },
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
   * A turn continuing the session with the user's answer to an approval: a denial is told as the
   * call's result, with the user's message; an allow runs exactly the stored call again through
   * the gate, which re-checks it against the current mode and roles.
   */
  async #answerTurn(
    config: AgentSessionConfig,
    turn: string,
    answer: { approval: string; decision: string; message: string | null },
    pending: Pending,
  ): Promise<void> {
    const item = this.#rows<ItemRow>(
      "SELECT * FROM items WHERE kind = 'approval' ORDER BY seq DESC",
    )
      .map(itemOf)
      .find((i) => i.approval === answer.approval);
    if (!item?.stored || !item.request) throw codedError("ENOENT", "no such approval");
    const { method, path, target } = item.stored;
    const result = (output: string, isError: boolean) =>
      this.#append(turn, { kind: "tool_result", approval: answer.approval, output, isError });
    if (answer.decision !== "allow") {
      result(`denied by the user${answer.message ? `: ${answer.message}` : ""}`, true);
      return;
    }
    try {
      const done = await this.#runAction(config, callOf(item.stored));
      if (done && typeof done === "object" && "$approval" in done) {
        const request = (done as { $approval: ApprovalRequest }).$approval;
        pending.set(request.id, { request, stored: item.stored });
      } else result(`${method} ${path}${target ? ` ${target}` : ""}: done`, false);
    } catch (e) {
      result(String((e as Error)?.message ?? e), true);
    }
  }

  /** Cuts the running turn short, and waits for it to end. */
  async #cut(running: Running, as: "cancelled" | "interrupted"): Promise<void> {
    running.endAs ??= as;
    running.abort.abort(new Error(`EINTR: the turn was ${as}`));
    await running.done;
  }

  // --- the port -------------------------------------------------------------------------------

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
    const known = this.#rows<ItemRow>("SELECT * FROM items WHERE kind = 'approval'")
      .map(itemOf)
      .some((i) => i.approval === approval);
    if (!known) throw codedError("ENOENT", "no such approval");
    const content = `${answer.decision === "allow" ? "allowed" : "denied"}: ${approval}`;
    const id = this.#queue(config, { content, delivery: "next", ignored: [] }, false);
    this.#sql.exec(
      "INSERT INTO approval_answers VALUES (?, ?, ?, ?)",
      id,
      approval,
      answer.decision,
      answer.message ?? null,
    );
    this.#pump();
    return { turn_id: id, session_id: config.id, delivery: "next", offset };
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
      "DELETE FROM agent_config; DELETE FROM agent_turns; DELETE FROM items; DELETE FROM events; DELETE FROM approval_answers; DELETE FROM summaries;",
    );
    for (const wake of [...this.#waiters]) wake();
  }
}
