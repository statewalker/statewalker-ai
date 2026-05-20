import { BaseClass } from "@statewalker/shared-baseclass";
import type { ActiveModelValue } from "./types.js";

/**
 * Workspace-adapter holding the resolved active provider+model
 * pointer.
 *
 * **Semantic shift (post-v5 / ADR 0011): "last-selected hint", not
 * the gate.** The chat composer now writes a per-session `modelRef`
 * on every selection AND mirrors the choice into `ActiveModel`. New
 * sessions inherit `ActiveModel` as their initial `modelRef`; the
 * adapter remains the workspace-singular pointer that determines
 * which provider the agent runtime builds against, but the user-facing
 * selection is per-session. See CONTEXT.md "Models and connections"
 * for the full contract.
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
