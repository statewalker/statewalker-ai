/**
 * Structured reasoning agent loop:
 *
 *  1. **Skill Selection** — pick relevant domain skills (if available).
 *  2. **Planning** — decide which tools to call and in what order.
 *  3. **Tool Calling** — SDK call with tools, guided by planning instructions.
 *     maxSteps >= number of planned calls so all tools can be invoked.
 *  4. **Execution** — run the SDK's validated tool calls via the agent executor.
 *     Results are integrated into the context.
 *  5. **Validation** — check if the gathered information is sufficient.
 *     Returns interpretation instructions for the generation step.
 *     If insufficient → feedback goes back to planning (step 2).
 *  6. **Generation** — produce the final response using the original prompt,
 *     tool results, and interpretation instructions from validation.
 */

import type { LlmApi, ToolSet } from "@statewalker/ai";
import type { LlmMessage } from "@statewalker/ai/messages";
import { jsonSchema, tool as sdkTool } from "@statewalker/ai/tools";
import { z } from "zod";
import type { ExecutionLimits } from "../context/context-manager.js";
import type { AgentEvent, AgentMessage } from "../events/agent-events.js";
import {
  agentAssistant,
  agentEnd,
  agentError,
  agentPhaseEnd,
  agentPhaseStart,
  agentStart,
  agentTextDelta,
  agentThinkingDelta,
  agentToolCall,
  agentTurnEnd,
  agentTurnStart,
  isLlmMessage,
  nowMs,
} from "../events/agent-events.js";
import type { SkillInfo } from "../skills/skill-types.js";
import type { AgentTool } from "../tools/agent-tool.js";
import { executeToolCalls } from "../tools/tool-executor.js";
import type { AgentContext } from "./agent-loop.js";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const SkillSelectionSchema = z.object({
  selectedSkills: z
    .array(z.string())
    .describe(
      "Names of skills to load. Only select skills directly relevant to the user's request. Leave empty if none are needed.",
    ),
  reasoning: z
    .string()
    .describe("Brief explanation of why these skills were selected (or not)"),
});

export type SkillSelectionResult = z.infer<typeof SkillSelectionSchema>;

const PlannedToolCallSchema = z.object({
  toolName: z.string().describe("Name of the tool to call"),
  reason: z
    .string()
    .describe("Why this tool is needed and what information to extract"),
});

const PlanningResultSchema = z.object({
  toolCalls: z
    .array(PlannedToolCallSchema)
    .describe(
      "Ordered list of tools to call. Leave empty if no tools are needed.",
    ),
  toolCallPrompt: z
    .string()
    .describe(
      "A simplified/reformulated prompt for the tool-calling step describing what information to gather and how to use the listed tools",
    ),
});

const ValidationResultSchema = z.object({
  sufficient: z
    .boolean()
    .describe(
      "Whether the gathered information is sufficient to generate a response",
    ),
  interpretationInstructions: z
    .string()
    .describe(
      "Instructions on how to interpret tool results when generating the response. " +
        "Include which results are most relevant, what to emphasize, and how to structure the answer.",
    ),
  feedback: z
    .string()
    .optional()
    .describe(
      "When sufficient is false: explanation of what information is missing and what additional tools to try",
    ),
});

export type PlanningResult = z.infer<typeof PlanningResultSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StructuredLoopConfig {
  llm: LlmApi;
  model: string;
  systemPrompt: string;
  tools: AgentTool[];
  /** Available skills (domain expertise). When provided, a skill-selection
   *  phase runs before planning to load only relevant skill content. */
  skills?: SkillInfo[];
  /** Maximum plan→validate iterations (default: 3). */
  maxIterations?: number;
  /** Override the default planning system prompt. */
  planningPrompt?: string;
  /** Override the default validation system prompt. */
  validationPrompt?: string;
  /** Execution limits (turns, tokens, duration). */
  executionLimits?: ExecutionLimits;
  /** Called on error. */
  onError?: (error: string) => void;
}

// ---------------------------------------------------------------------------
// Default prompts
// ---------------------------------------------------------------------------

const DEFAULT_SKILL_SELECTION_PROMPT = `You are a skill selection assistant. Given the user's request and a list of available skills, select ONLY the skills that are directly relevant.

Skills provide domain expertise and may describe specific tool usage patterns. Only load skills when they add value — do not select skills for general knowledge questions.`;

const DEFAULT_PLANNING_PROMPT = `You are a planning assistant. Analyze the user's request and decide which tools to call and in what order.

List the tools in toolCalls in the order they should be called. Provide a toolCallPrompt — a simplified, reformulated instruction for the tool-calling step.

If no tools are needed, leave toolCalls empty and provide a toolCallPrompt explaining why a direct response is sufficient.`;

