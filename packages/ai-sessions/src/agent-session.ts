// One agent session (statewalker/statewalker-root#89), run by its own DO: it holds its
// configuration and capability, never the user's access token, and owns its turns and items
// (two append-only tables, #108: `items` here; `summaries` come with compaction).
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";
import type {
  AgentPort,
  AgentSessionConfig,
  AgentTurn,
  ApprovalAnswer,
  Item,
  ItemInput,
  StoredAction,
} from "./api.js";
import type { SqlLike } from "./sql.js";

/** A file call a turn made, as the gate's file protocol carries it. */
export type ActionCall =
  | { method: "write"; path: string; content: Uint8Array }
  | { method: "mkdir"; path: string }
  | { method: "remove"; path: string };

/**
 * Runs one turn of the session's core (Flue), reporting each item as it happens. A file call the
 * gate answers with an approval request is reported to `onApproval`; once `waiting()` is true the
 * core ends the turn at the pending call (Flue: a tool result with `terminate`).
 */
export type RunTurn = (
  turn: {
    config: AgentSessionConfig;
    content: string;
    onApproval(request: ApprovalRequest, call: { method: string; path: string }): void;
    waiting(): boolean;
  },
  emit: (item: ItemInput) => void,
) => Promise<void>;

/**
 * Runs one stored action through the gate, re-checked there against the current mode and roles:
 * the gate's answer (an approval request again, when nothing grants it), or its refusal.
 */
export type RunAction = (config: AgentSessionConfig, call: ActionCall) => Promise<unknown>;

const toBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function storedOf(call: { method: string; path: string; content?: unknown }): StoredAction {
  if (call.method !== "write" && call.method !== "mkdir" && call.method !== "remove")
    throw codedError("EINVAL", `no approval stores a '${call.method}'`);
  return {
    method: call.method,
    path: call.path,
    ...(call.content instanceof Uint8Array ? { content: toBase64(call.content) } : {}),
  };
}

function callOf(stored: StoredAction): ActionCall {
  if (stored.method === "write")
    return { method: "write", path: stored.path, content: fromBase64(stored.content ?? "") };
  return { method: stored.method, path: stored.path };
}

interface ItemRow {
  seq: number;
  id: string;
  turn: string;
  kind: string;
  body: string;
}

const itemOf = (row: ItemRow): Item => ({
  ...(JSON.parse(row.body) as Omit<ItemInput, "kind">),
  seq: Number(row.seq),
  id: row.id,
  turn: row.turn,
  kind: row.kind as Item["kind"],
});

export class AgentSessionCore implements AgentPort {
  readonly #sql: SqlLike;
  readonly #runTurn: RunTurn;
  readonly #runAction: RunAction;

