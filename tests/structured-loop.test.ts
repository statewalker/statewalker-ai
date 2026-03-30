import type { LlmApi, StreamPart } from "@statewalker/ai";
import { describe, expect, it } from "vitest";
import {
  formatToolDescriptions,
  type PlanningResult,
  type SkillSelectionResult,
  type StructuredLoopConfig,
  structuredAgentLoop,
  type ValidationResult,
} from "../src/agent/structured-loop.js";
import type { AgentEvent } from "../src/events/agent-events.js";
import { userMessage } from "../src/events/agent-events.js";
import type {
  AgentTool,
  ToolContext,
  ToolOutput,
} from "../src/tools/agent-tool.js";

// ---------------------------------------------------------------------------
// Mock LLM
// ---------------------------------------------------------------------------

interface MockLlmOptions {
  plans: PlanningResult[];
  validations: ValidationResult[];
  generatedTexts: string[];
  skillSelections?: SkillSelectionResult[];
  toolCallResponses?: Array<Array<{ name: string; args: unknown }>>;
}

function createMockLlm(options: MockLlmOptions): LlmApi {
  let planIndex = 0;
  let valIndex = 0;
  let textIndex = 0;
  let skillSelIndex = 0;
  let toolCallIndex = 0;

  return {
    connect() {},
    disconnect() {},
    registerTools() {
      return () => {};
    },
    getRegisteredTools() {
      return {};
    },
    async *streamChatCompletion(opts: {
      tools?: unknown;
    }): AsyncGenerator<StreamPart> {
      const hasTools = opts.tools && Object.keys(opts.tools).length > 0;

      if (hasTools) {
        const calls = options.toolCallResponses?.[toolCallIndex++] ?? [];
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          if (!call) continue;
          yield {
            type: "tool-call",
            toolCallId: `tc-${toolCallIndex}-${i}`,
            toolName: call.name,
            args: (call.args ?? {}) as Record<string, unknown>,
          };
        }
        yield { type: "step-finish", finishReason: "tool-calls" };
      } else {
        const text = options.generatedTexts[textIndex++] ?? "(no text)";
        yield { type: "text-delta", textDelta: text };
        yield { type: "step-finish", finishReason: "stop" };
      }
    },
    async generateText() {
      return "mock text";
    },
    async generateObject({ schemaName }: { schemaName?: string }) {
      if (schemaName === "SkillSelectionResult") {
        return (options.skillSelections?.[skillSelIndex++] ??
          options.skillSelections?.[0] ?? {
            selectedSkills: [],
            reasoning: "none",
          }) as never;
      }
      if (schemaName === "PlanningResult") {
        return (options.plans[planIndex++] ?? options.plans[0]) as never;
      }
      if (schemaName === "ValidationResult") {
        return (options.validations[valIndex++] ??
          options.validations[0]) as never;
      }
      return {} as never;
    },
  };
}

