import type { Agent, AgentRuntime } from "@statewalker/ai-agent/runtime";
import { BaseClass } from "@statewalker/shared-baseclass";

/**
 * Discriminated state machine consumed by the chat surface and any
 * other fragment that needs to know whether the agent is usable.
 * Read via `useAdapterValue(AgentRuntimeAdapter, a => a.getState())`.
 */
export type RuntimeState =
  | { status: "loading" }
  | { status: "no-providers" }
  | { status: "no-active-model" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      runtime: AgentRuntime;
      agent: Agent;
      activeProviderId: string;
      activeModelId: string;
    };

/**
 * Workspace-adapter projecting `ActiveModel` + the three `agent:*`
 * slots into a single `RuntimeState`. The internal manager mutates
 * this adapter and fires `notify()`; subscribers via
 * `BaseClass.onUpdate` (and the React `useAdapter` hook) re-render.
 *
 * Consumers MUST treat `getState()` as the source of truth — never
 * peek at the underlying `AgentRuntime` outside the `ready` branch.
 */
export class AgentRuntimeAdapter extends BaseClass {
  /** Type-only declaration so TS sees this class as compatible with
   * `WorkspaceAdapter`'s weak shape. */
  declare close?: () => void | Promise<void>;

  private _state: RuntimeState = { status: "loading" };

  getState(): RuntimeState {
    return this._state;
  }

  /**
   * Internal: replace the state. Reference-deduped so a no-op write
   * doesn't trigger a render storm. The manager owns this method;
   * external callers should fire `runRebuildAgent` instead.
   */
  _setState(next: RuntimeState): void {
    if (this._state === next) return;
    this._state = next;
    this.notify();
  }
}
