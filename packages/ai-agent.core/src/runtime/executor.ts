import type { Inbox, InboxMessage } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
import type { SessionState } from "../state/session-state.js";

/**
 * The per-session inputs an {@link Executor} needs, without leaking any FSM
 * concepts (states / transitions / events). `drive` is the turn primitive
 * bound to the session's `TurnDriver` and `SessionState` — the irreducible
 * "run one LLM exchange" unit that both executors build their loop from.
 */
export interface ExecutorContext {
  readonly inbox: Inbox;
  readonly state: SessionState;
  /** Advance the session by exactly one Turn for `message`. */
  drive(message: InboxMessage, signal?: AbortSignal): AsyncGenerator<LogMessage>;
}

/**
 * The pluggable agent loop. `Session.run()` delegates to the agent's
 * `Executor`; the default is {@link import("./loop-executor.js").LoopExecutor}.
 * Implementations own only the across-turn control flow — the per-turn
 * lifecycle stays inside `TurnDriver` (reached via {@link ExecutorContext.drive}).
 */
export interface Executor {
  run(ctx: ExecutorContext, signal?: AbortSignal): AsyncGenerator<LogMessage>;
}

/**
 * Executor-agnostic first-turn title generation. Wraps an executor's stream:
 * on the **first** `turn-finish`, if `state.title` is unset, generate a title
 * from the first user message (read from `state`, since the LogMessage stream
 * does not carry it), set it, then re-emit the buffered `turn-finish` — so a
 * consumer persisting on `turn-finish` observes `state.title` populated. All
 * later events pass through untouched.
 */
export async function* withFirstTurnTitle(
  stream: AsyncGenerator<LogMessage>,
  state: SessionState,
  generateTitle: (userText: string, signal?: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal,
): AsyncGenerator<LogMessage> {
  let handledFirst = false;
  for await (const ev of stream) {
    if (!handledFirst && ev.type === "turn-finish") {
      handledFirst = true;
      if (!state.title) {
        const userText = state.turns[0]?.userText;
        if (userText) {
          try {
            state.title = await generateTitle(userText, signal);
          } catch {
            // Title generation is best-effort — do not propagate errors.
          }
        }
      }
    }
    yield ev;
  }
}
