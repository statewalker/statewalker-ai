import type { InboxMessage } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
import type { SessionState } from "../state/session-state.js";
import { openTodos } from "../state/worklist.js";
import type { Executor, ExecutorContext } from "./executor.js";
import { completionGate, controllerGate, DEFAULT_MAX_TURNS, newRunState } from "./gates.js";

/**
 * The default agent loop. Drains the inbox and, per user message, drives an
 * autonomous burst: it keeps re-driving (synthesizing a continuation from the
 * worklist, no new user input) while work remains, and stops the burst on
 * interrupt, completion, or the controller gate (budget / stagnation).
 *
 * When the worklist is empty — the common chat case — the completion gate ends
 * the burst after one turn, so behaviour matches a plain one-turn-per-message
 * loop. First-turn title generation is applied by
 * {@link import("./executor.js").withFirstTurnTitle} around this executor.
 *
 * Stateless across sessions — all per-burst state lives in a local `RunState`.
 */
export class LoopExecutor implements Executor {
  constructor(private readonly maxTurns: number = DEFAULT_MAX_TURNS) {}

  async *run(ctx: ExecutorContext, signal?: AbortSignal): AsyncGenerator<LogMessage> {
    for (;;) {
      const message = await ctx.inbox.take(signal);
      if (!message) break;

      const run = newRunState();
      let next: InboxMessage = message;
      for (;;) {
        yield* ctx.drive(next, signal);
        run.turns++;
        if (ctx.inbox.pending > 0) break; // interrupt: a new message is waiting
        if (completionGate(ctx.state) === "done") break;
        if (controllerGate(ctx.state, run, this.maxTurns) === "halt") break;
        next = synthesizeContinuation(ctx.state);
      }
    }
  }
}

/** Build a continuation message from the remaining open worklist items. */
function synthesizeContinuation(state: SessionState): InboxMessage {
  const lines = openTodos(state.worklist)
    .map((t) => `- ${t.text}`)
    .join("\n");
  return {
    role: "system",
    text: `Continue working on the task. Remaining open items:\n${lines}`,
  };
}
