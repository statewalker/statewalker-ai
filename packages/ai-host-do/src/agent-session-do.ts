// One DO per agent session: it holds the session's capability (the user capability its User DO
// attenuated for it; never the access token) and runs its turns on Flue, whose file view is the
// Workspace DO's gate reached with that capability. A file call the gate answers with an
// approval request ends the turn waiting on it; the user's answer continues the session.

import { DurableObject } from "cloudflare:workers";
import { filesOverCalls } from "@statewalker/ai-environment";
import { runFlueTurn } from "@statewalker/ai-flue";
import {
  type AgentSessionConfig,
  AgentSessionCore,
  type ApprovalAnswer,
} from "@statewalker/ai-sessions";
import type { Env } from "./env.js";
import { restTools } from "./rest-tools.js";

export class AgentSession extends DurableObject<Env> {
  readonly #core: AgentSessionCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new AgentSessionCore({
      sql: ctx.storage.sql,
      runTurn: ({ config, content, onApproval, waiting }, emit) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        return runFlueTurn(
          {
            id: config.id,
            agent: config.agent,
            project: config.project,
            files: filesOverCalls(
              (call) => workspace.fileCall(config.capability, call),
              onApproval,
            ),
            model: { baseUrl: String(env.LLM_BASE_URL), model: env.LLM_MODEL || "default" },
            content,
            waiting,
            tools: restTools(env.REST_TOOLS, (call) =>
              workspace.gatewayFetch(config.capability, call),
            ),
          },
          emit,
        );
      },
      runAction: (config, call) =>
        env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace)).fileCall(
          config.capability,
          call,
        ),
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

  answer(approval: string, answer: ApprovalAnswer) {
    return this.#core.answer(approval, answer);
  }
}