function makeTool(
  name: string,
  handler: (args: unknown) => string | Promise<string>,
): AgentTool {
  return {
    name,
    label: name,
    description: `Mock tool: ${name}`,
    parametersSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      return { text: await handler(params) };
    },
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function eventTypes(events: AgentEvent[]): string[] {
  return events.map((e) => e.props.type);
}

function phaseEvents(
  events: AgentEvent[],
): Array<{ type: string; phase: string }> {
  return events
    .filter(
      (e) =>
        e.props.type === "agent:phase-start" ||
        e.props.type === "agent:phase-end",
    )
    .map((e) => ({
      type: e.props.type,
      phase: (e.props as Record<string, string>).phase ?? "",
    }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("structuredAgentLoop", () => {
  it("plan → validate (sufficient) → generate, no tools", async () => {
    const llm = createMockLlm({
      plans: [{ toolCalls: [], toolCallPrompt: "No tools needed" }],
      validations: [
        {
          sufficient: true,
          interpretationInstructions: "Answer directly from knowledge",
        },
      ],
      generatedTexts: ["Hello! How can I help?"],
    });

    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools: [],
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("Hi")],
        { systemPrompt: "", messages: [], tools: [] },
        config,
      ),
    );

    const types = eventTypes(events);
    expect(types[0]).toBe("agent:start");
    expect(types[types.length - 1]).toBe("agent:end");

    const phases = phaseEvents(events).map((p) => p.phase);
    expect(phases).toContain("planning");
    expect(phases).toContain("evaluation"); // validation uses "evaluation" phase type
    expect(phases).toContain("generation");
    expect(phases).not.toContain("execution");
    expect(phases).not.toContain("skill-selection");

    const textDeltas = events.filter(
      (e) => e.props.type === "agent:text-delta",
    );
    expect(textDeltas[0]?.blocks[0]?.content).toBe("Hello! How can I help?");
  });

  it("plan → execute → validate → generate, with tools", async () => {
    const searchTool = makeTool("search", (args) => {
      const p = args as Record<string, unknown>;
      return `Found: ${p.query}`;
    });

    const llm = createMockLlm({
      plans: [
        {
          toolCalls: [{ toolName: "search", reason: "Find data" }],
          toolCallPrompt: "Search for test data",
        },
      ],
      validations: [
        {
          sufficient: true,
          interpretationInstructions: "Summarize search results",
        },
      ],
      generatedTexts: ["Based on the search results..."],
      toolCallResponses: [[{ name: "search", args: { query: "test" } }]],
    });

    const tools = [searchTool];
    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools,
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("Search for test")],
        { systemPrompt: "", messages: [], tools },
        config,
      ),
    );

    const phases = phaseEvents(events).map((p) => p.phase);
    expect(phases).toContain("planning");
    expect(phases).toContain("execution");
    expect(phases).toContain("evaluation");
    expect(phases).toContain("generation");

    const toolCalls = events.filter((e) => e.props.type === "agent:tool-call");
    expect(toolCalls.length).toBe(1);

    const toolResults = events.filter(
      (e) => e.props.type === "agent:tool-result",
    );
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.blocks[0]?.content).toContain("Found: test");
  });

  it("replans when validation says insufficient", async () => {
    const listTool = makeTool("list_files", () => "file1.md, file2.md");
    const readTool = makeTool("read_file", () => "File content here");

    const llm = createMockLlm({
      plans: [
        {
          toolCalls: [{ toolName: "list_files", reason: "Find files" }],
          toolCallPrompt: "List notes",
        },
        {
          toolCalls: [{ toolName: "read_file", reason: "Read file content" }],
          toolCallPrompt: "Read the found files",
        },
      ],
      validations: [
        {
          sufficient: false,
          interpretationInstructions: "File list obtained",
          feedback: "Need to read file contents, not just list them",
        },
        {
          sufficient: true,
          interpretationInstructions: "Summarize the file contents",
        },
      ],
      generatedTexts: ["Here is a summary of your notes..."],
      toolCallResponses: [
        [{ name: "list_files", args: {} }],
        [{ name: "read_file", args: { path: "file1.md" } }],
      ],
    });

    const tools = [listTool, readTool];
    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools,
      maxIterations: 3,
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("Summarize my notes")],
        { systemPrompt: "", messages: [], tools },
        config,
      ),
    );

    // Should have 2 turn-starts (two planning iterations)
    const turnStarts = events.filter(
      (e) => e.props.type === "agent:turn-start",
    );
    expect(turnStarts.length).toBe(2);

    // Should have 2 planning phases and 2 execution phases
    const planStarts = phaseEvents(events).filter(
      (p) => p.type === "agent:phase-start" && p.phase === "planning",
    );
    expect(planStarts.length).toBe(2);

    // Generation should still happen (after validation passes)
    const phases = phaseEvents(events).map((p) => p.phase);
    expect(phases).toContain("generation");

    // Final text should be present
    const textDeltas = events.filter(
      (e) => e.props.type === "agent:text-delta",
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it("respects maxIterations limit", async () => {
    const llm = createMockLlm({
      plans: [{ toolCalls: [], toolCallPrompt: "Try" }],
      validations: [
        {
          sufficient: false,
          interpretationInstructions: "Partial",
          feedback: "Not enough",
        },
      ],
      generatedTexts: ["Best effort response"],
    });

    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools: [],
      maxIterations: 2,
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("Do something")],
        { systemPrompt: "", messages: [], tools: [] },
        config,
      ),
    );

    const turnStarts = events.filter(
      (e) => e.props.type === "agent:turn-start",
    );
    expect(turnStarts.length).toBe(2);

    // Should still generate even after max iterations
    const phases = phaseEvents(events).map((p) => p.phase);
    expect(phases).toContain("generation");
    expect(eventTypes(events).at(-1)).toBe("agent:end");
  });

  it("validation phase-end contains interpretation instructions", async () => {
    const llm = createMockLlm({
      plans: [{ toolCalls: [], toolCallPrompt: "Direct" }],
      validations: [
        {
          sufficient: true,
          interpretationInstructions: "Use the user greeting to respond warmly",
        },
      ],
      generatedTexts: ["Hi there!"],
    });

    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools: [],
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("Hello")],
        { systemPrompt: "", messages: [], tools: [] },
        config,
      ),
    );

    const valEnd = events.find(
      (e) =>
        e.props.type === "agent:phase-end" &&
        (e.props as Record<string, string>).phase === "evaluation",
    );
    expect(valEnd).toBeDefined();
    expect(valEnd).toBeDefined();
    const data = JSON.parse(valEnd?.blocks[0]?.content ?? "{}");
    expect(data.sufficient).toBe(true);
    expect(data.interpretationInstructions).toContain("respond warmly");
  });

  it("runs skill selection before planning", async () => {
    const llm = createMockLlm({
      skillSelections: [
        {
          selectedSkills: ["browse-notes"],
          reasoning: "User asked about notes",
        },
      ],
      plans: [{ toolCalls: [], toolCallPrompt: "Use notes skill" }],
      validations: [
        {
          sufficient: true,
          interpretationInstructions: "Follow browse-notes skill instructions",
        },
      ],
      generatedTexts: ["Your notes..."],
    });

    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools: [],
      skills: [
        {
          name: "browse-notes",
          description: "List and display notes",
          content: "Notes are at notes/{date}/{time}.md",
        },
        {
          name: "code-review",
          description: "Code review",
          content: "Review code...",
        },
      ],
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("Show my notes")],
        { systemPrompt: "", messages: [], tools: [] },
        config,
      ),
    );

    const phases = phaseEvents(events).map((p) => p.phase);
    expect(phases).toContain("skill-selection");
    expect(phases.indexOf("skill-selection")).toBeLessThan(
      phases.indexOf("planning"),
    );

    const skillEnd = events.find(
      (e) =>
        e.props.type === "agent:phase-end" &&
        (e.props as Record<string, string>).phase === "skill-selection",
    );
    expect(skillEnd).toBeDefined();
    const data = JSON.parse(skillEnd?.blocks[0]?.content ?? "{}");
    expect(data.selectedSkills).toContain("browse-notes");
    expect(data.selectedSkills).not.toContain("code-review");
  });

  it("skips skill selection when no skills configured", async () => {
    const llm = createMockLlm({
      plans: [{ toolCalls: [], toolCallPrompt: "Direct" }],
      validations: [{ sufficient: true, interpretationInstructions: "Answer" }],
      generatedTexts: ["Response"],
    });

    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools: [],
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("Hello")],
        { systemPrompt: "", messages: [], tools: [] },
        config,
      ),
    );

    const phases = phaseEvents(events).map((p) => p.phase);
    expect(phases).not.toContain("skill-selection");
  });

  it("skips execution when plan.toolCalls is empty", async () => {
    const tool = makeTool("search", () => "results");
    const llm = createMockLlm({
      plans: [{ toolCalls: [], toolCallPrompt: "No tools needed" }],
      validations: [
        { sufficient: true, interpretationInstructions: "Direct answer" },
      ],
      generatedTexts: ["42"],
    });

    const config: StructuredLoopConfig = {
      llm,
      model: "test",
      systemPrompt: "You are helpful",
      tools: [tool],
    };

    const events = await collectEvents(
      structuredAgentLoop(
        [userMessage("What is 2+2?")],
        { systemPrompt: "", messages: [], tools: [tool] },
        config,
      ),
    );

    const phases = phaseEvents(events).map((p) => p.phase);
    expect(phases).not.toContain("execution");
  });
});

describe("formatToolDescriptions", () => {
  it("formats tool names and descriptions", () => {
    const tools: AgentTool[] = [
      {
        name: "search",
        label: "Search",
        description: "Search for content",
        parametersSchema: {},
        execute: async () => ({ text: "" }),
      },
    ];
    const result = formatToolDescriptions(tools);
    expect(result).toContain("search");
    expect(result).toContain("Search for content");
  });

  it("returns empty string for no tools", () => {
    expect(formatToolDescriptions([])).toBe("");
  });
});
