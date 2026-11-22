// One DO per agent session: it holds the session's capability (the user capability its User DO
// attenuated for it; never the access token or a provider key) and runs its turns as one Flue
// session of Flue's Cloudflare-target runtime, hosted on this DO (its coordinator on the DO's
// SQLite, woken by the DO's alarm; statewalker/statewalker-root#128). Its models are the Workspace
// DO's model gateway and its sandbox is the Workspace DO's gate reached with that capability: a
// webrun-files-rpc client whose calls travel on the Workspace DO's stub. A file call the gate stops
// for an approval ends the turn waiting on it; the user's answer continues the session. Flue's own
// compaction is off: long sessions are compacted into hierarchical summaries
// (statewalker/statewalker-root#131) by a summarizer on the same model, tuned by the deployment's
// COMPACTION var; each turn starts from the shaped context.

import { DurableObject } from "cloudflare:workers";
import { TOOL_EXTENSION, type ToolDefinition } from "@statewalker/ai-definitions";
import {
  approvalAware,
  approvalOf,
  filesOverRpc,
  runStoredCall,
  type StoredCall,
} from "@statewalker/ai-environment";
import {
  completeWith,
  FlueSession,
  type HostTool,
  type ModelPort,
  purgeFlue,
  TRACER_TOOLS,
} from "@statewalker/ai-flue";
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
  type McpMessage,
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
import { answerMcp, executionModeOf, harnessDefinition, pluginHostTool } from "./session-tools.js";
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
  #flue?: FlueSession;

  /** The session's Flue session on this DO (the Flue instance id is the session's id). */
  #flueOf(session: string): FlueSession {
    this.#flue ??= new FlueSession({ state: this.ctx, env: this.env, session });
    return this.#flue;
  }

  /**
   * The session's tool set now (statewalker/statewalker-root#129): Flue's tools over its sandbox,
   * the harness's own and the plugin tools the Workspace DO offers it (its agent's request, its
   * user's role and the mode), a sub-agent's within its parent's. The model is offered exactly
   * these, and the MCP endpoint lists the same documents.
   */
  async #tools(
    config: AgentSessionConfig,
    onApproval: (request: ApprovalRequest, call: StoredCall) => void,
  ) {
    const env = this.env;
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
    const within = (name: string) => !config.tools || config.tools.includes(name);
    // `agent.start` only for an agent whose definition lists sub-agents the user may use.
    const delegates = (config.run?.agents ?? []).length > 0;
    const named = [...DB_TOOLS, ...(delegates ? [AGENT_START] : [])].filter(within);
    const set = (await workspace.sessionTools(config.capability, named)) as unknown as {
      harness: string[];
      tools: ToolDefinition[];
    };
    const plugins = set.tools.filter((d) => within(d[TOOL_EXTENSION].name));
    const offered = [
      ...TRACER_TOOLS.filter(within),
      ...set.harness,
      ...plugins.map((d) => d[TOOL_EXTENSION].name),
    ];
    // The project's databases, at the gate with the session's capability (#136).
    const harness: HostTool[] = [
      ...databaseTools(databaseHost(env, config, config.capability), onApproval),
      agentStartTool(offered, {
        startSubAgent: (req) =>
          userOf(env, config.user).startSubAgent(config.id, config.capability, req),
        run: (child, message, signal) => runChild(env, child, message, signal),
      }),
    ]
      .filter((t) => set.harness.includes(t.name))
      .map((t) => ({ ...t, executionMode: executionModeOf(harnessDefinition(t)) }));
    let waitingOn: ApprovalRequest | undefined;
    const pluginTools = plugins.map((d) =>
      pluginHostTool(
        d,
        (args) => workspace.callTool(config.capability, { name: d[TOOL_EXTENSION].name, args }),
        {
          onApproval,
          waitingOn: () => waitingOn,
          wait: (request) => {
            waitingOn = request;
          },
        },
      ),
    );
    const hostTools = [...harness, ...pluginTools];
    return {
      offered,
      hostTools,
      definitions: [...harness.map(harnessDefinition), ...plugins],
    };
  }

  /**
   * The session's own MCP endpoint (`/v1/sessions/{id}/mcp`, statewalker/statewalker-root#129): it
   * lists and calls exactly the tools the session's model is offered, re-read at every message.
   * A call the mode asks about is refused with the approval it waits on.
   */
  async mcp(message: McpMessage) {
    const config = this.#core.config();
    if (!config) throw new Error("ENOENT: no such agent session");
    const set = () => this.#tools(config, () => {});
    return answerMcp(message, {
      tools: async () => (await set()).definitions,
      call: async (d, args) => {
        const tool = (await set()).hostTools.find((t) => t.name === d[TOOL_EXTENSION].name);
        if (!tool)
          throw new Error(
            `EACCES: the tool '${d[TOOL_EXTENSION].name}' is not offered to this session`,
          );
        const r = await tool.execute(args);
        return {
          output: r.output,
          isError: !!r.isError,
          ...(r.secrets?.length ? { secrets: r.secrets } : {}),
        };
      },
    });
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
      runTurn: async (
        { config, turn, content, model, context, signal, onSteer, onApproval, waiting },
        emit,
      ) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        // The session's tool set now: exactly what its MCP endpoint lists (#129).
        const set = await this.#tools(config, onApproval);
        return this.#flueOf(config.id).run(
          {
            id: config.id,
            turn,
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
            tools: set.hostTools,
            allowTools: set.offered,
            ...(config.plugins ? { plugins: config.plugins } : {}),
          },
          emit,
        );
      },
      runAction: async (config, call) => {
        if (call.method === "db")
          return runStoredDatabaseCall(databaseHost(env, config, config.capability), call);
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        if (call.method === "tool") {
          // An approved tool call runs again at the workspace, re-checked against the current set.
          try {
            return await workspace.callTool(config.capability, {
              name: call.path,
              args: JSON.parse(new TextDecoder().decode(call.content ?? new Uint8Array())),
            });
          } catch (e) {
            const request = approvalOf(e);
            if (request) return { $approval: request };
            throw e;
          }
        }
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

  async purge() {
    await this.#core.purge();
    // Flue's tables go too, whether or not this instance built its Flue session.
    purgeFlue(this.ctx.storage.sql);
  }

  /**
   * The rows of Flue's tables in this DO, by table (test-only admin route). With `forget`, the DO
   * first drops its in-memory Flue session, as a fresh instance has none.
   */
  flueStorage(forget: boolean): Record<string, number> {
    if (forget) this.#flue = undefined;
    const sql = this.ctx.storage.sql;
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'flue\\_%' ESCAPE '\\'",
      )
      .toArray();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`).one().n),
      ]),
    );
  }

  /** Flue's heartbeat over the session's unsettled submissions. */
  async alarm() {
    const config = this.#core.config();
    if (config) await this.#flueOf(config.id).alarm();
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
