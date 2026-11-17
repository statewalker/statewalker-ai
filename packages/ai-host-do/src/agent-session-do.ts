// One DO per agent session: it holds the session's capability (never the access token).

import { DurableObject } from "cloudflare:workers";
import { type AgentSessionConfig, AgentSessionCore } from "@statewalker/ai-sessions";
import type { Env } from "./env.js";

export class AgentSession extends DurableObject<Env> {
  readonly #core: AgentSessionCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new AgentSessionCore({ sql: ctx.storage.sql });
  }

  start(config: AgentSessionConfig): Promise<void> {
    return this.#core.start(config);
  }
}
