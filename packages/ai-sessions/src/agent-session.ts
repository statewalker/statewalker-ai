// One agent session (statewalker/statewalker-root#89), run by its own DO: it holds its
// configuration and capability, never the user's access token.
import { codedError } from "@statewalker/ai-access";
import type { AgentPort, AgentSessionConfig } from "./api.js";
import type { SqlLike } from "./sql.js";

export class AgentSessionCore implements AgentPort {
  readonly #sql: SqlLike;

  constructor(options: { sql: SqlLike }) {
    this.#sql = options.sql;
    this.#sql.exec("CREATE TABLE IF NOT EXISTS agent_config (key TEXT PRIMARY KEY, value TEXT)");
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
}
