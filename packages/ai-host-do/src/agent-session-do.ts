// One DO per agent session: it holds the session's capability (the user capability its User DO
// attenuated for it; never the access token or a provider key) and runs its turns on Flue, whose
// models are the Workspace DO's model gateway and whose file view is the
// Workspace DO's gate reached with that capability: a webrun-files-rpc client whose calls travel on
// the Workspace DO's stub. A file call the gate stops for an approval ends the turn waiting on it;
// the user's answer continues the session. Long sessions are compacted into hierarchical summaries
// (statewalker/statewalker-root#131) by a summarizer on the same model, tuned by the deployment's
// COMPACTION var; each turn starts from the shaped context.

import { DurableObject } from "cloudflare:workers";
import { approvalAware, filesOverRpc, runStoredCall } from "@statewalker/ai-environment";
import { completeWith, type ModelPort, runFlueTurn, TRACER_TOOLS } from "@statewalker/ai-flue";
import {
  type AgentMessage,
  type AgentSessionConfig,
  AgentSessionCore,
  type ApprovalAnswer,
  type ApprovalRequest,
  createModelSummarizer,
  type EventsQuery,
  type GateDecisionInput,
  type ItemsQuery,
  parseCompaction,
} from "@statewalker/ai-sessions";
import {
  type DatabaseHost,
  DB_TOOLS,
  databaseTools,
  runDatabaseAction,
  runStoredDatabaseCall,
} from "./db-tools.js";
import { agentOf, blockSizeOf, type Env, userOf } from "./env.js";
import { refusal, SessionLimits, type WarningView, warningView } from "./limits-host.js";
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
  const accepted = await child.send({
    content: message,
    delivery: "next",
    ignored: [],
    // The parent agent wrote it: never the user's words to the child's risk classifier.
    origin: "agent",
  });
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

/** The database gate as a holder of `capability` reaches it, in its own project. */
function databaseHost(env: Env, config: AgentSessionConfig, capability: string): DatabaseHost {
  const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
  return {
    call: (req) => workspace.databaseCall(capability, req),
    manage: (req) => workspace.manageDatabase(capability, req),
    list: () => workspace.listDatabases(capability),
  };
}

