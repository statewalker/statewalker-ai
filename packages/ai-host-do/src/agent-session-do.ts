// One DO per agent session: it holds the session's capability (the user capability its User DO
// attenuated for it; never the access token) and runs its turns on Flue, whose file view is the
// Workspace DO's gate reached with that capability: a webrun-files-rpc client whose calls travel on
// the Workspace DO's stub. A file call the gate stops for an approval ends the turn waiting on it;
// the user's answer continues the session.

import { DurableObject } from "cloudflare:workers";
import { approvalAware, filesOverRpc, runStoredCall } from "@statewalker/ai-environment";
import { runFlueTurn, TRACER_TOOLS } from "@statewalker/ai-flue";
import {
  type AgentMessage,
  type AgentSessionConfig,
  AgentSessionCore,
  type ApprovalAnswer,
  type ApprovalRequest,
  type EventsQuery,
  type ItemsQuery,
} from "@statewalker/ai-sessions";
import { agentOf, blockSizeOf, type Env, userOf } from "./env.js";
import { restTools } from "./rest-tools.js";
import { AGENT_START, agentStartTool } from "./sub-agents.js";

/**
 * Runs a sub-agent's first turn: starts its DO, sends it the message, and waits for the turn to
 * end; cancelling the parent's turn cancels the child's.
 */
async function runChild(
  env: Env,
  config: AgentSessionConfig,
  message: string,
  signal?: AbortSignal,
) {
  const child = agentOf(env, config.id);
  await child.start(config);
  const accepted = await child.send({ content: message, delivery: "next", ignored: [] });
  if (!signal) return child.waitTurn(accepted.turn_id);
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void (async () => {
        try {
          await child.cancel(accepted.turn_id);
        } catch {
          // The child's turn already ended.
        }
      })();
      reject(signal.reason ?? new Error("EINTR: the turn was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([child.waitTurn(accepted.turn_id), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class AgentSession extends DurableObject<Env> {
  readonly #core: AgentSessionCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new AgentSessionCore({
      sql: ctx.storage.sql,
      runTurn: ({ config, content, signal, onSteer, onApproval, waiting }, emit) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        const rest = restTools(env.REST_TOOLS, (call) =>
          workspace.gatewayFetch(config.capability, call),
        );
        // The tools this session is offered: a sub-agent's are within its parent's.
        const offered = [...TRACER_TOOLS, ...rest.map((t) => t.name), AGENT_START].filter(
          (name) => !config.tools || config.tools.includes(name),
        );
        const agentStart = agentStartTool(offered, {
          startSubAgent: (req) =>
            userOf(env, config.user).startSubAgent(config.id, config.capability, req),
          run: (child, message, signal) => runChild(env, child, message, signal),
        });
        return runFlueTurn(
          {
            id: config.id,
            agent: config.agent,
            project: config.project,
            files: approvalAware(
              filesOverRpc((method, args) => workspace.files(config.capability, method, args), {
                blockSize: blockSizeOf(env),
              }),
              onApproval,
            ),
            model: { baseUrl: String(env.LLM_BASE_URL), model: env.LLM_MODEL || "default" },
            content,
            waiting,
            signal,
            onSteer,
            tools: [...rest, agentStart],
            allowTools: offered,
          },
          emit,
        );
      },
      runAction: (config, call) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        const files = filesOverRpc(
          (method, args) => workspace.files(config.capability, method, args),
          { blockSize: blockSizeOf(env) },
        );
        return runStoredCall(files, call);
      },
      // An agent session → user call (a Workspace DO never calls a User DO).
      recordApprovals: async (config, requests) => {
        await userOf(env, config.user).recordApprovals(config.id, requests);
        // A sub-agent's approvals also go to its root session's events stream.
        if (config.root && config.root !== config.id)
          await agentOf(env, config.root).subAgentApprovals(config.id, requests);
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

  /** Told by a sub-agent's DO: the approvals its turn waits on, for this root's events stream. */
  subAgentApprovals(session: string, requests: ApprovalRequest[]) {
    return this.#core.subAgentApprovals(session, requests);
  }

  answer(approval: string, answer: ApprovalAnswer) {
    return this.#core.answer(approval, answer);
  }
}
