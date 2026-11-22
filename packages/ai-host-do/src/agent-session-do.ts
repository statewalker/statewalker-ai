// One DO per agent session: it holds the session's capability (the user capability its User DO
// attenuated for it; never the access token) and runs its turns on Flue, whose file view is the
// Workspace DO's gate reached with that capability: a webrun-files-rpc client whose calls travel on
// the Workspace DO's stub. A file call the gate stops for an approval ends the turn waiting on it;
// the user's answer continues the session. Long sessions are compacted into hierarchical summaries
// (statewalker/statewalker-root#131) by a summarizer on the same model, tuned by the deployment's
// COMPACTION var; each turn starts from the shaped context.

import { DurableObject } from "cloudflare:workers";
import { approvalAware, filesOverRpc, runStoredCall } from "@statewalker/ai-environment";
import { completeWith, type ModelConfig, runFlueTurn, TRACER_TOOLS } from "@statewalker/ai-flue";
import {
  type AgentMessage,
  type AgentSessionConfig,
  AgentSessionCore,
  type ApprovalAnswer,
  type ApprovalRequest,
  createModelSummarizer,
  type EventsQuery,
  type ItemsQuery,
  parseCompaction,
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
    const model: ModelConfig = {
      baseUrl: String(env.LLM_BASE_URL),
      model: env.LLM_MODEL || "default",
    };
    const compaction = parseCompaction(env.COMPACTION);
    for (const problem of compaction.problems) console.warn(`COMPACTION: ${problem}`);
    this.#core = new AgentSessionCore({
      sql: ctx.storage.sql,
      compaction: {
        summarizer: createModelSummarizer({ complete: completeWith(model) }),
        options: compaction.options,
      },
      runTurn: ({ config, content, context, signal, onSteer, onApproval, waiting }, emit) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        const rest = restTools(env.REST_TOOLS, (call) =>
          workspace.gatewayFetch(config.capability, call),
        );
        // The tools this session is offered: a sub-agent's are within its parent's.
        // `agent.start` only for an agent whose definition lists sub-agents the user may use.
        const delegates = (config.run?.agents ?? []).length > 0;
        const offered = [
          ...TRACER_TOOLS,
          ...rest.map((t) => t.name),
          ...(delegates ? [AGENT_START] : []),
        ].filter((name) => !config.tools || config.tools.includes(name));
        const agentStart = agentStartTool(offered, {
          startSubAgent: (req) =>
            userOf(env, config.user).startSubAgent(config.id, config.capability, req),
          run: (child, message, signal) => runChild(env, child, message, signal),
        });
        return runFlueTurn(
          {
            id: config.id,
            agent: config.agent,
            ...(config.run ? { instructions: config.run.instructions } : {}),
            project: config.project,
            files: approvalAware(
              filesOverRpc((method, args) => workspace.files(config.capability, method, args), {
                blockSize: blockSizeOf(env),
              }),
              onApproval,
            ),
            // The agent's first model the user may use, else the deployment's (the model gateway
            // comes in a later ticket).
            model: {
              baseUrl: String(env.LLM_BASE_URL),
              model: config.run?.models[0] ?? model.model,
            },
            content,
            context,
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
