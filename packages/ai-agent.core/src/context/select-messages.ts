import type { ModelMessage } from "ai";
import type { SessionState } from "../state/session-state.js";

/**
 * Builds a ModelMessage[] prompt from the session tree.
 */
export type SelectionStrategy = (session: SessionState) => Promise<ModelMessage[]>;

// ---------------------------------------------------------------------------
// Default strategy: all turns, newest last
// ---------------------------------------------------------------------------

export async function selectAll(session: SessionState): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  for (const turn of session.turns) {
    result.push(...turn.toModelMessages());
  }
  return result;
}
