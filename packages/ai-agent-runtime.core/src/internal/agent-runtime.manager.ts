import { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import { Slots } from "@statewalker/shared-slots";
import type { Workspace } from "@statewalker/workspace.core";
import { ActiveModel } from "../public/active-model.js";
import { RebuildAgentCommand } from "../public/commands.js";
import {
  agentMcpConnectionsSlot,
  agentSkillsSlot,
  agentSystemPromptSlot,
  agentToolsSlot,
} from "../public/extension-points.js";
import { AgentRuntimeAdapter, type RuntimeState } from "../public/runtime-state.js";
import type {
  AgentMcpConnection,
  AgentSkillContribution,
  AgentToolContribution,
} from "../public/types.js";
import { type BuildRuntimeInput, buildRuntime } from "./build-runtime.js";

const AGENT_NAME = "chat";
const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant with access to tools for interacting with the local file system.

Use tools when their descriptions match the current goal. Provide concise, actionable answers.`;
const REBUILD_DEBOUNCE_MS = 25;

export interface AgentRuntimeManagerOptions {
  workspace: Workspace;
  systemFolder?: string;
  /**
   * Override the runtime builder. Tests inject a stub that doesn't
   * touch the real `AgentRuntime` (which would try to load skills /
   * MCP / providers). Defaults to the real `buildRuntime`.
   */
  buildRuntime?: (
    input: BuildRuntimeInput,
  ) => Promise<import("@statewalker/ai-agent.core/runtime").AgentRuntime>;
}

/**
 * Re-entrant orchestrator. On each `workspace.onLoad`:
 *   1. Subscribes to `agent:tools`, `agent:skills`,
 *      `agent:mcp-connections` via slot `observe`s, and to
 *      `ActiveModel.onUpdate`.
 *   2. Each notification schedules a debounced rebuild.
 *   3. Rebuild reads the current snapshots, calls `buildRuntime`,
 *      replaces the runtime in `AgentRuntimeAdapter`, fires
 *      `notify()` so consumers re-render.
 *
 * On `workspace.onUnload`: drops the runtime, resets the adapter to
 * `{ status: "loading" }`, releases the per-cycle subscriptions.
 *
 * `handleRebuildAgent` is registered for the manager's lifetime
 * (not per cycle) so callers can fire `runRebuildAgent` even while
 * the workspace is closed — the rebuild simply no-ops in that
 * window because there is no `files` to feed `buildRuntime`.
 */
export class AgentRuntimeManager {
  private readonly workspace: Workspace;
  private readonly commands: Commands;
  private readonly slots: Slots;
  private readonly activeModel: ActiveModel;
  private readonly adapter: AgentRuntimeAdapter;
  private readonly systemFolder: string;
  private readonly _buildRuntime: NonNullable<AgentRuntimeManagerOptions["buildRuntime"]>;

  private readonly _cleanup: () => Promise<void>;
  private readonly _register: (
    callback?: (() => void | Promise<void>) | undefined,
  ) => () => Promise<void>;
  // Per-cycle state — populated on onLoad, cleared on onUnload.
  private _toolsSnap: readonly AgentToolContribution[] = [];
  private _skillsSnap: readonly AgentSkillContribution[] = [];
  private _mcpSnap: readonly AgentMcpConnection[] = [];
  private _promptSnap: readonly string[] = [];

  private _cycleCleanup: () => Promise<void> = async () => {};

  private _isLoaded = false;
  private _generation = 0;
  private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AgentRuntimeManagerOptions) {
    this.workspace = opts.workspace;
    this.systemFolder = opts.systemFolder ?? "/.settings";
    this._buildRuntime = opts.buildRuntime ?? buildRuntime;
    this.commands = opts.workspace.requireAdapter(Commands);
    this.slots = opts.workspace.requireAdapter(Slots);
    this.activeModel = opts.workspace.requireAdapter(ActiveModel);
    this.adapter = opts.workspace.requireAdapter(AgentRuntimeAdapter);

    [this._register, this._cleanup] = newRegistry();
    const register = this._register;

    // Lifetime-scoped command handler. Survives onUnload cycles so
    // late-arriving `runRebuildAgent` calls just no-op while closed.
    register(
      this.commands.listen(RebuildAgentCommand, (cmd) => {
        this._scheduleRebuild();
        cmd.resolve();
        return true;
      }),
    );

    // Per-workspace-cycle subscriptions.
    register(this.workspace.onLoad(() => this._onLoad()));
    register(this.workspace.onUnload(() => this._onUnload()));

    // If the workspace is already open at construction time, fire
    // onLoad now so the manager doesn't sit in `loading` forever.
    if (this.workspace.isOpened) this._onLoad();
  }

  /** Imperative trigger; same effect as `runRebuildAgent`. */
  rebuild(): void {
    this._scheduleRebuild();
  }

  async close(): Promise<void> {
    if (this._isLoaded) await this._onUnload();
    await this._cleanup();
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  private _onLoad(): void {
    if (this._isLoaded) return;
    this._isLoaded = true;
    this._generation += 1;
    const [register, cleanup] = newRegistry();
    this._cycleCleanup = this._register(cleanup);
    register(
      this.slots.observe(agentToolsSlot, (vs) => {
        this._toolsSnap = vs;
        this._scheduleRebuild();
      }),
    );
    register(
      this.slots.observe(agentSkillsSlot, (vs) => {
        this._skillsSnap = vs;
        this._scheduleRebuild();
      }),
    );
    register(
      this.slots.observe(agentMcpConnectionsSlot, (vs) => {
        this._mcpSnap = vs;
        this._scheduleRebuild();
      }),
    );
    register(
      this.slots.observe(agentSystemPromptSlot, (vs) => {
        this._promptSnap = vs;
        this._scheduleRebuild();
      }),
    );
    register(this.activeModel.onUpdate(() => this._scheduleRebuild()));

    // Initial state: `loading` until the first rebuild settles.
    this.adapter._setState({ status: "loading" });
    this._scheduleRebuild();
  }

  private async _onUnload(): Promise<void> {
    if (!this._isLoaded) return;
    this._isLoaded = false;
    this._generation += 1; // invalidate any in-flight rebuild
    if (this._rebuildTimer !== null) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = null;
    }
    await this._cycleCleanup();
    this._toolsSnap = [];
    this._skillsSnap = [];
    this._mcpSnap = [];
    this._promptSnap = [];
    this.adapter._setState({ status: "loading" });
  }

  // ── Rebuild loop ──────────────────────────────────────────────

  private _scheduleRebuild(): void {
    if (!this._isLoaded) return;
    if (this._rebuildTimer !== null) return;
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      void this._runRebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  private async _runRebuild(): Promise<void> {
    if (!this._isLoaded) return;
    const generation = this._generation;
    const active = this.activeModel.get();
    if (!active?.modelId) {
      // No usable selection yet. Never build an agent with an empty model id —
      // that would mark the runtime `ready` and let a session be created whose
      // turns request the model `""` ("model '' does not exist"). The
      // "no-providers" vs "no-active-model" distinction is owned by the
      // providers/ai-config fragments; here we just refuse to build.
      return;
    }

    try {
      const mcpServers = dedupeMcp(this._mcpSnap);
      const runtime = await this._buildRuntime({
        files: this.workspace.files,
        systemFolder: this.systemFolder,
        provider: active.createProvider(),
        tools: this._toolsSnap,
        skills: this._skillsSnap,
        mcpServers,
      });
      if (this._generation !== generation) {
        // Cycle changed under us; discard.
        return;
      }
      // Fragment-contributed steering blocks are appended to the base prompt; the
      // session's ContextWindow appends the skills section after this template.
      const systemPrompt = [DEFAULT_SYSTEM_PROMPT, ...this._promptSnap]
        .filter((b) => b.trim().length > 0)
        .join("\n\n");
      const agent = runtime.createAgent({
        name: AGENT_NAME,
        systemPrompt,
        defaultModel: active.modelId,
      });
      this._publish(generation, {
        status: "ready",
        runtime,
        agent,
        activeProviderId: active.providerId,
        activeModelId: active.modelId,
      });
    } catch (error) {
      this._publish(generation, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private _publish(generation: number, state: RuntimeState): void {
    if (this._generation !== generation) return;
    this.adapter._setState(state);
  }
}

function dedupeMcp(
  contributions: readonly AgentMcpConnection[],
): Record<string, import("@statewalker/ai-agent.core/runtime").McpServerConfig> {
  const out: Record<string, import("@statewalker/ai-agent.core/runtime").McpServerConfig> = {};
  for (const c of contributions) out[c.id] = c.config; // last-wins
  return out;
}
