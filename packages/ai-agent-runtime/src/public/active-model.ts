import { BaseClass } from "@statewalker/shared-baseclass";
import type { ActiveModelValue } from "./types.js";

/**
 * Workspace-adapter holding the resolved active provider+model
 * pointer. Writers (the providers fragment from Wave 4.2; an interim
 * bootstrap inside agent-runtime until then) call `set(value)` to
 * publish a selection; the agent-runtime manager observes the
 * pointer and rebuilds the `AgentRuntime` whenever it changes.
 *
 * Reactive: `notify()` fires on every `set` / `clear`, so subscribers
 * via `BaseClass.onUpdate` (and indirectly the React `useAdapter`
 * hook) see the change.
 */
export class ActiveModel extends BaseClass {
  /** Type-only declaration so TS sees this class as compatible with
   * `WorkspaceAdapter`'s weak shape (matches the trick `Slots` uses). */
  declare close?: () => void | Promise<void>;

  private _value: ActiveModelValue | null = null;

  /** Current pointer or `null` when no model has been selected. */
  get(): ActiveModelValue | null {
    return this._value;
  }

  /** Replace the pointer. No-op when the new value is reference-equal. */
  set(value: ActiveModelValue | null): void {
    if (this._value === value) return;
    this._value = value;
    this.notify();
  }

  /** Convenience for `set(null)`. */
  clear(): void {
    this.set(null);
  }
}
