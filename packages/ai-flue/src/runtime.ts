// Agent sessions on Flue's Cloudflare-target runtime (statewalker/statewalker-root#128): a
// hand-written entry over `@flue/runtime/internal` and `@flue/runtime/cloudflare/internal`, with
// the agent session's own Durable Object as the base (no Vite, no `agents` SDK; Flue's version is
// pinned exactly because these APIs are internal). It is what `@flue/vite`'s generated Worker entry
// does, for one generic agent: register it, build the per-Worker agent runtime, and give each agent
// session DO a Flue coordinator over the DO's own SQLite.
//
// The harness keeps the turns: `AgentSessionCore` queues them and each turn is submitted as one Flue
// message (a durable submission whose id is the turn's id). Flue runs it in its fibers, renders the
// agent (instructions, the gated file view as its sandbox, the session's tool set), reads the
// project's AGENTS.md and skills through that view, and drives pi's loop. What the model sees is the
// harness's: every model call goes to the model gateway, with the harness's shaped context (its
// summaries and items) under Flue's system prompt and tools, so Flue's own history never reaches a
// model and Flue's compaction is off. The adapter translates Flue's messages into items (from
// Flue's live events) and keeps the turn and item ids the harness's.
import {
  createAssistantMessageEventStream,
  createProvider,
  normalizeContext,
} from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  defineSkill,
  bash as flueBash,
  observe,
  useAgentFinish,
  useModel,
  useSandbox,
  useSkill,
} from "@flue/runtime";
import { runWithCloudflareContext } from "@flue/runtime/cloudflare/internal";
import {
  configureFlueRuntime,
  createCloudflareAgentRuntime,
  createFlueContext,
  parseSkillMarkdown,
  registerFlueAgents,
  resolveModel,
  setProvider,
} from "@flue/runtime/internal";
import {
  errorMessage,
  type ModelCall,
  type ModelMessage,
  type ModelResponse,
  type ModelUsage,
} from "@statewalker/ai-environment";
import type {
  Complete,
  ContextEntry,
  Item,
  ItemInput,
  Steer,
  TurnOutcome,
} from "@statewalker/ai-sessions";
import { type FilesApi, readFile } from "@statewalker/webrun-files";
import { Bash } from "just-bash/browser";
import { contextMessages } from "./context.js";
import { FilesFs } from "./files-fs.js";

/**
 * The model gateway as a turn reaches it: the only way the loop reaches a model. It picks the model
 * within the user's rights, holds the provider's key, falls back and meters (ai-environment).
 */
export interface ModelPort {
  request(call: ModelCall): Promise<ModelResponse>;
}

/**
 * A tool the host runs on the agent's behalf (a REST or MCP call through the gateway): the agent
 * loop sees only its name, description, schema and output, never the secrets it used.
 */
export interface HostTool {
  /** `<plugin>__<tool>`. */
  name: string;
  description: string;
  /** A closed JSON Schema object for the tool's input. */
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ output: string; isError?: boolean; secrets?: string[] }>;
}

export interface FlueTurn {
  /** The agent session's id: the Flue instance's id and its sandbox's. */
  id: string;
  /** The turn's id: the Flue submission's id. */
  turn?: string;
  /** The agent's name (`<plugin>/<agent>`). */
  agent: string;
  /** The agent's always-on instructions, from its definition. */
  instructions?: string;
  /** The session's project; its folder is the working directory. */
  project: string;
  /** The gated file view the session holds. */
  files: FilesApi;
  /** The model gateway. */
  models: ModelPort;
  /** The session's pinned model (an id), for the loop's bookkeeping; the gateway decides. */
  model?: string;
  /** The model the turn's message asked for (an id or an alias), within the user's rights. */
  requested?: string;
  /** The user's message. */
  content: string;
  /**
   * The model context before the user's message, as the harness shaped it (summaries and the
   * items they leave). The harness compacts: Flue's own compaction is off.
   */
  context?: ContextEntry[];
  /**
   * Whether a file call of this turn waits on the user's approval: the turn then ends at the
   * pending call, Flue's approval-gate pattern (a tool result with `terminate`).
   */
  waiting?: () => boolean;
  /** Tools the host runs (beside Flue's own over the sandbox). */
  tools?: HostTool[];
  /**
   * The names of the tools the model may be offered, Flue's and the host's (none: all of them). A
   * sub-agent's are within its parent's (statewalker/statewalker-root#126).
   */
  allowTools?: readonly string[];
  /**
   * The plugins pinned for the session, broadest level first: a skill name two plugins share in
   * the `.agents/` view goes to the first.
   */
  plugins?: readonly string[];
  /** Aborts the turn: it stops at once, keeping what it reported so far. */
  signal?: AbortSignal;
  /**
   * Steering: each message joins the turn at its next model call; the turn reports it as a user
   * message item with its `steer` id.
   */
  onSteer?(listener: (steer: Steer) => void): void;
}

