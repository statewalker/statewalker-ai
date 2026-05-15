import { SnowflakeId } from "@statewalker/shared-ids";
import { generateText } from "ai";
import type { SelectionStrategy } from "../context/select-messages.js";
import { bridgeMcpTools } from "../mcp/bridge-mcp-tools.js";
import { Inbox } from "../state/inbox.js";
import { createAgentNodeFactory } from "../state/node-factory.js";
import { NodeType } from "../state/node-types.js";
import type { SessionState } from "../state/session-state.js";
import { SkillsModel } from "../state/skills-model.js";
import { ToolRegistry } from "../state/tool-registry.js";
import { createListSkillsTool } from "../tools/list-skills-tool.js";
import { createListToolsTool } from "../tools/list-tools-tool.js";
import { createUseSkillsTool } from "../tools/use-skills-tool.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { Session } from "./session.js";
import { TurnDriver } from "./turn-driver.js";
import type { AgentDefinition } from "./types.js";

const idGen = new SnowflakeId();

/**
 * `Agent` is a **definition** value: a named bundle of capabilities
 * (`tools`, `skills`, `systemPrompt`, `defaultModel`, sub-agents) that the
 * runtime can spin into one or more {@link Session}s.
 *
 * Agents are cheap to construct. Multiple {@link Session}s of the same
 * agent can run concurrently — each session has its own tree state.
 *
 * @example
 * ```ts
 * const analyst = runtime.createAgent({ name: "analyst", tools: [...] });
 * const session1 = analyst.createSession({ title: "Q1 review" });
 * const session2 = analyst.createSession({ title: "Q2 review" });
 * ```
 */
export class Agent {
  private readonly _definition: AgentDefinition;
  private readonly _runtime: AgentRuntime;
  private readonly _subAgents: Agent[] = [];
  private _selectionStrategy?: SelectionStrategy;

  /** @internal Use {@link AgentRuntime#createAgent} instead. */
  constructor(definition: AgentDefinition, runtime: AgentRuntime) {
    this._definition = { ...definition };
    this._runtime = runtime;
  }

  get name(): string {
    return this._definition.name;
  }

  /** Read-only definition. */
  get definition(): Readonly<AgentDefinition> {
    return this._definition;
  }

  /** @internal Sub-agents currently registered on this Agent. */
  get subAgents(): readonly Agent[] {
    return this._subAgents;
  }

  /** @internal Per-Agent override of the runtime-level selection strategy. */
  get selectionStrategy(): SelectionStrategy | undefined {
    return this._selectionStrategy;
  }

  /** @internal Runtime this Agent belongs to. */
  get runtime(): AgentRuntime {
    return this._runtime;
  }

  /**
   * Register a sub-agent. The sub-agent becomes available as a tool to
   * Sessions of this Agent — when called, the runtime constructs a child
   * Session of the sub-agent and streams its result back.
   */
  addSubAgent(child: Agent): this {
    this._subAgents.push(child);
    return this;
  }

  /** Per-Agent override of the runtime-level message selection strategy. */
  setSelectionStrategy(strategy: SelectionStrategy): this {
    this._selectionStrategy = strategy;
    return this;
  }

  /**
   * Spawn a new {@link Session} bound to this Agent. The session has an
   * empty state tree until it receives messages via `session.send(...)`
   * or its inbox.
   *
   * Pass `existingState` to adopt a previously-persisted state tree (this
   * is the path used by `AgentRuntime.loadSession`). Pass `sessionId` to
   * bind a specific id (otherwise a fresh one is generated).
   */
  createSession(opts?: {
    title?: string;
    sessionId?: string;
    existingState?: SessionState;
  }): Session {
    const runtime = this._runtime;
    const def = this._definition;
    const id = opts?.sessionId ?? idGen.generate();

    // 1. State tree (new or adopted).
    const state = buildState(id, opts?.title, opts?.existingState);

    // 2. Per-session inbox + tool/skill registries.
    const inbox = new Inbox();
    const tools = new ToolRegistry();
    const skills = new SkillsModel();

    // 3. Filter runtime tools by the Agent's declared tool names (or all).
    const allowedTools = def.tools;
    for (const [name, tool] of Object.entries(runtime.resolvedTools)) {
      if (!allowedTools || allowedTools.includes(name)) {
        tools.register(name, tool);
      }
    }

    // 4. Filter runtime skills by the Agent's declared skill names.
    //    Undefined `def.skills` means "all skills" (NOT "no skills").
    const allowedSkills = def.skills;
    for (const skill of runtime.resolvedSkills) {
      if (!allowedSkills || allowedSkills.includes(skill.name)) {
        skills.register(skill);
      }
    }

    // 5. Built-in tools: list_tools always, list_skills + use_skills when
    //    skills are available. Registered once at construction.
    const model = def.defaultModel ?? "";
    tools.register("list_tools", createListToolsTool(tools));
    if (skills.size > 0) {
      tools.register("list_skills", createListSkillsTool(skills));
      tools.register(
        "use_skills",
        createUseSkillsTool({ skills, provider: runtime.provider, model }),
      );
    }

    // 6. Sub-agents — TODO: runtime-native sub-agent invocation. Until
    //    consumers actually use sub-agents through the runtime API,
    //    registering one throws here.
    if (this._subAgents.length > 0) {
      throw new Error(
        `Sub-agents not supported yet on runtime API (agent "${def.name}" declared ${this._subAgents.length})`,
      );
    }

    // 7. MCP tools — sync into this session's tool registry.
    const mcp = runtime.mcp;
    const mcpUnsubscribe = mcp ? bridgeMcpTools(mcp, tools) : undefined;

    // 8. ContextWindow + TurnDriver from runtime defaults + agent overrides.
    const contextWindow = runtime.contextDefaults({
      ...(def.systemPrompt !== undefined && { systemPromptTemplate: def.systemPrompt }),
      ...(this._selectionStrategy !== undefined && { selectStrategy: this._selectionStrategy }),
    });
    const turnDriver = new TurnDriver({
      provider: runtime.provider,
      model,
      contextWindow,
      tools,
      skills,
      ...(def.maxSteps !== undefined && { maxSteps: def.maxSteps }),
      ...(def.maxOutputTokens !== undefined && { maxOutputTokens: def.maxOutputTokens }),
    });

    // 9. Wire the persistence + title-generation callbacks.
    const generateTitle = makeTitleGenerator(runtime, model);
    const save = (s: SessionState) => runtime.saveSession(id, s);

    return new Session({
      id,
      agent: this,
      state,
      inbox,
      tools,
      skills,
      turnDriver,
      generateTitle,
      save,
      ...(mcpUnsubscribe && { mcpUnsubscribe }),
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildState(
  id: string,
  title: string | undefined,
  existingState: SessionState | undefined,
): SessionState {
  if (existingState) {
    // Adopt the bound id so saves write back to the same location.
    existingState.data.id = id;
    return existingState;
  }
  const factory = createAgentNodeFactory();
  return factory<SessionState>({
    type: NodeType.session,
    id,
    props: title ? { title } : {},
  });
}

function makeTitleGenerator(
  runtime: AgentRuntime,
  model: string,
): (userText: string, signal?: AbortSignal) => Promise<string | undefined> {
  return async (userText, signal) => {
    try {
      const { text } = await generateText({
        model: runtime.provider.languageModel(model),
        system:
          "Generate a short title (max 6 words) for a conversation that starts with the following user message. Reply with the title only, no quotes or punctuation at the end.",
        messages: [{ role: "user", content: userText }],
        abortSignal: signal,
      });
      return text.trim();
    } catch {
      return undefined;
    }
  };
}
