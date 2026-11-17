// One agent session (statewalker/statewalker-root#89), run by its own DO: it holds its
// configuration and capability, never the user's access token, and owns its turns and items
// (two append-only tables, #108: `items` here; `summaries` come with compaction).
import { codedError } from "@statewalker/ai-access";
import type { AgentPort, AgentSessionConfig, Item, ItemInput, TurnView } from "./api.js";
import type { SqlLike } from "./sql.js";

/** Runs one turn of the session's core (Flue), reporting each item as it happens. */
export type RunTurn = (
  turn: { config: AgentSessionConfig; content: string },
  emit: (item: ItemInput) => void,
) => Promise<void>;

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

  constructor(options: { sql: SqlLike; runTurn: RunTurn }) {
    this.#sql = options.sql;
    this.#runTurn = options.runTurn;
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

  /** One turn: the user's message, then what the core does with it. */
  async send(content: string): Promise<TurnView> {
    const config = this.config();
    if (!config) throw codedError("ENOENT", "no such agent session");
    const turn = `tu-${crypto.randomUUID()}`;
    this.#sql.exec("INSERT INTO turns VALUES (?, 'running', NULL, ?, NULL)", turn, Date.now());
    this.#append(turn, { kind: "message", role: "user", text: content });
    let status: TurnView["status"] = "completed";
    let error: string | undefined;
    try {
      await this.#runTurn({ config, content }, (item) => this.#append(turn, item));
    } catch (e) {
      status = "failed";
      error = String((e as Error)?.message ?? e);
    }
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
    };
  }
}