  constructor(options: { sql: SqlLike; runTurn: RunTurn; runAction: RunAction }) {
    this.#sql = options.sql;
    this.#runTurn = options.runTurn;
    this.#runAction = options.runAction;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT,
        started INTEGER NOT NULL, ended INTEGER);
      CREATE TABLE IF NOT EXISTS items (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        turn TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);`);
  }

  async start(config: AgentSessionConfig): Promise<void> {
    if (this.config()) throw codedError("EINVAL", `agent session ${config.id} already started`);
    this.#sql.exec("INSERT INTO agent_config VALUES ('config', ?)", JSON.stringify(config));
  }

  /** The session's configuration, once started. */
  config(): AgentSessionConfig | undefined {
    const row = this.#sql.exec("SELECT value FROM agent_config WHERE key = 'config'").toArray()[0];
    return row ? (JSON.parse(String(row.value)) as AgentSessionConfig) : undefined;
  }

  #append(turn: string, item: ItemInput): void {
    const { kind, ...body } = item;
    this.#sql.exec(
      "INSERT INTO items (id, turn, kind, body) VALUES (?, ?, ?, ?)",
      `it-${crypto.randomUUID()}`,
      turn,
      kind,
      JSON.stringify(body),
    );
  }

  #items(turn?: string): Item[] {
    const rows = turn
      ? this.#sql.exec("SELECT * FROM items WHERE turn = ? ORDER BY seq", turn).toArray()
      : this.#sql.exec("SELECT * FROM items ORDER BY seq").toArray();
    return (rows as unknown as ItemRow[]).map(itemOf);
  }

  /** Every item of the session, in order. */
  async items(): Promise<Item[]> {
    return this.#items();
  }

  #begin(config: AgentSessionConfig | undefined): { config: AgentSessionConfig; turn: string } {
    if (!config) throw codedError("ENOENT", "no such agent session");
    const turn = `tu-${crypto.randomUUID()}`;
    this.#sql.exec("INSERT INTO turns VALUES (?, 'running', NULL, ?, NULL)", turn, Date.now());
    return { config, turn };
  }

  #end(
    config: AgentSessionConfig,
    turn: string,
    status: AgentTurn["status"],
    error: string | undefined,
    requests: ApprovalRequest[],
  ): AgentTurn {
    this.#sql.exec(
      "UPDATE turns SET status = ?, error = ?, ended = ? WHERE id = ?",
      status,
      error ?? null,
      Date.now(),
      turn,
    );
    return {
      id: turn,
      session: config.id,
      status,
      ...(error ? { error } : {}),
      items: this.#items(turn),
      ...(requests.length ? { requests } : {}),
    };
  }

  /** Stores each pending action in the session's items, once per approval. */
  #pending(turn: string, pending: Map<string, { request: ApprovalRequest; stored: StoredAction }>) {
    for (const { request, stored } of pending.values())
      this.#append(turn, { kind: "approval", approval: request.id, request, stored });
    return [...pending.values()].map((p) => p.request);
  }

  /** One turn: the user's message, then what the core does with it. */
  async send(content: string): Promise<AgentTurn> {
    const { config, turn } = this.#begin(this.config());
    this.#append(turn, { kind: "message", role: "user", text: content });
    const pending = new Map<string, { request: ApprovalRequest; stored: StoredAction }>();
    let error: string | undefined;
    try {
      await this.#runTurn(
        {
          config,
          content,
          onApproval: (request, call) => {
            if (!pending.has(request.id))
              pending.set(request.id, { request, stored: storedOf(call) });
          },
          waiting: () => pending.size > 0,
        },
        (item) => this.#append(turn, item),
      );
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
    const requests = this.#pending(turn, pending);
    const status = error ? "failed" : requests.length ? "pending" : "completed";
    return this.#end(config, turn, status, error, requests);
  }

  /**
   * Continues the session with the user's answer to an approval it waits on: a denial is told as
   * the call's result, with the user's message; an allow runs exactly the stored action through
   * the gate, which re-checks it against the current mode and roles.
   */
  async answer(approval: string, answer: ApprovalAnswer): Promise<AgentTurn> {
    const config = this.config();
    const stored = this.#items()
      .filter((i) => i.kind === "approval" && i.approval === approval)
      .at(-1);
    if (!stored?.stored || !stored.request) throw codedError("ENOENT", "no such approval");
    const { turn } = this.#begin(config);
    const pending = new Map<string, { request: ApprovalRequest; stored: StoredAction }>();
    const { method, path } = stored.stored;
    if (answer.decision === "deny") {
      const why = answer.message ? `: ${answer.message}` : "";
      this.#append(turn, {
        kind: "tool_result",
        approval,
        output: `denied by the user${why}`,
        isError: true,
      });
    } else {
      try {
        const result = await this.#runAction(config as AgentSessionConfig, callOf(stored.stored));
        if (result && typeof result === "object" && "$approval" in result) {
          const request = (result as { $approval: ApprovalRequest }).$approval;
          pending.set(request.id, { request, stored: stored.stored });
        } else
          this.#append(turn, {
            kind: "tool_result",
            approval,
            output: `${method} ${path}: done`,
            isError: false,
          });
      } catch (e) {
        this.#append(turn, {
          kind: "tool_result",
          approval,
          output: String((e as Error)?.message ?? e),
          isError: true,
        });
      }
    }
    const requests = this.#pending(turn, pending);
    return this.#end(
      config as AgentSessionConfig,
      turn,
      requests.length ? "pending" : "completed",
      undefined,
      requests,
    );
  }
}
