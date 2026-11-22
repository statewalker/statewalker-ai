// One turn of an agent session on Flue: pi's agent loop (pi-agent-core) with Flue's own tools over
// a just-bash sandbox whose file system is the session's gated file view. The adapter translates
// the loop's messages into the harness's items (statewalker/statewalker-root#76, #87).
// Ported from statewalker-sandbox apps/harness-proto-sessions/src/agent-session.ts.
import { Agent } from "@earendil-works/pi-agent-core";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { completeSimple, registerApiProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  bash as flueBash,
} from "@flue/runtime";
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

/** An OpenAI-compatible chat-completions model (the gateway comes in a later ticket). */
export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
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
  model: ModelConfig;
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

let registered = false;
function piModel(m: ModelConfig) {
  if (!registered) {
    registerApiProvider(
      {
        api: "openai-completions",
        stream: openaiCompletions.stream as never,
        streamSimple: openaiCompletions.streamSimple as never,
      },
      "statewalker-ai",
    );
    registered = true;
  }
  return {
    id: m.model,
    name: m.model,
    api: "openai-completions",
    provider: "deployment",
    baseUrl: m.baseUrl,
    headers: {},
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

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

/** The items of one message of the loop; `secrets` by tool call id. */
function* itemsOf(m: Message, secrets: ReadonlyMap<string, string[]>): Generator<ItemInput> {
  if (m.role === "assistant") {
    const text = textOf(m.content);
    if (m.stopReason === "aborted") {
      // Cut short: what the model had said so far, marked incomplete.
      if (text) yield { kind: "message", role: "assistant", text, incomplete: true };
      return;
    }
    if (m.stopReason === "error") return;
    if (text) yield { kind: "message", role: "assistant", text };
    for (const p of Array.isArray(m.content) ? m.content : [])
      if (p.type === "toolCall")
        yield { kind: "tool_call", callId: p.id, name: p.name, args: p.arguments };
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
  const outcome: TurnOutcome = { model: turn.model.model };
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
  const agent = new Agent({
    streamFn: streamSimple as never,
    getApiKey: async () => turn.model.apiKey ?? "none",
    initialState: {
      systemPrompt: [
        `You are the ${turn.agent} agent, working in /${turn.project}.`,
        turn.instructions?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n"),
      model: piModel(turn.model) as never,
      tools: tools as never,
      messages: contextMessages(turn.context ?? [], {
        api: "openai-completions",
        provider: "deployment",
        id: turn.model.model,
      }) as never,
    },
    // A call waiting on an approval ends the turn: the model is not asked again until the user
    // answers, and the answer continues the session.
    afterToolCall: async () => (turn.waiting?.() ? { terminate: true, isError: true } : undefined),
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
    for (const item of itemsOf(m, secrets)) emit(item);
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
 * One model call with no tools, for the harness's summarizer: the reply's text. A refusal or an
 * error is thrown.
 */
export function completeWith(model: ModelConfig): Complete {
  return async ({ system, prompt, maxOutputTokens, signal }) => {
    const reply = await completeSimple(
      piModel(model) as never,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      { maxTokens: maxOutputTokens, apiKey: model.apiKey ?? "none", ...(signal ? { signal } : {}) },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error(
        `EIO: the summarizer's model failed: ${reply.errorMessage ?? reply.stopReason}`,
      );
    return reply.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
  };
}
