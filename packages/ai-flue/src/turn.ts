// One turn of an agent session on Flue: pi's agent loop (pi-agent-core) with Flue's own tools over
// a just-bash sandbox whose file system is the session's gated file view. The adapter translates
// the loop's messages into the harness's items (statewalker/statewalker-root#76, #87).
// Ported from statewalker-sandbox apps/harness-proto-sessions/src/agent-session.ts.
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  bash as flueBash,
} from "@flue/runtime";
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
  ItemInput,
  Steer,
  TurnOutcome,
} from "@statewalker/ai-sessions";
import type { FilesApi } from "@statewalker/webrun-files";
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
  /** The agent session's id: Flue's sandbox id. */
  id: string;
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
   * items they leave); the loop starts from it. The harness compacts: Flue's own compaction is off.
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
   * Asked before every tool call (statewalker/statewalker-root#179): a refusal's text when a limit
   * on tool calls refuses it (the call is not run, the agent carries on with the refusal as its
   * result), nothing to run it.
   */
  admitTool?(name: string): Promise<string | undefined>;
  /**
   * The names of the tools the model may be offered, Flue's and the host's (none: all of them). A
   * sub-agent's are within its parent's (statewalker/statewalker-root#126).
   */
  allowTools?: readonly string[];
  /** Aborts the turn: it stops at once, keeping what it reported so far. */
  signal?: AbortSignal;
  /**
   * Steering: each message is handed to the loop (pi-agent-core's `steer()`), which takes it at
   * its next step boundary; the turn reports it as a user message item with its `steer` id.
   */
  onSteer?(listener: (steer: Steer) => void): void;
}

/**
 * Flue's tools by name. Every agent is offered Flue's file and shell tools over its file view, until
 * tool sets come with definitions (statewalker/statewalker-root#128).
 */
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