/** Flue's file and shell tools by name, built over the session's sandbox (the gated file view). */
const TOOLS = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
  grep: createGrepTool,
  glob: createGlobTool,
} as const;
export const TRACER_TOOLS: (keyof typeof TOOLS)[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
];

/** The one Flue agent every agent session is an instance of; definitions come per session. */
const AGENT = "harness";
/** The provider id Flue resolves the session's model through: the model gateway. */
const PROVIDER = "harness-gateway";
/** How long a cancelled turn waits for Flue to settle its submission before it ends anyway. */
const ABORT_GRACE_MS = 2_000;
/**
 * Framework tools Flue adds that the harness never offers: `task` is Flue's own delegation, which
 * cannot be narrowed; the harness delegates with its `agent_start` tool.
 */
const WITHHELD_TOOLS = new Set(["task"]);

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
type Message = {
  role: string;
  content?: string | Part[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
};
type SystemMessage = {
  role: "system";
  content: string | Part[];
  sections?: Record<string, string | null>;
  toolsAdded?: { name: string }[];
  toolsRemoved?: ({ name: string } | string)[];
  timestamp: number;
};

const textOf = (content: Message["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");

/** A context as plain JSON: tools lose their functions, so it can travel to the gateway. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? { messages: [] }));

/** What each model call of a turn left for the answer's items: its metered usage, or nothing. */
type Answer = { usage?: ModelUsage; skip?: true };

/** A turn running on Flue: what its render, its model calls and its events reach. */
interface LiveTurn {
  turn: FlueTurn;
  /** The Flue submission (the turn's id). */
  submission: string;
  /** The items the turn reported, in order: the in-turn part of its model context. */
  items: ItemInput[];
  /** Steered messages not yet handed to the model. */
  steers: Steer[];
  /** The view's skills registered with Flue for this turn. */
  skills: unknown[];
  /** One entry per model call, taken by its answer's message (in order). */
  answers: Answer[];
  /** The names of the secrets each host tool call used, by tool call id (never the values). */
  secrets: Map<string, string[]>;
  outcome: TurnOutcome;
  requests: number;
  /** Why the turn failed, as the harness reports it. */
  failure?: string;
  /** Set once the turn ended for the harness: later events of its submission are ignored. */
  closed: boolean;
  emit(item: ItemInput): void;
  settle(result: Settlement): void;
  settled: Promise<Settlement>;
}
type Settlement = { outcome: string; error?: { message?: string } };

/** Live turns by agent session (the Flue instance id), and by Flue submission. */
const LIVE = new Map<string, LiveTurn>();
const BY_SUBMISSION = new Map<string, LiveTurn>();

/**
 * The items of one message of Flue's loop; `secrets` by tool call id. An answer's metered usage
 * goes on its first item.
 */
function* itemsOf(
  m: Message,
  secrets: ReadonlyMap<string, string[]>,
  usage?: ModelUsage,
): Generator<ItemInput> {
  if (m.role === "assistant") {
    const text = textOf(m.content);
    let first = true;
    const metered = (item: ItemInput): ItemInput => {
      if (!first || !usage) return item;
      first = false;
      return { ...item, usage };
    };
    if (m.stopReason === "aborted") {
      // Cut short: what the model had said so far, marked incomplete.
      if (text) yield metered({ kind: "message", role: "assistant", text, incomplete: true });
      return;
    }
    if (m.stopReason === "error") return;
    if (text) yield metered({ kind: "message", role: "assistant", text });
    for (const p of Array.isArray(m.content) ? m.content : [])
      if (p.type === "toolCall")
        yield metered({ kind: "tool_call", callId: p.id, name: p.name, args: p.arguments });
  } else if (m.role === "toolResult") {
    yield {
      kind: "tool_result",
      callId: m.toolCallId,
      name: m.toolName,
      output: textOf(m.content),
      isError: !!m.isError,
      ...(secrets.get(String(m.toolCallId))?.length
        ? { secrets: secrets.get(String(m.toolCallId)) }
        : {}),
    };
  }
}

// Flue's live events of every turn of this isolate, routed to their turn by submission: the
// messages of the loop become items as each one ends, and the settlement ends the turn.
observe((event) => {
  const o = event as unknown as {
    type: string;
    submissionId?: string;
    taskId?: string;
    harness?: string;
    message?: Message;
    outcome?: string;
    error?: { message?: string };
  };
  const live = o.submissionId ? BY_SUBMISSION.get(o.submissionId) : undefined;
  if (!live) return;
  if (o.type === "submission_settled") {
    live.settle({ outcome: String(o.outcome), ...(o.error ? { error: o.error } : {}) });
    return;
  }
  // Only the agent's own conversation: no delegated task, no lifecycle-hook harness.
  if (o.type !== "message_end" || o.taskId || (o.harness && o.harness !== "default")) return;
  const m = o.message;
  if (!m || (m.role !== "assistant" && m.role !== "toolResult")) return;
  const answer = m.role === "assistant" ? live.answers.shift() : undefined;
  if (answer?.skip) return;
  for (const item of itemsOf(m, live.secrets, answer?.usage)) live.emit(item);
});

/**
 * Flue's system messages folded into one: the agent's composed prompt (instructions, AGENTS.md,
 * the skills catalog, the working directory) and the tools it holds now, minus those the harness
 * withholds.
 */
function systemOf(messages: Message[]): SystemMessage[] {
  const systems = messages.filter((m) => m.role === "system") as unknown as SystemMessage[];
  const [lead, ...rest] = systems;
  if (!lead) return [];
  let content = textOf(lead.content as Message["content"]);
  const sections: Record<string, string> = {};
  const tools = new Map<string, { name: string }>();
  for (const m of systems) {
    if (m !== lead) {
      const more = textOf(m.content as Message["content"]);
      if (more) content = content ? `${content}\n\n${more}` : more;
    }
    for (const [name, value] of Object.entries(m.sections ?? {}))
      if (value === null) delete sections[name];
      else sections[name] = value;
    for (const t of m.toolsRemoved ?? []) tools.delete(typeof t === "string" ? t : t.name);
    for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
  }
  void rest;
  const offered = [...tools.values()].filter((t) => !WITHHELD_TOOLS.has(t.name));
  return [
    {
      role: "system",
      content,
      ...(Object.keys(sections).length ? { sections } : {}),
      ...(offered.length ? { toolsAdded: offered } : {}),
      timestamp: lead.timestamp,
    },
  ];
}

/**
 * A complete answer as the stream of events a provider sends: Flue records the answer from them,
 * block by block, so each text, thinking and tool call block has its start, delta and end.
 */
function* replay(message: ModelMessage): Generator<Record<string, unknown>> {
  const blocks = (message.content ?? []) as (Part & { thinking?: string })[];
  const partial = { ...message, content: [] as unknown[] };
  yield { type: "start", partial };
  for (const [contentIndex, block] of blocks.entries()) {
    if (block.type === "text") {
      partial.content.push({ ...block, text: "" });
      yield { type: "text_start", contentIndex, partial };
      partial.content[contentIndex] = block;
      yield { type: "text_delta", contentIndex, delta: block.text ?? "", partial };
      yield { type: "text_end", contentIndex, content: block.text ?? "", partial };
    } else if (block.type === "thinking") {
      partial.content.push({ ...block, thinking: "" });
      yield { type: "thinking_start", contentIndex, partial };
      partial.content[contentIndex] = block;
      yield { type: "thinking_delta", contentIndex, delta: block.thinking ?? "", partial };
      yield { type: "thinking_end", contentIndex, content: block.thinking ?? "", partial };
    } else if (block.type === "toolCall") {
      partial.content.push(block);
      yield { type: "toolcall_start", contentIndex, partial };
      yield {
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(block.arguments ?? {}),
        partial,
      };
      yield { type: "toolcall_end", contentIndex, toolCall: block, partial };
    } else partial.content.push(block);
  }
  if (message.stopReason === "error" || message.stopReason === "aborted")
    yield { type: "error", reason: message.stopReason, error: message };
  else yield { type: "done", reason: message.stopReason, message };
}

/** The model the loop believes it talks to: the gateway answers with the real one. */
function gatewayModel(session: string) {
  return {
    id: session,
    name: "gateway",
    api: PROVIDER,
    provider: PROVIDER,
    baseUrl: "gateway:",
    headers: {},
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    // Unknown here (the gateway picks the model), and 0 keeps Flue's overflow recovery from
    // compacting on an answer's token count: the harness compacts, Flue never does.
    contextWindow: 0,
    maxTokens: 4096,
  };
}

/**
 * One model call of a turn's loop: one gateway request with the harness's context. Steered
 * messages join here (the loop's next step); a turn waiting on an approval asks no model.
 */
function gatewayStream(model: { id: string }, context: { messages: Message[] }, options?: unknown) {
  const stream = createAssistantMessageEventStream();
  const finish = (message: ModelMessage) => {
    for (const event of replay(message)) stream.push(event as never);
  };
  const live = LIVE.get(model.id);
  if (!live || live.closed) {
    queueMicrotask(() => finish(errorMessage(undefined, "no turn of this session is running")));
    return stream;
  }
  const { turn } = live;
  for (const steer of live.steers.splice(0))
    live.emit({ kind: "message", role: "user", text: steer.text, steer: steer.id });
  if (turn.waiting?.()) {
    // A call waits on the user's approval: the model is not asked again until the user answers.
    live.answers.push({ skip: true });
    queueMicrotask(() =>
      finish({ ...errorMessage(undefined, ""), stopReason: "stop", errorMessage: undefined }),
    );
    return stream;
  }
  const entries: ContextEntry[] = [
    ...(turn.context ?? []),
    ...[{ kind: "message", role: "user", text: turn.content } as ItemInput, ...live.items].map(
      (item) => ({ type: "item", item: item as unknown as Item }) as ContextEntry,
    ),
  ];
  const messages = [
    ...systemOf(context.messages),
    // Earlier answers are replayed as the gateway's: it may have served several models.
    ...contextMessages(entries, {
      api: "openai-completions",
      provider: "gateway",
      id: turn.model ?? "gateway",
    }),
  ];
  const maxTokens = (options as { maxTokens?: number } | undefined)?.maxTokens;
  const aborted = new Promise<ModelMessage>((resolve) => {
    const stop = () =>
      resolve({ ...errorMessage(undefined, "the turn was cut short"), stopReason: "aborted" });
    if (turn.signal?.aborted) stop();
    else turn.signal?.addEventListener("abort", stop, { once: true });
  });
  // A failure is the harness's to report; Flue sees a plain refusal it neither retries nor
  // compacts over (the gateway already fell back).
  const failed = (text: string): ModelMessage => {
    live.failure ??= `EIO: the model failed: ${text}`;
    return errorMessage(undefined, "the model gateway refused the request");
  };
  const asked = turn.models
    .request({
      context: plain({ messages }),
      ...(turn.requested ? { model: turn.requested } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    })
    .then(
      (response): [ModelMessage, Answer] => {
        if (live.requests++ === 0) {
          live.outcome.model = response.model;
          if (response.substitution) live.outcome.substitution = response.substitution;
        }
        for (const [i, attempt] of response.attempts.entries()) {
          const next = response.attempts[i + 1];
          if (next)
            live.emit({
              kind: "model_fallback",
              from: attempt.usage.model,
              to: next.usage.model,
              reason: attempt.usage.outcome,
              usage: attempt.usage,
            });
        }
        const message = response.message;
        if (message.stopReason === "error") return [failed(message.errorMessage ?? "error"), {}];
        const last = response.attempts.at(-1);
        return [message, last ? { usage: last.usage } : {}];
      },
      (e: unknown): [ModelMessage, Answer] => [failed(String((e as Error)?.message ?? e)), {}],
    );
  void Promise.race([asked, aborted.then((m): [ModelMessage, Answer] => [m, {}])]).then(
    ([message, answer]) => {
      live.answers.push(answer);
      finish(message);
    },
  );
  return stream;
}

setProvider(
  createProvider({
    id: PROVIDER,
    auth: { apiKey: { name: "model gateway", resolve: async () => ({ auth: {} }) } },
    models: [],
    api: { stream: gatewayStream as never, streamSimple: gatewayStream as never },
  } as never) as never,
);

/** A FilesApi that is always the running turn's file view of the session. */
function liveFiles(session: string): FilesApi {
  return new Proxy({} as FilesApi, {
    get(_target, key) {
      const files = LIVE.get(session)?.turn.files as unknown as Record<PropertyKey, unknown>;
      if (!files) throw new Error("EIO: no turn of this session is running");
      const value = files[key];
      return typeof value === "function" ? value.bind(files) : value;
    },
  });
}

type AgentToolResult = {
  content: { type: string; text?: string }[];
  details: unknown;
  isError?: boolean;
  terminate?: boolean;
};
type AgentTool = {
  name: string;
  execute(
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ): Promise<AgentToolResult>;
};

/**
 * A tool whose call may leave the turn waiting on an approval: the turn then ends after the batch
 * (every result of a waiting turn terminates), and the waiting call's result is an error the
 * model would see.
 */
function approvalAware(tool: AgentTool, waiting: () => boolean): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      try {
        const result = await tool.execute(id, params, signal, onUpdate);
        return waiting() ? { ...result, terminate: true } : result;
      } catch (e) {
        if (!waiting()) throw e;
        return {
          content: [{ type: "text", text: String((e as Error)?.message ?? e) }],
          details: {},
          isError: true,
          terminate: true,
        };
      }
    },
  };
}

