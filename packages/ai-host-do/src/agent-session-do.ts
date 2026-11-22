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
import { approvalId, codedError, codeOf, settleAsk } from "@statewalker/ai-access";
import { TOOL_EXTENSION, type ToolDefinition } from "@statewalker/ai-definitions";
import {
  approvalAware,
  approvalOf,
  errorMessage,
  filesOverRpc,
  isSessionMeter,
  type Limit,
  limitOfMessage,
  type ModelCall,
  type ModelResponse,
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
import { primingOf } from "@statewalker/ai-memory";
import {
  type AgentMessage,
  type AgentSessionConfig,
  AgentSessionCore,
  type ApprovalAnswer,
  type ApprovalRequest,
  createModelSummarizer,
  type EditRequest,
  type EffectOf,
  type EventsQuery,
  type GateDecisionInput,
  type ItemInput,
  type ItemsQuery,
  type McpMessage,
  parseCompaction,
  type RegenerateRequest,
  type RewindRequest,
  type SessionHistory,
  type TurnRun,
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
import { MEMORY_TOOL, memoryHost, memoryTool, runStoredMemoryCall } from "./memory-tool.js";
import { answerMcp, executionModeOf, harnessDefinition, pluginHostTool } from "./session-tools.js";
import { AGENT_START, agentStartTool, type SubAgentHost } from "./sub-agents.js";

type OnApproval = TurnRun["onApproval"];

/** The harness tool calls that change a project's databases. */
const DB_CHANGES = new Set(["db_exec", "db_create", "db_drop"]);
/** Tools whose effects stay inside the session (files: reverted by #191, sub-agents: stopped). */
const LOCAL_TOOLS = new Set<string>([...TRACER_TOOLS, ...DB_TOOLS, AGENT_START]);

/**
 * What a rewind lists of a rewound turn's tool call (statewalker/statewalker-root#190): memory
 * writes, database changes, and the effects of plugin tools, which reach outside the harness.
 */
const effectOf: EffectOf = (item) => {
  const name = String(item.name ?? "");
  if (name === MEMORY_TOOL) return "memory";
  if (DB_CHANGES.has(name)) return "database";
  return name && !LOCAL_TOOLS.has(name) ? "outside" : undefined;
};

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

/** The meter of native tool scripts' isolate time (statewalker/statewalker-root#130). */
const ISOLATE_METER = "executor_cpu_ms:isolate";
export class AgentSession extends DurableObject<Env> {
  readonly #core: AgentSessionCore;
  /** The session level's limits and counters (statewalker/statewalker-root#179). */
  readonly #limits: SessionLimits;
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
    turn?: string,
    emit?: (item: ItemInput) => void,
  ) {
    const env = this.env;
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
    const within = (name: string) => !config.tools || config.tools.includes(name);
    // `agent.start` only for an agent whose definition lists sub-agents the user may use.
    const delegates = (config.run?.agents ?? []).length > 0;
    const named = [...DB_TOOLS, MEMORY_TOOL, ...(delegates ? [AGENT_START] : [])].filter(within);
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
      // Memory across sessions, the agent's only way to it (#157).
      memoryTool(memoryHost(env, config), onApproval),
      agentStartTool(offered, {
        startSubAgent: async (req) => {
          const started = (await userOf(env, config.user).startSubAgent(
            config.id,
            config.capability,
            req,
          )) as Awaited<ReturnType<SubAgentHost["startSubAgent"]>>;
          // A rewind of this turn stops the child (statewalker/statewalker-root#190).
          if (turn) await this.#core.childStarted(turn, started.session.id);
          return started;
        },
        run: (child, message, signal) => runChild(env, child, message, signal),
      }),
    ]
      .filter((t) => set.harness.includes(t.name))
      .map((t) => ({ ...t, executionMode: executionModeOf(harnessDefinition(t)) }));
    let waitingOn: ApprovalRequest | undefined;
    const pluginTools = plugins.map((d) =>
      pluginHostTool(
        d,
        (args) =>
          this.#outbound(config, d, turn, emit, () =>
            workspace.callTool(config.capability, {
              name: d[TOOL_EXTENSION].name,
              args,
              ...(turn ? { turn } : {}),
            }),
          ),
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
   * A plugin tool's call, held to the session's own limits on outbound requests when it sends one
   * (a REST tool, #179): refused before it reaches the workspace, counted here after. The
   * workspace counts its own levels; the warnings it crossed become items of the turn.
   */
  async #outbound(
    config: AgentSessionConfig,
    definition: ToolDefinition,
    turn: string | undefined,
    emit: ((item: ItemInput) => void) | undefined,
    call: () => Promise<{
      output: string;
      isError: boolean;
      secrets?: string[];
      warnings?: WarningView[];
      executor_cpu_ms?: number;
    }>,
  ) {
    // A REST tool, or a remote MCP server's (#135), sends one request per call.
    const kind = definition[TOOL_EXTENSION].route.kind;
    const outbound = kind === "rest" || kind === "mcp";
    // A native tool's isolate time counts against the session's limits too (#130): refused before
    // it runs once the session's limit is spent, counted here after.
    const native = definition[TOOL_EXTENSION].route.kind === "native";
    const scopes = this.#limits.scopes(config);
    if (outbound || native)
      try {
        this.#limits.ledger.check(
          scopes,
          outbound ? { outbound_requests: 1 } : { [ISOLATE_METER]: 1 },
        );
      } catch (e) {
        return { output: String((refusal(e) as Error).message), isError: true };
      }
    const { warnings, executor_cpu_ms, ...result } = await call();
    for (const warning of warnings ?? []) emit?.({ kind: "limit_warning", warning });
    if (native && executor_cpu_ms && executor_cpu_ms > 0)
      for (const warning of this.#limits.ledger.add(
        scopes,
        { [ISOLATE_METER]: executor_cpu_ms },
        this.#limits.meta(config, turn),
      ))
        emit?.({ kind: "limit_warning", warning: warningView(warning) });
    if (outbound)
      for (const warning of this.#limits.ledger.add(
        scopes,
        { outbound_requests: 1 },
        this.#limits.meta(config, turn),
      ))
        emit?.({ kind: "limit_warning", warning: warningView(warning) });
    return result;
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
    this.#limits = new SessionLimits(ctx.storage.sql, env);
    // Every model request goes through the workspace's model gateway, with the session's
    // capability: it picks the model within the user's rights, holds the provider's key, falls
    // back and meters (statewalker/statewalker-root#134).
    const gateway = (
      config: AgentSessionConfig,
      turn?: string,
      emit?: (item: ItemInput) => void,
      onApproval?: OnApproval,
    ): ModelPort => {
      const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
      return {
        request: async (call) => {
          try {
            return await this.#metered(config, turn, call, emit, (c) =>
              workspace.modelRequest(config.capability, { ...c, ...(turn ? { turn } : {}) }),
            );
          } catch (e) {
            // A limit that asks (session or user level, attended): the turn ends waiting on the
            // user's approval, without asking the model. Any other refusal fails the request.
            if (!onApproval || !(await this.#asks(config, e, onApproval))) throw e;
            return {
              message: {
                ...errorMessage(undefined, ""),
                stopReason: "stop",
                errorMessage: undefined,
              },
              model: config.model ?? "gateway",
              attempts: [],
            } as ModelResponse;
          }
        },
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
        { config, turn, content, continues, model, context, signal, onSteer, onApproval, waiting },
        emit,
      ) => {
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        // The session's tool set now: exactly what its MCP endpoint lists (#129).
        const set = await this.#tools(config, onApproval, turn, emit);
        // Memory, primed at the session's start and after each compaction (#157).
        const memory = await this.#priming(config, context, emit);
        const instructions = [config.run?.instructions, memory.instructions, memory.data]
          .filter((x) => x?.trim())
          .join("\n\n");
        return this.#flueOf(config.id).run(
          {
            id: config.id,
            turn,
            agent: config.agent,
            ...(instructions ? { instructions } : {}),
            project: config.project,
            files: approvalAware(
              filesOverRpc((method, args) => workspace.files(config.capability, method, args), {
                blockSize: blockSizeOf(env),
              }),
              onApproval,
            ),
            models: gateway(config, turn, emit, onApproval),
            ...(config.model ? { model: config.model } : {}),
            ...(model ? { requested: model } : {}),
            content,
            ...(continues ? { continues: true } : {}),
            context,
            waiting,
            signal,
            onSteer,
            tools: set.hostTools,
            allowTools: set.offered,
            // Every tool call counts against the limits on tool calls (#179): a refused call is
            // not run, and the agent carries on with the refusal.
            admitTool: async (name) => {
              try {
                const crossed = await this.#charge(config, "tool_calls", 1, turn, { tool: name });
                for (const warning of crossed) emit({ kind: "limit_warning", warning });
                return undefined;
              } catch (e) {
                return this.#breach(config, e, onApproval);
              }
            },
            ...(config.plugins ? { plugins: config.plugins } : {}),
          },
          emit,
        );
      },
      runAction: async (config, call) => {
        if (call.method === "limit") return this.#raise(config, call);
        if (call.method === "memory") return runStoredMemoryCall(memoryHost(env, config), call);
        if (call.method === "db")
          return runStoredDatabaseCall(databaseHost(env, config, config.capability), call);
        const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(config.workspace));
        if (call.method === "tool") {
          // An approved tool call runs again at the workspace, re-checked against the current set.
          try {
            const run = () =>
              workspace.callTool(config.capability, {
                name: call.path,
                args: JSON.parse(new TextDecoder().decode(call.content ?? new Uint8Array())),
              });
            // Held to the session's own limits as a direct call is (#outbound): outbound requests,
            // a native tool's isolate time.
            const definition = (await this.#tools(config, () => {})).definitions.find(
              (d) => d[TOOL_EXTENSION]?.name === call.path,
            );
            if (definition)
              return await this.#outbound(config, definition, undefined, undefined, run);
            const { executor_cpu_ms: _ms, warnings: _w, ...result } = await run();
            return result;
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
        const recorded = await userOf(env, config.user).recordApprovals(config.id, requests);
        // A sub-agent's approvals also go to its root session's events stream.
        if (config.root && config.root !== config.id)
          await agentOf(env, config.root).subAgentApprovals(config.id, requests);
        return recorded.map((a) => ({ id: a.id, expires: a.expires }));
      },
      // An approval no one answers in its time continues its turn from the DO's alarm.
      wake: (at) => {
        void this.#arm(at);
      },
      // A rewind cancels the approvals of the turns it rewound, at the user's User DO.
      cancelApprovals: (config, ids) => userOf(env, config.user).cancelApprovals(config.id, ids),
      effectOf,
    });
  }

  start(config: AgentSessionConfig): Promise<void> {
    return this.#core.start(config);
  }

  /**
   * The memory the session is primed with (statewalker/statewalker-root#157): every kind whole, as
   * a frozen snapshot taken at the session's first turn and again after each compaction (the top
   * level of the context changed), never every turn. Each new snapshot is recorded as a
   * `memory_primed` item: each entry's kind, id, version and tokens, and the entries the scans
   * blocked or that were changed outside the memory service, for the user. A kind its DO cannot
   * answer now is left out of the snapshot; the turn still runs.
   */
  async #priming(
    config: AgentSessionConfig,
    context: TurnRun["context"],
    emit: (item: ItemInput) => void,
  ): Promise<{ instructions: string; data: string }> {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS memory_primes (id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation TEXT NOT NULL, instructions TEXT NOT NULL, data TEXT NOT NULL,
      created INTEGER NOT NULL)`);
    const generation = (context ?? [])
      .flatMap((e) => (e.type === "summary" ? [e.summary.id] : []))
      .join(",");
    const last = sql.exec("SELECT * FROM memory_primes ORDER BY id DESC LIMIT 1").toArray()[0] as
      | { generation: string; instructions: string; data: string }
      | undefined;
    if (last && last.generation === generation)
      return { instructions: last.instructions, data: last.data };
    let snapshot: Awaited<ReturnType<ReturnType<typeof memoryHost>["prime"]>>;
    try {
      snapshot = await memoryHost(this.env, config).prime();
    } catch (e) {
      console.warn(`memory of ${config.id}: ${String((e as Error)?.message ?? e)}`);
      return { instructions: last?.instructions ?? "", data: last?.data ?? "" };
    }
    const priming = primingOf(snapshot);
    sql.exec(
      "INSERT INTO memory_primes (generation, instructions, data, created) VALUES (?, ?, ?, ?)",
      generation,
      priming.instructions,
      priming.data,
      Date.now(),
    );
    // Nothing primed, nothing flagged: no item.
    if (priming.entries.length || priming.flagged.length || priming.skipped.length)
      emit({
        kind: "memory_primed",
        memory: { entries: priming.entries, flagged: priming.flagged, skipped: priming.skipped },
      });
    return { instructions: priming.instructions, data: priming.data };
  }

  /**
   * What a refusal by a limit tells the agent. A limit that asks (session, member or user level)
   * waits on the user's approval when someone is there to give it (the turn then ends waiting),
   * and denies when the session is unattended (statewalker/statewalker-root#127).
   */
  async #breach(config: AgentSessionConfig, e: unknown, onApproval?: OnApproval): Promise<string> {
    const text = String((e as Error)?.message ?? e);
    if (onApproval && (await this.#asks(config, e, onApproval)))
      return `${text}; waiting on the user's approval to raise it`;
    const limit = limitOfMessage(text);
    if (limit?.verdict === "ask")
      return settleAsk({ verdict: "ask", reason: text }, { unattended: !!config.unattended })
        .reason;
    return text;
  }

  /** Records an approval for a limit that asks, when the session is attended: true if it did. */
  async #asks(config: AgentSessionConfig, e: unknown, onApproval: OnApproval): Promise<boolean> {
    const text = String((e as Error)?.message ?? e);
    const limit = limitOfMessage(text);
    if (!text.includes("ELIMIT") || limit?.verdict !== "ask") return false;
    if (
      settleAsk({ verdict: "ask" as const, reason: text }, { unattended: !!config.unattended })
        .verdict !== "ask"
    )
      return false;
    const path = `${String(limit.key)}@${Number(limit.value)}`;
    const id = await approvalId(config.id, "limit", path);
    onApproval(
      {
        id,
        session: config.id,
        project: config.project,
        action: { method: "limit", path },
        permission: `limits.raise:${String(limit.meter)}`,
        reason: text.slice(text.indexOf("ELIMIT")),
      },
      { method: "limit", path, target: String(Number(limit.increment) || 0) },
    );
    return true;
  }

  /**
   * Runs an approved raise of a limit (statewalker/statewalker-root#179): by one increment, at the
   * DO that counts its level; the member's and the user's check the user's approval themselves.
   */
  async #raise(config: AgentSessionConfig, call: { path: string; target?: string }) {
    const at = call.path.lastIndexOf("@");
    const key = call.path.slice(0, at);
    const increment = Number(call.target) || 0;
    const level = (JSON.parse(key) as unknown[])[0];
    const approval = await approvalId(config.id, "limit", call.path);
    if (level === "session") this.#limits.ledger.raise(key, increment);
    else if (level === "member")
      await this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(config.workspace)).raiseLimit(
        config.capability,
        { approval, key, increment },
      );
    else if (level === "user")
      await userOf(this.env, config.user).raiseLimit(config.id, { approval, key, increment });
    else throw new Error(`EACCES: a ${String(level)} limit is never raised by an approval`);
    return { raised: true };
  }

  /**
   * One model request with the session's own limits (statewalker/statewalker-root#179): the
   * workspace reserves its levels in the gateway; the session's level (counted here) and, for the
   * user's own keys, the user's (counted in their User DO) reserve the request's worst case first
   * and settle to the real usage after. Every limit the usage crossed the warning share of is left
   * as an item.
   */
  async #metered(
    config: AgentSessionConfig,
    turn: string | undefined,
    call: ModelCall,
    emit: ((item: ItemInput) => void) | undefined,
    request: (call: ModelCall) => Promise<ModelResponse>,
  ): Promise<ModelResponse> {
    const warn = (warnings: unknown[] | undefined) => {
      for (const warning of warnings ?? [])
        emit?.({ kind: "limit_warning", warning: warning as WarningView });
    };
    const scopes = this.#limits.scopes(config);
    const sessionBound = scopes.some((s) => s.limits.some((l) => l.meter.startsWith("model_")));
    if (!sessionBound && !config.ownKeys) {
      const response = await request(call);
      warn(response.warnings);
      return response;
    }
    const workspace = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(config.workspace));
    const estimate = await workspace.modelEstimate(config.capability, call);
    const meta = this.#limits.meta(config, turn);
    let reserved: string | undefined;
    try {
      if (sessionBound) reserved = this.#limits.ledger.reserve(scopes, estimate.worst, meta).id;
    } catch (e) {
      throw refusal(e);
    }
    const user = userOf(this.env, config.user);
    let own: string | undefined;
    let response: ModelResponse | undefined;
    try {
      if (estimate.own) own = await user.reserveOwnKey(meta, estimate.own);
      response = await request(call);
    } finally {
      const all = { model_tokens: 0, model_spend: 0 };
      const mine = { model_tokens: 0, model_spend: 0 };
      // The own-key model, so the user's usage report groups it (#181).
      let ownModel: string | undefined;
      for (const { usage } of response?.attempts ?? [])
        for (const into of usage.charged ? [all] : [all, mine]) {
          if (!usage.charged) ownModel = usage.model;
          into.model_tokens += usage.input_tokens + usage.output_tokens;
          into.model_spend += usage.cost ?? 0;
        }
      if (reserved) warn(this.#limits.ledger.settle(reserved, all, meta).map(warningView));
      if (own)
        warn(await user.settleOwnKey(own, mine, meta, ownModel ? { model: ownModel } : undefined));
    }
    warn(response.warnings);
    return response;
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
    const crossed = message.delivery !== "steer" ? await this.#chargeTurn() : [];
    const accepted = await this.#core.send(message);
    if (crossed.length) this.#core.warn(accepted.turn_id, crossed);
    return accepted;
  }

  /** A new turn, charged to the limits on turns; ELIMIT (429) over one. */
  async #chargeTurn(): Promise<WarningView[]> {
    const config = this.#core.config();
    if (!config) return [];
    try {
      return await this.#charge(config, "turns", 1);
    } catch (e) {
      // Only a limit refuses a message here: a capability the gate refuses (revoked, removed)
      // fails the turn at its first action, as before.
      if (codeOf(e) === "ELIMIT") throw e;
      return [];
    }
  }

  turn(turnId: string) {
    return this.#core.turn(turnId);
  }

  // --- the turn tree (statewalker/statewalker-root#190) -----------------------------------------

  rewind(req: RewindRequest) {
    return this.#core.rewind(req);
  }

  setHead(turn: string | null) {
    return this.#core.setHead(turn);
  }

  /** Refuses an edit of an unknown turn, or while a turn runs, before the new turn is charged. */
  async #idle(turnId: string): Promise<void> {
    await this.#core.turn(turnId);
    if ((await this.#core.status()) === "running")
      throw new Error("EBUSY: a turn is running or queued: cancel it first");
  }

  /** An edit's new turn counts against the limits on turns, as a message does. */
  async edit(turnId: string, req: EditRequest) {
    await this.#idle(turnId);
    const crossed = await this.#chargeTurn();
    const accepted = await this.#core.edit(turnId, req);
    if (crossed.length) this.#core.warn(accepted.turn_id, crossed);
    return accepted;
  }

  async regenerate(turnId: string, req?: RegenerateRequest) {
    await this.#idle(turnId);
    const crossed = await this.#chargeTurn();
    const accepted = await this.#core.regenerate(turnId, req);
    if (crossed.length) this.#core.warn(accepted.turn_id, crossed);
    return accepted;
  }

  branches() {
    return this.#core.branches();
  }

  eraseBranch(turnId: string) {
    return this.#core.eraseBranch(turnId);
  }

  exportPath(atTurn: string) {
    return this.#core.exportPath(atTurn);
  }

  /** A fork's copied history: nothing is charged for it (statewalker/statewalker-root#190). */
  importHistory(history: SessionHistory) {
    return this.#core.importHistory(history);
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

  usage() {
    return this.#core.usage();
  }

  /**
   * The session's own limits, which its user set (statewalker/statewalker-root#181): a list
   * replaces them (the session level counts only its own meters: EINVAL for another).
   */
  ownLimits(limits?: Limit[]) {
    const config = this.#core.config();
    if (!config) throw codedError("ENOENT", "no such agent session");
    if (limits !== undefined) {
      const bad = limits.find((l) => !isSessionMeter(l.meter));
      if (bad) throw codedError("EINVAL", `the session level does not count ${bad.meter}`);
      this.#limits.setOwn(
        limits.map((l) => ({ ...l, level: "session" as const, target: config.id })),
      );
    }
    return this.#limits.own(config);
  }

  /** The session level's limits now (statewalker/statewalker-root#181). */
  limits() {
    const config = this.#core.config();
    if (!config) throw codedError("ENOENT", "no such agent session");
    return this.#limits.ledger.states(this.#limits.scopes(config));
  }

  archive() {
    return this.#core.archive();
  }

  async purge() {
    await this.#core.purge();
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS memory_primes");
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

  /**
   * The DO's alarm, shared: approvals that expired continue their turns
   * (statewalker/statewalker-root#214), then Flue's heartbeat over the session's unsettled
   * submissions; the next expiry is armed again after.
   */
  async alarm() {
    const config = this.#core.config();
    if (!config) return;
    const next = this.#core.expire();
    try {
      await this.#flueOf(config.id).alarm();
    } finally {
      if (next !== undefined) await this.#arm(next);
    }
  }

  /** Sets the DO's alarm to `at`, unless one is set sooner (Flue's heartbeat shares it). */
  async #arm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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
