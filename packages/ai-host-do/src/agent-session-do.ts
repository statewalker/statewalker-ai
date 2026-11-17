// One DO per agent session: it holds the session's capability (never the access token) and runs
// its turns on Flue, whose file view is the Workspace DO's gate reached with that capability.

import { DurableObject } from "cloudflare:workers";
import { filesOverCalls } from "@statewalker/ai-environment";
import { runFlueTurn } from "@statewalker/ai-flue";
import { type AgentSessionConfig, AgentSessionCore } from "@statewalker/ai-sessions";
import type { Env } from "./env.js";

export class AgentSession extends DurableObject<Env> {
  readonly #core: AgentSessionCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new AgentSessionCore({
      sql: ctx.storage.sql,
      runTurn: ({ config, content }, emit) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        return runFlueTurn(
          {
            id: config.id,
            agent: config.agent,
            project: config.project,
            files: filesOverCalls((call) => workspace.fileCall(config.capability, call)),
            model: { baseUrl: String(env.LLM_BASE_URL), model: env.LLM_MODEL || "default" },
            content,
          },
          emit,
        );
      },
    });
  }

  start(config: AgentSessionConfig): Promise<void> {
    return this.#core.start(config);
  }

  send(content: string) {
    return this.#core.send(content);
  }

  items() {
    return this.#core.items();
  }
}