/** The session's tool set for this turn: Flue's file tools and the host's, as offered. */
function toolsFor(session: string, sandbox: unknown): AgentTool[] {
  const live = LIVE.get(session);
  if (!live) return [];
  const { turn } = live;
  const offered = (name: string) => !turn.allowTools || turn.allowTools.includes(name);
  const hostTools: AgentTool[] = (turn.tools ?? [])
    .filter(({ name }) => offered(name))
    .map(
      (tool) =>
        ({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
            const result = await tool.execute((params ?? {}) as Record<string, unknown>, signal);
            if (result.secrets?.length) live.secrets.set(toolCallId, result.secrets);
            if (result.isError) throw new Error(result.output);
            return { content: [{ type: "text", text: result.output }], details: {} };
          },
        }) as AgentTool,
    );
  const waiting = () => !!turn.waiting?.();
  return [
    ...TRACER_TOOLS.filter(offered).map((name) => TOOLS[name](sandbox as never) as AgentTool),
    ...hostTools,
  ].map((tool) => approvalAware(tool, waiting));
}

/**
 * The generic agent: its definition is the running turn's (instructions, project, tools). Its
 * sandbox is the session's gated file view; the model is the gateway, with Flue's threshold
 * compaction off (the harness compacts).
 */
function HarnessAgent(props: { id: string }) {
  const session = props.id;
  const live = LIVE.get(session);
  const project = live?.turn.project ?? "";
  useModel(`${PROVIDER}/${session}`, { compaction: false });
  useSandbox(
    {
      createSandbox: ({ id }: { id: string }) =>
        flueBash(
          () =>
            new Bash({ fs: new FilesFs(liveFiles(session)) as never, cwd: `/${project}` }) as never,
        ).createSandbox({ id }),
      tools: (sandbox: unknown) => toolsFor(session, sandbox),
    } as never,
    { cwd: `/${project}` },
  );
  // The skills of the `.agents/` view, as Flue skills (its catalog, `activate_skill`).
  for (const skill of live?.skills ?? []) useSkill(skill as never);
  // A message steered while the model answered its last step continues the turn: Flue runs one
  // more step, whose model call takes it.
  useAgentFinish(({ append }) => {
    const current = LIVE.get(session);
    if (current && !current.closed && current.steers.length)
      append({ kind: "signal", type: "harness.steer", body: "A steered message is waiting." });
  });
  if (!live) return undefined;
  return [
    `You are the ${live.turn.agent} agent, working in /${project}.`,
    live.turn.instructions?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
HarnessAgent.agentName = AGENT;
// A turn runs once: an interrupted attempt fails the turn, it is never run again behind the
// harness. A turn may wait long on its tools (a sub-agent's turn): a day before Flue gives up.
HarnessAgent.durability = { maxAttempts: 1, timeoutMs: 86_400_000 };

registerFlueAgents([{ identity: AGENT, agent: HarnessAgent as never }] as never);

/** What Flue needs of the Durable Object it runs in. */
export interface FlueHostState {
  readonly id: { toString(): string };
  readonly storage: {
    readonly sql: unknown;
    transactionSync<T>(closure: () => T): T;
    getAlarm(): Promise<number | null> | number | null;
    setAlarm(at: number): Promise<void> | void;
  };
  waitUntil?(promise: Promise<unknown>): void;
}

/** The DO a session's Flue coordinator lives on: Flue's structural agent base. */
interface Instance {
  readonly name: string;
  readonly env: Record<string, unknown>;
  readonly ctx: FlueHostState;
  schedule(delay: number, callback: string, payload: undefined, options: unknown): Promise<unknown>;
  runFiber(
    name: string,
    callback: (ctx: { stash(snapshot: unknown): void }) => Promise<void>,
  ): Promise<void>;
}

const WAKE = "__flueWakeAgentSubmissions";

const runtime = createCloudflareAgentRuntime({
  agents: [{ name: AGENT, agent: HarnessAgent as never }],
  createContext: ({ instance, agentName, request, submissionId }) =>
    createFlueContext({
      id: instance.name,
      agentName,
      env: instance.env ?? {},
      req: request,
      ...(submissionId ? { submissionId } : {}),
      agentConfig: {
        // The session's model is the gateway: `harness-gateway/<session id>`.
        resolveModel: (specifier: string) =>
          specifier.startsWith(`${PROVIDER}/`)
            ? gatewayModel(specifier.slice(PROVIDER.length + 1))
            : resolveModel(specifier),
      } as never,
    }),
  runWithInstanceContext: (instance, _agentName, callback) =>
    runWithCloudflareContext(
      {
        env: instance.env,
        storage: instance.ctx.storage,
        durableObjectIdentity: {
          bindingName: "AGENT",
          className: "AgentSession",
          name: instance.name,
          id: instance.ctx.id.toString(),
        },
      } as never,
      callback,
    ),
});

// The harness never addresses Flue agents from outside their DO (no dispatch, no Flue routes).
configureFlueRuntime({
  target: "cloudflare",
  dispatchQueue: {
    enqueue: async () => {
      throw new Error("[harness] Flue dispatch is not used");
    },
  },
  routeAgentRequest: async () => null,
  instanceInfo: async () => null,
} as never);

/**
 * One agent session's Flue session, hosted by the session's Durable Object: its coordinator over
 * the DO's SQLite, woken from the DO's alarm. `run` submits one turn as one Flue message.
 */
export class FlueSession {
  readonly #instance: Instance;
  /** Skills read from the view, by folder: a session's definitions are pinned, so never stale. */
  readonly #skillCache = new Map<string, unknown>();
  #started?: Promise<void>;

  constructor(options: { state: FlueHostState; env: unknown; session: string }) {
    const { state, session } = options;
    const prepared = runtime.prepare({
      storage: state.storage as never,
      className: "AgentSession",
      agentName: AGENT,
    });
    const instance: Instance = {
      name: session,
      env: (options.env ?? {}) as Record<string, unknown>,
      ctx: state,
      schedule: async (delay, callback) => {
        if (callback !== WAKE) throw new Error(`[harness] unknown Flue schedule "${callback}"`);
        if (delay <= 0) {
          const wake = Promise.resolve()
            .then(() => runtime.drainSubmissions(instance as never))
            .catch((e) => console.error("[harness] Flue wake failed", e));
          state.waitUntil?.(wake);
          return;
        }
        const at = Date.now() + delay * 1000;
        const current = await state.storage.getAlarm();
        if (current == null || current > at) await state.storage.setAlarm(at);
      },
      runFiber: (_name, callback) => {
        const running = callback({ stash() {} });
        state.waitUntil?.(running.catch(() => {}));
        return running;
      },
    };
    this.#instance = instance;
    runtime.attach(instance as never, prepared);
  }

  #start(): Promise<void> {
    this.#started ??= runtime.onStart(this.#instance as never, () => undefined);
    return this.#started;
  }

  /**
   * The skills the session's `.agents/` view shows now (`skills/<plugin>/<name>/`), as Flue skill
   * definitions, read through the gated view. Flue's catalog is flat: on a name two plugins share,
   * the first in pinned order holds it and the other is reported; a skill Flue can't take (its
   * name not its folder's, or not an Agent Skills name) is reported and left out.
   */
  async #skills(turn: FlueTurn): Promise<unknown[]> {
    const root = `/${turn.project}/.agents/skills`;
    const names = async (path: string, kind: "file" | "directory") => {
      const out: string[] = [];
      try {
        for await (const e of turn.files.list(path)) if (e.kind === kind) out.push(e.name);
      } catch {
        // No view, or nothing visible.
      }
      return out.sort();
    };
    const order = turn.plugins ?? [];
    const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
    const plugins = (await names(root, "directory")).sort((a, b) => rank(a) - rank(b));
    const skills: unknown[] = [];
    const holder = new Map<string, string>();
    for (const plugin of plugins)
      for (const name of await names(`${root}/${plugin}`, "directory")) {
        const dir = `${root}/${plugin}/${name}`;
        const taken = holder.get(name);
        if (taken) {
          console.warn(
            `[harness] skill ${plugin}/${name} not registered: ${taken}/${name} holds the name`,
          );
          continue;
        }
        let skill = this.#skillCache.get(dir);
        if (!skill) {
          try {
            skill = await readSkill(turn.files, dir, name);
          } catch (e) {
            console.warn(
              `[harness] skill ${plugin}/${name} not registered: ${(e as Error)?.message ?? e}`,
            );
            continue;
          }
          if (!skill) continue;
          this.#skillCache.set(dir, skill);
        }
        holder.set(name, plugin);
        skills.push(skill);
      }
    return skills;
  }

  /** The DO's alarm: Flue's heartbeat over unsettled submissions. */
  async alarm(): Promise<void> {
    await this.#start();
    await runtime.onAlarm(this.#instance as never, () =>
      runtime.drainSubmissions(this.#instance as never),
    );
  }

  /**
   * Runs one turn as one Flue submission, reporting its items as each message of the loop ends,
   * after the user's message. Aborting the signal aborts the submission; steering joins it at its
   * next model call.
   */
  async run(turn: FlueTurn, emit: (item: ItemInput) => void): Promise<TurnOutcome> {
    const outcome: TurnOutcome = turn.model ? { model: turn.model } : {};
    if (turn.signal?.aborted) return outcome;
    await this.#start();
    const session = this.#instance.name;
    const submission = turn.turn ?? `${session}.tu-${crypto.randomUUID()}`;
    let settle: (result: Settlement) => void = () => {};
    const live: LiveTurn = {
      turn,
      submission,
      items: [],
      steers: [],
      skills: [],
      answers: [],
      secrets: new Map(),
      outcome,
      requests: 0,
      closed: false,
      emit(item) {
        if (live.closed) return;
        live.items.push(item);
        emit(item);
      },
      settle: (result) => settle(result),
      settled: new Promise<Settlement>((resolve) => {
        settle = resolve;
      }),
    };
    live.skills = await this.#skills(turn);
    LIVE.set(session, live);
    BY_SUBMISSION.set(submission, live);
    turn.onSteer?.((steer) => {
      if (!live.closed) live.steers.push(steer);
    });
    let onAbort = () => {};
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      turn.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const admitted = await runtime.onRequest(
        this.#instance as never,
        new Request("https://flue.invalid/__flue/internal/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            submissionId: submission,
            agent: AGENT,
            id: session,
            message: { kind: "user", body: turn.content },
            acceptedAt: new Date().toISOString(),
          }),
        }),
      );
      if (!admitted?.ok)
        throw new Error(
          `EIO: Flue did not admit the turn (${admitted?.status}): ${await admitted?.text()}`,
        );
      const result = await Promise.race([live.settled, aborted]);
      if (!result) {
        // Cancelled or interrupted: Flue aborts the submission; the turn keeps what it reported.
        live.closed = true;
        await runtime.onRequest(
          this.#instance as never,
          new Request(`https://flue.invalid/agents/${AGENT}/${encodeURIComponent(session)}/abort`, {
            method: "POST",
          }),
        );
        await Promise.race([
          live.settled,
          new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS)),
        ]);
        return outcome;
      }
      live.closed = true;
      if (live.failure) throw new Error(live.failure);
      if (result.outcome !== "completed" && !turn.signal?.aborted)
        throw new Error(`EIO: the turn failed: ${result.error?.message ?? result.outcome}`);
      return outcome;
    } finally {
      live.closed = true;
      turn.signal?.removeEventListener("abort", onAbort);
      if (LIVE.get(session) === live) LIVE.delete(session);
      BY_SUBMISSION.delete(submission);
    }
  }
}

