import type { FsmStateConfig } from "@statewalker/fsm";
import type { InboxMessage } from "../../state/inbox.js";
import type { LogMessage } from "../../state/log-message.js";
import type { SessionState } from "../../state/session-state.js";

/**
 * What a state handler sees while the {@link import("./fsm-executor.js").FsmExecutor}
 * runs it: the session state, the bound turn primitive, and `emit` to forward
 * a LogMessage to the executor's output stream.
 */
export interface FsmRunContext {
  readonly state: SessionState;
  drive(message: InboxMessage, signal?: AbortSignal): AsyncGenerator<LogMessage>;
  emit(log: LogMessage): void;
  readonly signal?: AbortSignal;
}

/**
 * A condition check. Deterministic when it reads only the context; model-backed
 * when its body awaits the model. The executor treats both uniformly.
 */
export type Check = (ctx: FsmRunContext) => boolean | Promise<boolean>;

/** A check paired with the event it fires when satisfied. */
export interface Condition {
  when: Check;
  event: string;
}

/**
 * Per-state behaviour. A prompt state runs turns until an exit fires its event;
 * a terminal state ends the process. Conditions/stagnation/pre/post are all
 * {@link Check}s (deterministic or model-backed).
 */
export interface StateHandlerConfig {
  /** Message fed to `drive()` each turn. Omitted for terminal states. */
  prompt?: (ctx: FsmRunContext) => InboxMessage;
  /** Checked after each turn; the first satisfied one fires its event. */
  conditions?: Condition[];
  /** No-progress check → `stagnationEvent`. */
  stagnation?: Check;
  stagnationEvent?: string;
  /** Per-state turn budget → `maxTurnsEvent`. Falls back to the executor default. */
  maxTurns?: number;
  maxTurnsEvent?: string;
  /** Advisory goal check before the turn loop; failure emits its event (non-blocking). */
  pre?: Condition;
  /** Advisory goal check after a condition fires; failure emits its event (non-blocking). */
  post?: Condition;
  /** A terminal state: no turns; entering it ends the process. */
  terminal?: boolean;
}

/**
 * A well-formed process definition handed to `FsmExecutor`. `config` is the
 * `@statewalker/fsm` state graph; `handlers` maps each state key to its
 * behaviour. The executor does no validation of either.
 */
export interface FsmProcessDefinition {
  config: FsmStateConfig;
  handlers: Record<string, StateHandlerConfig>;
  /** Initial event dispatched to enter the graph. Defaults to "". */
  startEvent?: string;
}
