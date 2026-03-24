/**
 * SubAgentTool — delegates tasks to a child agent loop.
 *
 * When the parent LLM calls this tool, it spawns a fresh agent loop
 * with its own system prompt, tools, and config. The sub-agent runs
 * to completion and its final text output is returned.
 */
import type { LlmApi } from "@statewalker/ai";
import type { AgentMessage } from "../events/agent-events.js";
import { userMessage } from "../events/agent-events.js";
import type {
  AgentTool,
  ToolContext,
  ToolExecutionStrategy,
  ToolOutput,
} from "../tools/agent-tool.js";
import { ToolError } from "../tools/agent-tool.js";
import type { AgentContext } from "./agent-loop.js";
import { agentLoop } from "./agent-loop.js";

const DEFAULT_MAX_TURNS = 10;

export class SubAgentTool implements AgentTool {
  name: string;
  label: string;
  description: string;
  parametersSchema: Record<string, unknown>;

  private systemPrompt = "";
  private model = "";
  private llm: LlmApi;
  private tools: AgentTool[] = [];
  private maxTurns = DEFAULT_MAX_TURNS;
  private maxSteps = 15;
  private toolExecution: ToolExecutionStrategy = { type: "parallel" };

  constructor(name: string, llm: LlmApi) {
    this.name = name;
    this.label = name;
    this.description = `Delegate a task to the '${name}' sub-agent`;
    this.llm = llm;
    this.parametersSchema = {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task to delegate to this sub-agent",
        },
      },
      required: ["task"],
    };
  }

  withDescription(desc: string): this {
    this.description = desc;
    return this;
  }

  withSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  withModel(model: string): this {
    this.model = model;
    return this;
  }

  withTools(tools: AgentTool[]): this {
    this.tools = tools;
    return this;
  }

  withMaxTurns(max: number): this {
    this.maxTurns = max;
    return this;
  }

  async execute(params: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const args = params as Record<string, unknown>;
    const task = args.task;
    if (typeof task !== "string") {
      throw new ToolError("Missing required 'task' parameter", "invalid-args");
    }

    const context: AgentContext = {
      systemPrompt: this.systemPrompt,
      messages: [],
      tools: this.tools,
    };

    const config = {
      llm: this.llm,
      model: this.model,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      toolExecution: this.toolExecution,
      maxSteps: this.maxSteps,
      executionLimits: {
        maxTurns: this.maxTurns,
        maxTotalTokens: 1_000_000,
        maxDurationMs: 300_000,
      },
    };

    // Consume the generator, forwarding relevant events to parent
    for await (const event of agentLoop([userMessage(task)], context, config)) {
      if (ctx.signal.aborted) break;
      const eventType = event.props.type;
      const content = event.blocks[0]?.content ?? "";

      if (eventType === "agent:tool-progress" && ctx.onProgress) {
        ctx.onProgress(content);
      }
      if (eventType === "agent:text-delta" && ctx.onUpdate) {
        ctx.onUpdate({
          text: content,
          details: { subAgent: this.name },
        });
      }
    }

    const resultText = extractFinalText(context.messages);

    return {
      text: resultText,
      details: { subAgent: this.name, turns: context.messages.length },
    };
  }
}

function extractFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      if (typeof msg.content === "string") return msg.content;
      const texts = msg.content
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "");
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return "(sub-agent produced no text output)";
}
