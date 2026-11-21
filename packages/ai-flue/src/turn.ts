// One turn of an agent session on Flue: pi's agent loop (pi-agent-core) with Flue's own tools over
// a just-bash sandbox whose file system is the session's gated file view. The adapter translates
// the loop's messages into the harness's items (statewalker/statewalker-root#76, #87).
// Ported from statewalker-sandbox apps/harness-proto-sessions/src/agent-session.ts.
import { Agent } from "@earendil-works/pi-agent-core";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { registerApiProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  bash as flueBash,
} from "@flue/runtime";
import type { ItemInput } from "@statewalker/ai-sessions";
import type { FilesApi } from "@statewalker/webrun-files";
import { Bash } from "just-bash/browser";
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
  /** The agent's name. */
  agent: string;
  /** The session's project; its folder is the working directory. */
  project: string;
  /** The gated file view the session holds. */
  files: FilesApi;
  model: ModelConfig;
  /** The user's message. */
  content: string;
  /** Tools the host runs (beside Flue's own over the sandbox). */
  tools?: HostTool[];
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

/** The items of the loop's messages after the user's own; `secrets` by tool call id. */
function* itemsOf(
  messages: Message[],
  secrets: ReadonlyMap<string, string[]>,
): Generator<ItemInput> {
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted")
        throw new Error(`EIO: the model failed: ${m.errorMessage ?? m.stopReason}`);
      const text = textOf(m.content);
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
}

/** Runs one turn and reports its items, in order, after the user's message. */
export async function runFlueTurn(turn: FlueTurn, emit: (item: ItemInput) => void): Promise<void> {
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
  const tools = [...TRACER_TOOLS.map((name) => TOOLS[name](sandbox as never)), ...hostTools];
  const agent = new Agent({
    streamFn: streamSimple as never,
    getApiKey: async () => turn.model.apiKey ?? "none",
    initialState: {
      systemPrompt: `You are the ${turn.agent} agent, working in /${turn.project}.`,
      model: piModel(turn.model) as never,
      tools: tools as never,
      messages: [],
    },
  } as never);
  await agent.prompt(turn.content);
  await agent.waitForIdle();
  const messages = (agent.state as unknown as { messages: Message[] }).messages;
  const start = messages.findIndex((m) => m.role === "user");
  for (const item of itemsOf(messages.slice(start + 1), secrets)) emit(item);
}