/**
 * One skill folder of the view as a Flue skill: its SKILL.md (front matter and instructions) and
 * every other file of the folder as a resource. Nothing when the folder has no SKILL.md.
 */
async function readSkill(files: FilesApi, dir: string, name: string): Promise<unknown> {
  if (!(await files.exists(`${dir}/SKILL.md`))) return undefined;
  const text = new TextDecoder().decode(await readFile(files, `${dir}/SKILL.md`));
  const parsed = parseSkillMarkdown(text, { directoryName: name, path: `${dir}/SKILL.md` });
  const resources: Record<string, Uint8Array> = {};
  for await (const e of files.list(dir, { recursive: true }))
    if (e.kind === "file" && e.path !== `${dir}/SKILL.md`)
      resources[e.path.slice(dir.length + 1)] = await readFile(files, e.path);
  return defineSkill({
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body.trim() || parsed.description,
    ...(parsed.license ? { license: parsed.license } : {}),
    ...(Object.keys(resources).length ? { files: resources } : {}),
  });
}

/**
 * Drops Flue's state of an agent session from its DO's SQLite (its conversation, submissions and
 * attachments), whether or not the DO built its Flue session in this incarnation.
 */
export function purgeFlue(sql: {
  exec(query: string, ...args: unknown[]): { toArray(): unknown[] };
}) {
  const tables = sql
    .exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'flue\\_%' ESCAPE '\\'",
    )
    .toArray() as { name: string }[];
  for (const { name } of tables) if (name !== "flue_meta") sql.exec(`DELETE FROM "${name}"`);
}

/**
 * One model call with no tools, for the harness's summarizer, through the model gateway (the
 * session's model, metered like any request): the reply's text. A refusal or an error is thrown.
 */
export function completeWith(models: ModelPort): Complete {
  return async ({ system, prompt, maxOutputTokens, signal }) => {
    if (signal?.aborted) throw new Error("EIO: the summarizer was cut short");
    const context = normalizeContext({
      systemPrompt: system,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    } as never);
    const { message: reply } = await models.request({
      context: plain(context),
      ...(maxOutputTokens ? { maxTokens: maxOutputTokens } : {}),
    });
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error(
        `EIO: the summarizer's model failed: ${reply.errorMessage ?? reply.stopReason}`,
      );
    return (reply.content as { type?: string; text?: string }[])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  };
}
