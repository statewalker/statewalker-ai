// One DO per agent session: it holds the session's capability (the user capability its User DO
// attenuated for it; never the access token) and runs its turns on Flue, whose file view is the
// Workspace DO's gate reached with that capability: a webrun-files-rpc client whose calls travel on
// the Workspace DO's stub.

import { DurableObject } from "cloudflare:workers";
import { filesOverRpc } from "@statewalker/ai-environment";
import { runFlueTurn } from "@statewalker/ai-flue";
import { type AgentSessionConfig, AgentSessionCore } from "@statewalker/ai-sessions";
import { blockSizeOf, type Env } from "./env.js";
import { restTools } from "./rest-tools.js";

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
            files: filesOverRpc(
              (method, args) => workspace.files(config.capability, method, args),
              { blockSize: blockSizeOf(env) },
            ),
            model: { baseUrl: String(env.LLM_BASE_URL), model: env.LLM_MODEL || "default" },
            content,
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

  send(content: string) {
    return this.#core.send(content);
  }

  items() {
    return this.#core.items();
  }
}