export class AgentSession extends DurableObject<Env> {
  readonly #core: AgentSessionCore;
  /** The session level's limits and counters (statewalker/statewalker-root#179). */
  readonly #limits: SessionLimits;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#limits = new SessionLimits(ctx.storage.sql, env);
    // Every model request goes through the workspace's model gateway, with the session's
    // capability: it picks the model within the user's rights, holds the provider's key, falls
    // back and meters (statewalker/statewalker-root#134).
    const gateway = (config: AgentSessionConfig, turn?: string): ModelPort => {
      const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
      return {
        request: (call) =>
          workspace.modelRequest(config.capability, { ...call, ...(turn ? { turn } : {}) }),
      };
    };
    const compaction = parseCompaction(env.COMPACTION);
    for (const problem of compaction.problems) console.warn(`COMPACTION: ${problem}`);
    this.#core = new AgentSessionCore({
      sql: ctx.storage.sql,
      compaction: {
        // The summarizer runs on the session's model, through the gateway like every request.
        summarizer: createModelSummarizer({
          complete: (req) => {
            const config = this.#core.config();
            if (!config) throw new Error("ENOENT: no such agent session");
            return completeWith(gateway(config))(req);
          },
        }),
        options: compaction.options,
      },
      runTurn: (
        { config, turn, content, model, context, signal, onSteer, onApproval, waiting },
        emit,
      ) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        const rest = restTools(env.REST_TOOLS, (call) =>
          workspace.gatewayFetch(config.capability, call),
        );
        // The tools this session is offered: a sub-agent's are within its parent's.
        // `agent.start` only for an agent whose definition lists sub-agents the user may use.
        const delegates = (config.run?.agents ?? []).length > 0;
        // The project's databases, at the gate with the session's capability (#136).
        const databases = databaseTools(databaseHost(env, config, config.capability), onApproval);
        const offered = [
          ...TRACER_TOOLS,
          ...DB_TOOLS,
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
            models: gateway(config, turn),
            ...(config.model ? { model: config.model } : {}),
            ...(model ? { requested: model } : {}),
            content,
            context,
            waiting,
            signal,
            onSteer,
            tools: [...databases, ...rest, agentStart],
            allowTools: offered,
            // Every tool call counts against the limits on tool calls (#179): a refused call is
            // not run, and the agent carries on with the refusal.
            admitTool: async (name) => {
              try {
                const crossed = await this.#charge(config, "tool_calls", 1, turn, { tool: name });
                for (const warning of crossed) emit({ kind: "limit_warning", warning });
                return undefined;
              } catch (e) {
                return String((e as Error)?.message ?? e);
              }
            },
          },
          emit,
        );
      },
      runAction: (config, call) => {
        if (call.method === "db")
          return runStoredDatabaseCall(databaseHost(env, config, config.capability), call);
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

  /**
   * Charges a flow meter of a turn to the session (counted here) and to its member, project and
   * workspace (counted in the Workspace DO), refusing at the first limit: the session's is
   * checked first, then the workspace charges, then the session.
   */
  async #charge(
    config: AgentSessionConfig,
    meter: string,
    amount: number,
    turn?: string,
    detail?: Record<string, unknown>,
  ): Promise<WarningView[]> {
    const scopes = this.#limits.scopes(config);
    try {
      this.#limits.ledger.check(scopes, { [meter]: amount });
    } catch (e) {
      throw refusal(e);
    }
    const workspace = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(config.workspace));
    const crossed = await workspace.chargeUsage(config.capability, {
      meter,
      amount,
      ...(turn ? { turn } : {}),
      ...(detail ? { detail } : {}),
    });
    const own = this.#limits.ledger.charge(
      scopes,
      { [meter]: amount },
      this.#limits.meta(config, turn),
      detail,
    );
    return [...crossed, ...own.map(warningView)];
  }

  /**
   * A message: a new turn (a steer joins the running one) counts against the limits on turns of
   * the session, its member, project and workspace, at once; ELIMIT (429) over one.
   */
  async send(message: AgentMessage) {
    const config = this.#core.config();
    const crossed =
      config && message.delivery !== "steer" ? await this.#charge(config, "turns", 1) : [];
    const accepted = await this.#core.send(message);
    if (crossed.length) this.#core.warn(accepted.turn_id, crossed);
    return accepted;
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

  /**
   * Told by the Workspace DO's gate: one decision of auto mode (statewalker/statewalker-root#137),
   * kept as an item; a block of the risk classifier is also recorded with the user's User DO, for
   * /v1/me and a retry.
   */
  async gateDecision(decision: GateDecisionInput): Promise<void> {
    await this.#core.gateDecision(decision);
    const config = this.#core.config();
    if (config && decision.request && decision.verdict === "deny" && decision.step === "classifier")
      await userOf(this.env, config.user).recordBlocked(config.id, decision.request);
  }

  /** Told by the Workspace DO's gate: what auto mode's risk classifier may see of the session. */
  classifierItems() {
    return this.#core.classifierItems();
  }

  answer(approval: string, answer: ApprovalAnswer) {
    return this.#core.answer(approval, answer);
  }

  /**
   * Test-only (the Worker admits it only with the ADMIN_KEY), until tool scripts run
   * (statewalker/statewalker-root#130): one database call as a plugin tool of this session makes
   * it, with the capability the workspace narrows for that tool.
   */
  async toolDatabase(call: {
    plugin: string;
    tool: string;
    database: string;
    op: "query" | "exec";
    sql: string;
    params?: unknown[];
  }) {
    const config = this.#core.config();
    if (!config) throw new Error("ENOENT: no such agent session");
    const workspace = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(config.workspace));
    const capability = await workspace.forTool(config.capability, {
      plugin: String(call.plugin),
      tool: String(call.tool),
    });
    const op = call.op === "exec" ? "exec" : "query";
    const rows = await runDatabaseAction(
      databaseHost(this.env, config, capability),
      call.database,
      {
        op,
        sql: String(call.sql),
        ...(Array.isArray(call.params) ? { params: call.params } : {}),
      },
    );
    return op === "query" ? { rows } : {};
  }
}