const DEFAULT_TOOL_CALLING_PROMPT = `You are a tool-calling assistant. Based on the instructions below, call the appropriate tools to gather the information needed. Use the tools available to you — do NOT respond with text, only make tool calls.`;

const DEFAULT_VALIDATION_PROMPT = `You are a validation assistant. Given the user's original request and the tool results gathered so far, determine:

1. Is the gathered information sufficient to generate a complete, accurate response?
2. How should the tool results be interpreted when generating the response?

If the information is sufficient, set sufficient to true and provide detailed interpretationInstructions.
If the information is insufficient, set sufficient to false, explain what is missing in feedback, and still provide interpretationInstructions for what was gathered so far.`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function* structuredAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: StructuredLoopConfig,
): AsyncGenerator<AgentEvent> {
  const abort = new AbortController();
  const { signal } = abort;

  try {
    yield agentStart();

    for (const p of prompts) {
      context.messages.push(p);
    }

    const maxIterations = config.maxIterations ?? 3;
    let loadedSkillContent = "";

    // -------------------------------------------------------------------
    // Phase 0: Skill Selection (once, before the planning loop)
    // -------------------------------------------------------------------
    if (config.skills && config.skills.length > 0) {
      yield agentPhaseStart("skill-selection");

      try {
        const selection = await runSkillSelection(context, config, signal);
        const selected = config.skills.filter((s) =>
          selection.selectedSkills.includes(s.name),
        );
        if (selected.length > 0) {
          loadedSkillContent = formatLoadedSkills(selected);
        }
        yield agentPhaseEnd("skill-selection", selection);
      } catch (err) {
        yield agentPhaseEnd("skill-selection", {
          selectedSkills: [],
          reasoning: `Selection skipped: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // -------------------------------------------------------------------
    // Planning → Tool Calling → Validation loop
    // -------------------------------------------------------------------
    let feedbackContext = "";
    let validationResult: ValidationResult | undefined;
    const allToolResults: AgentMessage[] = [];

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (signal.aborted) break;

      yield agentTurnStart(iteration);

      // ----- Phase 1: Planning -----
      yield agentPhaseStart("planning");

      let plan: PlanningResult;
      try {
        plan = await runPlanning(
          context,
          config,
          feedbackContext,
          loadedSkillContent,
          signal,
        );
      } catch (err) {
        yield agentError(err instanceof Error ? err.message : String(err));
        yield agentPhaseEnd("planning");
        yield agentTurnEnd("error", config.model);
        config.onError?.(err instanceof Error ? err.message : String(err));
        break;
      }

      yield agentPhaseEnd("planning", plan);

      // ----- Phase 2: Tool Calling + Execution -----
      if (plan.toolCalls.length > 0 && context.tools.length > 0) {
        yield agentPhaseStart("execution");

        try {
          const results = yield* runToolCalling(
            context,
            config,
            plan,
            loadedSkillContent,
            iteration,
            signal,
          );
          allToolResults.push(...results);
        } catch (err) {
          yield agentError(err instanceof Error ? err.message : String(err));
        }

        yield agentPhaseEnd("execution");
      }

      // ----- Phase 3: Validation -----
      yield agentPhaseStart("evaluation");

      try {
        validationResult = await runValidation(
          context,
          config,
          allToolResults,
          signal,
        );
      } catch (_err) {
        // Validation failure — assume sufficient and proceed
        validationResult = {
          sufficient: true,
          interpretationInstructions:
            "Synthesize available information into a helpful response.",
          feedback: undefined,
        };
      }

      yield agentPhaseEnd("evaluation", validationResult);

      if (validationResult.sufficient) {
        yield agentTurnEnd("stop", config.model);
        break;
      }

      // Insufficient — loop back to planning with feedback
      feedbackContext =
        validationResult.feedback ?? "Insufficient information gathered.";
      yield agentTurnEnd("replan" as string, config.model);
    }

    // -------------------------------------------------------------------
    // Phase 4: Generation (once, after validation passes)
    // -------------------------------------------------------------------
    yield agentPhaseStart("generation");
    yield agentAssistant();

    let generatedText: string;
    try {
      generatedText = yield* runGeneration(
        context,
        config,
        allToolResults,
        validationResult?.interpretationInstructions ?? "",
        loadedSkillContent,
        signal,
      );
    } catch (err) {
      yield agentError(err instanceof Error ? err.message : String(err));
      yield agentPhaseEnd("generation");
      config.onError?.(err instanceof Error ? err.message : String(err));
      yield agentEnd();
      return;
    }

    context.messages.push({
      role: "assistant",
      content: generatedText,
      timestamp: nowMs(),
      stopReason: "stop",
      model: config.model,
    });

    yield agentPhaseEnd("generation");
    yield agentEnd();
  } finally {
    abort.abort();
  }
}

// ---------------------------------------------------------------------------
// Phase implementations
// ---------------------------------------------------------------------------

async function runSkillSelection(
  context: AgentContext,
  config: StructuredLoopConfig,
  signal: AbortSignal,
): Promise<SkillSelectionResult> {
  const skills = config.skills ?? [];
  const skillIndex = skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  return config.llm.generateObject({
    model: config.model,
    system: `${DEFAULT_SKILL_SELECTION_PROMPT}\n\nAvailable skills:\n${skillIndex}`,
    messages: buildContextMessages(context),
    schema: SkillSelectionSchema,
    schemaName: "SkillSelectionResult",
    schemaDescription:
      "Select which skills to load based on the user's request",
    signal,
  });
}

async function runPlanning(
  context: AgentContext,
  config: StructuredLoopConfig,
  feedbackContext: string,
  loadedSkillContent: string,
  signal: AbortSignal,
): Promise<PlanningResult> {
  const toolDescriptions = formatToolDescriptions(config.tools);
  const agentContext = config.systemPrompt
    ? `\n\n## Agent Context\n${config.systemPrompt}`
    : "";
  const skillContext = loadedSkillContent
    ? `\n\n## Loaded Skills\n${loadedSkillContent}`
    : "";
  const planningSystem =
    (config.planningPrompt ?? DEFAULT_PLANNING_PROMPT) +
    agentContext +
    skillContext +
    (toolDescriptions ? `\n\n${toolDescriptions}` : "");

  const messages = buildContextMessages(context);
  if (feedbackContext) {
    messages.push({
      role: "user",
      content: `[Validation feedback — information was insufficient]\n${feedbackContext}\n\nPlease replan to gather the missing information.`,
    });
  }

  return config.llm.generateObject({
    model: config.model,
    system: planningSystem,
    messages,
    schema: PlanningResultSchema,
    schemaName: "PlanningResult",
    schemaDescription: "Tool call plan with instructions",
    signal,
  });
}

async function* runToolCalling(
  context: AgentContext,
  config: StructuredLoopConfig,
  plan: PlanningResult,
  loadedSkillContent: string,
  iteration: number,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, AgentMessage[]> {
  const plannedNames = plan.toolCalls.map((tc) => tc.toolName);
  const plannedTools = context.tools.filter((t) =>
    plannedNames.includes(t.name),
  );
  const toolSet = agentToolsToToolSet(
    plannedTools.length > 0 ? plannedTools : context.tools,
  );

  const toolList = plan.toolCalls
    .map((tc, i) => `${i + 1}. **${tc.toolName}** — ${tc.reason}`)
    .join("\n");
  const skillSection = loadedSkillContent
    ? `\n\n## Domain Expertise\n${loadedSkillContent}`
    : "";
  const system =
    `${DEFAULT_TOOL_CALLING_PROMPT}\n\n## Instructions\n${plan.toolCallPrompt}` +
    `\n\n## Tools to call (in order)\n${toolList}` +
    skillSection;

  // maxSteps >= planned tool count so the SDK can complete all calls.
  const maxSteps = plan.toolCalls.length + 1;

  const stream = config.llm.streamChatCompletion({
    model: config.model,
    system,
    messages: buildContextMessages(context),
    signal,
    tools: toolSet,
    maxSteps,
  });

  const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];

  for await (const part of stream) {
    if (signal.aborted) break;
    if (part.type === "tool-call") {
      const call = {
        id: part.toolCallId ?? `structured-${iteration}-${toolCalls.length}`,
        name: part.toolName,
        args: part.args,
      };
      toolCalls.push(call);
      yield agentToolCall({
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
      });
    }
  }

  if (toolCalls.length === 0) return [];

  const toolGen = executeToolCalls(context.tools, toolCalls, signal, {
    type: "parallel",
  });

  const resultMessages: AgentMessage[] = [];
  let toolNext = await toolGen.next();
  while (!toolNext.done) {
    const event = toolNext.value;
    if (event.props.type === "agent:tool-result") {
      yield event;
    }
    toolNext = await toolGen.next();
  }

  for (const result of toolNext.value.toolResults) {
    context.messages.push(result);
    resultMessages.push(result);
  }

  return resultMessages;
}

async function runValidation(
  context: AgentContext,
  config: StructuredLoopConfig,
  toolResultMessages: AgentMessage[],
  signal: AbortSignal,
): Promise<ValidationResult> {
  const content: string[] = [
    "## User Request",
    ...context.messages
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => p.text ?? "").join(""),
      ),
  ];

  if (toolResultMessages.length > 0) {
    content.push("", "## Tool Results Gathered");
    for (const result of toolResultMessages) {
      const text =
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);
      content.push(`### ${result.toolName ?? "unknown"}`, text, "");
    }
  } else {
    content.push("", "## No tool results gathered yet.");
  }

  return config.llm.generateObject({
    model: config.model,
    system: config.validationPrompt ?? DEFAULT_VALIDATION_PROMPT,
    messages: [{ role: "user", content: content.join("\n") }],
    schema: ValidationResultSchema,
    schemaName: "ValidationResult",
    schemaDescription:
      "Check if gathered information is sufficient for a response",
    signal,
  });
}

async function* runGeneration(
  context: AgentContext,
  config: StructuredLoopConfig,
  toolResultMessages: AgentMessage[],
  interpretationInstructions: string,
  loadedSkillContent: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, string> {
  const messages = buildGenerationMessages(context, toolResultMessages);

  const skillSection = loadedSkillContent
    ? `\n\n## Domain Expertise\n${loadedSkillContent}`
    : "";
  const interpretSection = interpretationInstructions
    ? `\n\n## How to Interpret Results\n${interpretationInstructions}`
    : "";
  const systemPrompt = config.systemPrompt + skillSection + interpretSection;

  const stream = config.llm.streamChatCompletion({
    model: config.model,
    system: systemPrompt,
    messages,
    signal,
    maxSteps: 1,
  });

  const textParts: string[] = [];

  for await (const part of stream) {
    if (signal.aborted) break;
    switch (part.type) {
      case "text-delta":
        textParts.push(part.textDelta);
        yield agentTextDelta(part.textDelta);
        break;
      case "reasoning":
        yield agentThinkingDelta(part.textDelta);
        break;
    }
  }

  return textParts.join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatToolDescriptions(tools: AgentTool[]): string {
  if (tools.length === 0) return "";
  const lines = ["Available tools:"];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
  }
  return lines.join("\n");
}

function agentToolsToToolSet(tools: AgentTool[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const t of tools) {
    // Prefer the original SDK schema (Zod or jsonSchema wrapper) for full
    // validation. Fall back to reconstructing from the JSON Schema, or a
    // permissive passthrough as last resort.
    let inputSchema: unknown;
    if (t.sdkInputSchema) {
      inputSchema = t.sdkInputSchema;
    } else {
      const schema = t.parametersSchema;
      const hasSchema =
        schema &&
        typeof schema === "object" &&
        Object.keys(schema).length > 0 &&
        (schema as Record<string, unknown>).type === "object";
      inputSchema = hasSchema
        ? jsonSchema(schema as Record<string, unknown>)
        : z.object({}).passthrough();
    }

    toolSet[t.name] = sdkTool({
      description: t.description,
      inputSchema: inputSchema,
    } as Parameters<typeof sdkTool>[0]) as ToolSet[string];
  }
  return toolSet;
}

function formatLoadedSkills(skills: SkillInfo[]): string {
  return skills.map((s) => `### Skill: ${s.name}\n${s.content}`).join("\n\n");
}

function buildContextMessages(context: AgentContext): LlmMessage[] {
  return context.messages.filter(isLlmMessage).map((msg): LlmMessage => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");

    if (msg.role === "tool-result") {
      return {
        role: "user",
        content: `[Tool result: ${msg.toolName}]\n${content}`,
      };
    }

    return { role: msg.role as "user" | "assistant", content };
  });
}

function buildGenerationMessages(
  context: AgentContext,
  toolResultMessages: AgentMessage[],
): LlmMessage[] {
  const messages: LlmMessage[] = [];

  for (const msg of context.messages) {
    if (msg.role === "user") {
      messages.push({
        role: "user",
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content.map((p) => p.text ?? "").join(""),
      });
    }
  }

  if (toolResultMessages.length > 0) {
    const resultParts: string[] = ["## Tool Results"];
    for (const result of toolResultMessages) {
      const text =
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);
      resultParts.push(`### ${result.toolName ?? "unknown"}`, text, "");
    }
    messages.push({ role: "user", content: resultParts.join("\n") });
  }

  return messages;
}
