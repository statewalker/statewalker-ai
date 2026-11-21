// One DO per agent session: it holds the session's capability (the user capability its User DO
// attenuated for it; never the access token) and runs its turns on Flue, whose file view is the
// Workspace DO's gate reached with that capability.

import { DurableObject } from "cloudflare:workers";
import { filesOverCalls } from "@statewalker/ai-environment";
import { runFlueTurn } from "@statewalker/ai-flue";
import {
  type AgentMessage,
  type AgentSessionConfig,
  AgentSessionCore,
  type EventsQuery,
  type ItemsQuery,
} from "@statewalker/ai-sessions";
import type { Env } from "./env.js";
import { restTools } from "./rest-tools.js";

export class AgentSession extends DurableObject<Env> {
  readonly #core: AgentSessionCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new AgentSessionCore({
      sql: ctx.storage.sql,
      runTurn: ({ config, content, signal, onSteer }, emit) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        return runFlueTurn(
          {
            id: config.id,
            agent: config.agent,
            project: config.project,
            files: filesOverCalls((call) => workspace.fileCall(config.capability, call)),
            model: { baseUrl: String(env.LLM_BASE_URL), model: env.LLM_MODEL || "default" },
            content,
            signal,
            onSteer,
            tools: restTools(env.REST_TOOLS, (call) =>
              workspace.gatewayFetch(config.capability, call),
            ),
          },
          emit,
        );
      },
    });
  }

  start(config: AgentSessionConfig): Promise<void> {
    return this.#core.start(config);
  }

  send(message: AgentMessage) {
    return this.#core.send(message);
  }

  turn(turnId: string) {
    return this.#core.turn(turnId);
  }

  /** Waits for a turn to end (test-only admin route). */
  waitTurn(turnId: string) {
    return this.#core.waitTurn(turnId);
  }

  cancel(turnId: string) {
    return this.#core.cancel(turnId);
  }

  items(query?: ItemsQuery) {
    return this.#core.items(query);
  }

  item(itemId: string) {
    return this.#core.item(itemId);
  }

  events(query?: EventsQuery) {
    return this.#core.events(query);
  }

  status() {
    return this.#core.status();
  }

  archive() {
    return this.#core.archive();
  }

  purge() {
    return this.#core.purge();
  }
}
