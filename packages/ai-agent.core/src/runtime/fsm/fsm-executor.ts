import type { StageHandler } from "@statewalker/fsm";
import { startProcess } from "@statewalker/fsm";
import type { LogMessage } from "../../state/log-message.js";
import type { Executor, ExecutorContext } from "../executor.js";
import { DEFAULT_MAX_TURNS, newRunState } from "../gates.js";
import { LogChannel } from "./log-channel.js";
import type { FsmProcessDefinition, FsmRunContext, StateHandlerConfig } from "./process-config.js";

/**
 * The advanced, formalized-process executor — separate logic from
 * {@link import("../loop-executor.js").LoopExecutor}. It interprets a *provided,
 * well-formed* `@statewalker/fsm` process definition: at each prompt state it
 * runs turns via `drive` until a per-state exit fires its event (which drives
 * the FSM transition), forwarding LogMessages to its output stream. It performs
 * NO validation of the definition — that is the (deferred) planner's job.
 *
 * Exit reasons per state: explicit-event, condition-met, stagnation, or
 * max-turns; the last two map to events the graph routes. Advisory pre/post
 * checks emit graph-routable events without blocking a transition.
 */
export class FsmExecutor implements Executor {
  constructor(
    private readonly def: FsmProcessDefinition,
    private readonly maxTurns: number = DEFAULT_MAX_TURNS,
  ) {}

  async *run(ctx: ExecutorContext, signal?: AbortSignal): AsyncGenerator<LogMessage> {
    const channel = new LogChannel();
    const runCtx: FsmRunContext = {
      state: ctx.state,
      drive: ctx.drive,
      emit: (log) => channel.push(log),
      signal,
    };

    const onAbort = () => channel.close();
    signal?.addEventListener("abort", onAbort, { once: true });

    const load = (stateKey: string) => this.#handlersFor(stateKey, channel);
    // startProcess is fire-and-forget: it kicks off the graph and returns. The
    // process runs by dispatching the events our handlers yield; a terminal
    // state closes the channel, ending the stream below.
    startProcess<FsmRunContext>(runCtx, this.def.config, load, this.def.startEvent ?? "").catch(
      (err) => channel.close(err),
    );

    try {
      yield* channel.stream();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Build the `@statewalker/fsm` StageHandler(s) for a state key. */
  #handlersFor(stateKey: string, channel: LogChannel): StageHandler<FsmRunContext>[] {
    const cfg = this.def.handlers[stateKey];
    if (!cfg) return []; // compound/initial/unknown keys have no behaviour
    if (cfg.terminal) {
      // Entering a terminal state ends the run: close the channel (a side effect
      // of invocation — no event to dispatch).
      return [() => channel.close()];
    }
    const executorMaxTurns = this.maxTurns;
    return [
      async function* stateHandler(c: FsmRunContext): AsyncGenerator<string> {
        yield* runState(c, cfg, executorMaxTurns, stateKey);
      },
    ];
  }
}

/** Drive one prompt state: pre-check → turn loop → exit event. */
async function* runState(
  c: FsmRunContext,
  cfg: StateHandlerConfig,
  executorMaxTurns: number,
  stateKey: string,
): AsyncGenerator<string> {
  // Advisory pre-check: annotate the trace with its verdict, and on failure emit
  // its event for the graph to route — but never block.
  if (cfg.pre) {
    const passed = await cfg.pre.when(c);
    c.emit({
      type: "advisory-check",
      stateKey,
      phase: "pre",
      passed,
      ...(passed ? {} : { event: cfg.pre.event }),
    });
    if (!passed) yield cfg.pre.event;
  }

  const maxTurns = cfg.maxTurns ?? executorMaxTurns;
  const run = newRunState();
  for (;;) {
    const message = cfg.prompt ? cfg.prompt(c) : { role: "system" as const, text: "" };
    for await (const log of c.drive(message, c.signal)) c.emit(log);
    run.turns++;

    let fired: string | undefined;
    for (const cond of cfg.conditions ?? []) {
      if (await cond.when(c)) {
        fired = cond.event;
        break;
      }
    }
    if (fired) {
      // Advisory post-check: annotate the trace, emit its event on failure
      // (non-blocking), then transition.
      if (cfg.post) {
        const passed = await cfg.post.when(c);
        c.emit({
          type: "advisory-check",
          stateKey,
          phase: "post",
          passed,
          ...(passed ? {} : { event: cfg.post.event }),
        });
        if (!passed) yield cfg.post.event;
      }
      yield fired;
      return;
    }

    if (cfg.stagnation && cfg.stagnationEvent && (await cfg.stagnation(c))) {
      yield cfg.stagnationEvent;
      return;
    }

    if (run.turns >= maxTurns) {
      if (cfg.maxTurnsEvent) yield cfg.maxTurnsEvent;
      return; // safety: never loop past the budget even if no event is configured
    }
  }
}
