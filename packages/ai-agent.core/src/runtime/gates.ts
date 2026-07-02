import type { SessionState } from "../state/session-state.js";
import type { Turn } from "../state/turn.js";
import { openTodos } from "../state/worklist.js";

/** Conservative default cap on autonomous continuations within one burst. */
export const DEFAULT_MAX_TURNS = 25;

/**
 * Transient per-burst loop state — created for each user message and reset
 * when the next one is taken, so budget and stagnation never carry across an
 * autonomous burst boundary.
 */
export interface RunState {
  /** Turns driven so far in this burst. */
  turns: number;
  /** Signature of the previous turn, for stagnation detection. */
  prevSignature?: string;
}

export function newRunState(): RunState {
  return { turns: 0 };
}

/** Completion gate — done when no worklist item is still open. */
export function completionGate(state: SessionState): "done" | "continue" {
  return openTodos(state.worklist).length === 0 ? "done" : "continue";
}

/**
 * Controller gate — halt the burst on budget (turns reached `maxTurns`) or on
 * stagnation (the latest turn produced the same delta as the previous one).
 * Mutates `run.prevSignature` for the next comparison.
 */
export function controllerGate(
  state: SessionState,
  run: RunState,
  maxTurns: number,
): "continue" | "halt" {
  if (run.turns >= maxTurns) return "halt";
  const sig = turnSignature(state.currentTurn);
  if (sig !== undefined && sig === run.prevSignature) return "halt";
  run.prevSignature = sig;
  return "continue";
}

/** A stable signature of a turn's delta: its plain text plus each tool call's
 * name, arguments, and result. Two equal signatures = no progress. */
export function turnSignature(turn: Turn | undefined): string | undefined {
  if (!turn) return undefined;
  const parts: string[] = [turn.toPlainText()];
  for (const tc of turn.toolCalls) {
    parts.push(tc.toolName ?? "");
    parts.push(JSON.stringify(tc.args ?? null));
    if (tc.result !== undefined) parts.push(tc.result);
  }
  return parts.join("");
}