/** The model the loop believes it talks to: the gateway answers with the real one. */
function loopModel(id: string | undefined) {
  return {
    id: id ?? "gateway",
    name: id ?? "gateway",
    api: "openai-completions",
    provider: "gateway",
    baseUrl: "gateway:",
    headers: {},
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

/** Where an answer carries its metered usage through the loop. */
const USAGE = Symbol("usage");

/** A context as plain JSON: tools lose their functions, so it can travel to the gateway. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? { messages: [] }));

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

const textOf = (content: Message["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");

/**
 * The items of one message of the loop; `secrets` by tool call id. An answer's metered usage goes
 * on its first item.
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

/**
 * Runs one turn, reporting its items as each message of the loop ends, after the user's message.
 * Aborting the signal stops the loop; steering joins it at its next step.
 */
export async function runFlueTurn(
  turn: FlueTurn,
  emit: (item: ItemInput) => void,
): Promise<TurnOutcome> {
  const outcome: TurnOutcome = turn.model ? { model: turn.model } : {};
  if (turn.signal?.aborted) return outcome;
  const sandbox = await flueBash(
    () => new Bash({ fs: new FilesFs(turn.files) as never, cwd: `/${turn.project}` }) as never,
  ).createSandbox({ id: turn.id });
  // The names of the secrets each host tool call used, recorded on its item (never the values).
  const secrets = new Map<string, string[]>();
  const hostTools = (turn.tools ?? []).map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
      const result = await tool.execute((params ?? {}) as Record<string, unknown>, signal);
      if (result.secrets?.length) secrets.set(toolCallId, result.secrets);
      if (result.isError) throw new Error(result.output);
      return { content: [{ type: "text", text: result.output }], details: {} };
    },
  }));
  const offered = (name: string) => !turn.allowTools || turn.allowTools.includes(name);
  const tools = [
    ...TRACER_TOOLS.filter(offered).map((name) => TOOLS[name](sandbox as never)),
    ...hostTools.filter((tool) => offered(tool.name)),
  ];
  let requests = 0;
  /**
   * The loop's only way to a model: one gateway request per step. Fallbacks are reported as items
   * as soon as the answer comes; the answer itself then ends the loop's step.
   */
  const streamFn = (_model: unknown, context: unknown, options?: { maxTokens?: number }) => {
    const stream = createAssistantMessageEventStream();
    const aborted = new Promise<ModelMessage>((resolve) => {
      const stop = () =>
        resolve({ ...errorMessage(undefined, "the turn was cut short"), stopReason: "aborted" });
      if (turn.signal?.aborted) stop();
      else turn.signal?.addEventListener("abort", stop, { once: true });
    });
    const asked = turn.models
      .request({
        context: plain(context),
        ...(turn.requested ? { model: turn.requested } : {}),
        ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
      })
      .then(
        (response) => {
          if (requests++ === 0) {
            outcome.model = response.model;
            if (response.substitution) outcome.substitution = response.substitution;
          }
          for (const [i, attempt] of response.attempts.entries()) {
            const next = response.attempts[i + 1];
            if (next)
              emit({
                kind: "model_fallback",
                from: attempt.usage.model,
                to: next.usage.model,
                reason: attempt.usage.outcome,
                usage: attempt.usage,
              });
          }
          const last = response.attempts.at(-1);
          // The answer carries its usage under a symbol: it survives the loop's copies of the
          // message and never travels back to a model (JSON drops it).
          return last ? { ...response.message, [USAGE]: last.usage } : response.message;
        },
        (e: unknown) => errorMessage(undefined, String((e as Error)?.message ?? e)),
      );
    void Promise.race([asked, aborted]).then((message) => {
      stream.push({ type: "start", partial: message } as never);
      if (message.stopReason === "error" || message.stopReason === "aborted")
        stream.push({ type: "error", reason: message.stopReason, error: message } as never);
      else stream.push({ type: "done", reason: message.stopReason, message } as never);
    });
    return stream;
  };
  const agent = new Agent({
    streamFn: streamFn as never,
    getApiKey: async () => "gateway",
    initialState: {
      systemPrompt: [
        `You are the ${turn.agent} agent, working in /${turn.project}.`,
        turn.instructions?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n"),
      model: loopModel(turn.model) as never,
      tools: tools as never,
      // Earlier answers are replayed as the gateway's: it may have served several models.
      messages: contextMessages(turn.context ?? [], {
        api: "openai-completions",
        provider: "gateway",
        id: turn.model ?? "gateway",
      }) as never,
    },
    // A call waiting on an approval ends the turn: the model is not asked again until the user
    // answers, and the answer continues the session.
    afterToolCall: async () => (turn.waiting?.() ? { terminate: true, isError: true } : undefined),
    // A limit on tool calls refuses before the tool runs; one that asks also ends the turn.
    beforeToolCall: async ({ toolCall }: { toolCall: { name: string } }) => {
      const refused = await turn.admitTool?.(toolCall.name);
      if (refused === undefined) return undefined;
      return { block: true, reason: refused, ...(turn.waiting?.() ? { terminate: true } : {}) };
    },
    // Everything steered since the last step joins at the next one.
    steeringMode: "all",
  } as never);
  // Steered messages by identity: the loop reports the very message object it was handed.
  const steered = new Map<unknown, Steer>();
  let failure: string | undefined;
  let prompted = false;
  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    const m = event.message as unknown as Message;
    if (m.role === "user") {
      const steer = steered.get(event.message);
      if (steer) emit({ kind: "message", role: "user", text: steer.text, steer: steer.id });
      else prompted = true;
      return;
    }
    if (!prompted) return;
    if (m.role === "assistant" && m.stopReason === "error")
      failure = `EIO: the model failed: ${m.errorMessage ?? m.stopReason}`;
    for (const item of itemsOf(m, secrets, (event.message as { [USAGE]?: ModelUsage })[USAGE]))
      emit(item);
  });
  turn.onSteer?.((steer) => {
    const message = { role: "user", content: steer.text, timestamp: Date.now() };
    steered.set(message, steer);
    agent.steer(message as never);
  });
  const abort = () => agent.abort();
  turn.signal?.addEventListener("abort", abort);
  try {
    if (turn.signal?.aborted) return outcome;
    await agent.prompt(turn.content);
    await agent.waitForIdle();
  } finally {
    turn.signal?.removeEventListener("abort", abort);
  }
  if (failure && !turn.signal?.aborted) throw new Error(failure);
  return outcome;
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
