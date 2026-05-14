import type { ProviderV3 } from "@ai-sdk/provider";
import type { FilesApi } from "@statewalker/webrun-files";
import type { ToolSet } from "ai";
import type { AgentContext } from "../config/types.js";
import type { HierarchicalSummarizer } from "../context/hierarchical-summarizer.js";
import type { PinPolicy } from "../context/pin-policy.js";
import type { SelectionStrategy } from "../context/select-messages.js";
import type { TokenEstimator } from "../context/token-estimator.js";
import type { ToolElisionPolicy } from "../context/tool-elision.js";
import type { SkillInfo } from "../skills/skill-types.js";

/** Per-call options for the hierarchical context compactor. */
export interface BudgetCompactionOptions {
  budgetTokens: number;
  summarizer: HierarchicalSummarizer;
  keepRecentTurns?: number;
  groupSize?: number;
  depthPromoteThreshold?: number;
  maxPassesPerCompact?: number;
  estimator?: TokenEstimator;
  pinPolicy?: PinPolicy;
  elisionPolicy?: ToolElisionPolicy;
}

/** Factory invoked at `build()` to materialise tools from the live context. */
export type ToolFactory = (ctx: AgentContext) => ToolSet | Promise<ToolSet>;

/**
 * Optional context for a routed runtime error.
 * - `path`  — set when the error originates in the FilesApi composition layer
 *             (e.g. a tool tried to write into the system path-tree).
 * - `server` — set when the error comes from an MCP server interaction.
 */
export interface AgentRuntimeErrorContext {
  path?: string;
  server?: string;
}

/**
 * Error handler signature shared across the runtime's error sites
 * (build-phase config errors, FilteredFilesApi violations, MCP failures).
 * Default handler is `console.warn`.
 */
export type AgentRuntimeErrorHandler = (error: Error, ctx?: AgentRuntimeErrorContext) => void;

/** Construction options for {@link AgentRuntime}. */
export interface AgentRuntimeOptions {
  /** Root `FilesApi` the runtime builds its system / tools views over. */
  files: FilesApi;
  /** Optional initial error handler. Defaults to `console.warn`. */
  errorHandler?: AgentRuntimeErrorHandler;
}

/**
 * Provider supplied via {@link AgentRuntime#addModelProvider}.
 * Callers holding a `ModelManager` pass `modelManager.provider`.
 */
export type ModelProviderInput = ProviderV3;

/** Tool input accepted by {@link AgentRuntime#addTools}. */
export type ToolInput = ToolSet | ToolFactory;

/** Bundle of context settings carried alongside per-Agent overrides. */
export interface AgentRuntimeBuildOptions {
  selectionStrategy?: SelectionStrategy;
  budgetCompaction?: BudgetCompactionOptions;
}

/** Static-ish definition of an Agent — name + capability bundle. */
export interface AgentDefinition {
  /** Stable name; must be unique within the runtime. */
  name: string;
  /**
   * Tool names visible to this agent. Empty / undefined → all tools
   * registered on the runtime (and any sub-agents declared via
   * {@link Agent#addSubAgent}).
   */
  tools?: string[];
  /**
   * Skill names available to this agent. Empty / undefined → none.
   * (The `use_skills` built-in tool is registered on the session only
   * when the Agent's skill set is non-empty.)
   */
  skills?: string[];
  /** Per-agent system prompt; falls back to the controller default. */
  systemPrompt?: string;
  /** Default model id to bind the session to. */
  defaultModel?: string;
  /** Cap on inner tool-call iterations per turn. */
  maxSteps?: number;
  /** Cap on per-step output tokens. */
  maxOutputTokens?: number;
}

/** Skill registry types re-exported for convenience. */
export type { SkillInfo };
