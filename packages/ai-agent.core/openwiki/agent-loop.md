# Agent Loop

How `Session.run()` drives the conversation: the `Executor` interface, the default `LoopExecutor`, the advanced `FsmExecutor`, and the per-turn `TurnDriver`.

## Executor interface

The pluggable agent loop. `Session.run()` delegates to the agent's `Executor`; the default is a shared, stateless `LoopExecutor`.

```ts
interface Executor {
  run(ctx: ExecutorContext, signal?: AbortSignal): AsyncGenerator<LogMessage>;
}

interface ExecutorContext {
  readonly inbox: Inbox;
  readonly state: SessionState;
  drive(message: InboxMessage, signal?: AbortSignal): AsyncGenerator<LogMessage>;
}
```

The `Executor` owns only the **across-turn** control flow. The per-turn lifecycle (open Turn, build context, `streamText`, route stream parts, close Turn) stays inside `TurnDriver`, reached via `ExecutorContext.drive()`.

`Session.run()` wraps the executor's stream with `withFirstTurnTitle` — on the first `turn-finish`, if `state.title` is unset, it generates a title from the first user message and sets it before re-emitting the event, so consumers persisting on `turn-finish` see `state.title` populated.

**Source**: `src/runtime/executor.ts` (`Executor`, `ExecutorContext`, `withFirstTurnTitle`), `src/runtime/session.ts` (`Session.run`).

## LoopExecutor (default)

The default agent loop. Drains the inbox and, per user message, drives an autonomous burst: it keeps re-driving (synthesizing a continuation from the worklist, no new user input) while work remains, and stops the burst on interrupt, completion, or the controller gate (budget / stagnation).

```
for each inbox message:
  for each turn in burst:
    drive(message)
    if inbox has new message → break (interrupt)
    if completionGate says done → break
    if controllerGate says halt → break (budget or stagnation)
    synthesize continuation from open worklist items
```

When the worklist is empty — the common chat case — the `completionGate` ends the burst after one turn, so behaviour matches a plain one-turn-per-message loop.

### Continuation synthesis

When the worklist has open items, the `LoopExecutor` synthesises a continuation message:

```
Continue working on the task. Remaining open items:
- {todo text 1}
- {todo text 2}
```

This message has `role: "system"` and is fed to `drive()` — the model sees the remaining work and continues.

### Stateless

`LoopExecutor` is stateless across sessions — all per-burst state lives in a local `RunState` created fresh for each inbox message. The default instance is shared across all agents that don't declare a custom executor.

**Source**: `src/runtime/loop-executor.ts`, `src/runtime/gates.ts`.

## FsmExecutor (advanced)

A formalised-process executor that interprets a provided, well-formed `@statewalker/fsm` process definition. At each prompt state it runs turns via `drive` until a per-state exit fires its event (which drives the FSM transition), forwarding `LogMessage`s to its output stream.

```ts
class FsmExecutor implements Executor {
  constructor(def: FsmProcessDefinition, maxTurns?: number);
  async *run(ctx: ExecutorContext, signal?: AbortSignal): AsyncGenerator<LogMessage>;
}
```

### Process definition

```ts
interface FsmProcessDefinition {
  config: FsmStateConfig;               // @statewalker/fsm state graph
  handlers: Record<string, StateHandlerConfig>;  // state key → behaviour
  startEvent?: string;                   // initial event (defaults to "")
}

interface StateHandlerConfig {
  prompt?: (ctx: FsmRunContext) => InboxMessage;  // message fed to drive() each turn
  conditions?: Condition[];                        // checked after each turn; first satisfied fires its event
  stagnation?: Check;                              // no-progress check → stagnationEvent
  stagnationEvent?: string;
  maxTurns?: number;                               // per-state turn budget → maxTurnsEvent
  maxTurnsEvent?: string;
  pre?: Condition;                                  // advisory goal check before the turn loop
  post?: Condition;                                 // advisory goal check after a condition fires
  terminal?: boolean;                               // entering this state ends the process
}
```

### State lifecycle

1. **Advisory pre-check** — if `pre.when` fails, emit its event (non-blocking, graph routes it).
2. **Turn loop**:
   - Build message from `prompt(ctx)`.
   - `drive(message, signal)` → forward all `LogMessage`s to output.
   - Check `conditions` — first satisfied fires its event.
   - If a condition fired: run advisory `post` check, then transition.
   - If no condition fired: check stagnation, check maxTurns.
3. **Exit** — the fired event drives the FSM transition to the next state.

### LogChannel

`FsmExecutor` uses a `LogChannel` — a single-consumer async queue that bridges the FSM engine's fire-and-forget state handlers (which push `LogMessage`s) to the executor's generator (which yields them). Closing it ends the stream; a close-with-error rethrows on the consumer side.

### No validation

`FsmExecutor` performs **NO validation** of the definition — that is the (deferred) planner's job. It assumes the `config` and `handlers` are well-formed.

**Source**: `src/runtime/fsm/fsm-executor.ts`, `src/runtime/fsm/process-config.ts`, `src/runtime/fsm/log-channel.ts`.

## TurnDriver

Advances a `SessionState` by exactly one Turn per `drive()` call. Owns the per-turn lifecycle.

```ts
class TurnDriver {
  constructor(options: TurnDriverOptions);
  async *drive(state: SessionState, message: InboxMessage, signal?: AbortSignal): AsyncGenerator<LogMessage>;
}
```

### Per-turn lifecycle

1. **Open Turn** — `state.addTurn()`, `state.startStreaming()`.
2. **Add user message** — `turn.addUserMessage(message.text)`.
3. **First-turn skill selection** — if `isFirstTurn && skills.available.length > 0`, run skill selection (model-backed, picks relevant skills for the prompt).
4. **Build context** — `contextWindow.build(state, { skills })` → `{ system, messages, events, stats }`. Forward events to log stream.
5. **Stream model call** — `streamText({ model, system, messages, tools, stopWhen: stepCountIs(maxSteps), abortSignal, maxOutputTokens? })`.
6. **Route stream parts** — `processStream(turn, result.fullStream)` routes each stream part to the appropriate tree node (text deltas → agent message, tool calls → tool call nodes, reasoning → thinking node, etc.).
7. **Close Turn** — record `finishReason`, `model`, `usage`, `stopReason` on the Turn. `state.stopStreaming(error?)`.
8. **Emit `turn-finish`** — with classified `TurnFinishKind`.

### Finish classification

`TurnFinishKind` is derived from the AI SDK `finishReason`:

| Kind | Meaning |
|---|---|
| `ok` | Natural stop. |
| `step-limit` | `finishReason "tool-calls"` after step budget exhausted. |
| `length` | Max tokens or context window reached. |
| `filtered` | Content filter / safety. |
| `error` | Caught exception during streaming. |
| `empty` | Stream finished with no text, tool call, or error. |
| `aborted` | Abort signal fired. |
| `unknown` | Unrecognized `finishReason`. |

### Max steps

`maxSteps` (default: 10) caps inner tool-call iterations per turn via `stopWhen: stepCountIs(maxSteps)`. This is distinct from the `LoopExecutor`'s `maxTurns` cap on autonomous continuations.

**Source**: `src/runtime/turn-driver.ts`, `src/state/log-message.ts` (`TurnFinishKind`, `LogMessage`).

## Gates

Two gate functions control the `LoopExecutor`'s burst behavior:

### Completion gate

```ts
function completionGate(state: SessionState): "done" | "continue";
```

Returns `"done"` when no worklist item is still open (i.e., `openTodos(state.worklist).length === 0`). Returns `"continue"` otherwise.

### Controller gate

```ts
function controllerGate(state: SessionState, run: RunState, maxTurns: number): "continue" | "halt";
```

Halts the burst on:
- **Budget** — `run.turns >= maxTurns`.
- **Stagnation** — the latest turn's signature equals the previous turn's signature (no progress).

`turnSignature(turn)` produces a stable signature of a turn's delta: its plain text plus each tool call's name, arguments, and result. Two equal signatures = no progress.

### RunState

Transient per-burst state — created for each user message and reset when the next one is taken, so budget and stagnation never carry across an autonomous burst boundary.

```ts
interface RunState {
  turns: number;              // turns driven so far in this burst
  prevSignature?: string;     // previous turn's signature, for stagnation detection
}
```

`DEFAULT_MAX_TURNS` = 25.

**Source**: `src/runtime/gates.ts`.

## LogMessage stream

All executors and the `TurnDriver` yield `LogMessage` events:

```ts
type LogMessage =
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "reasoning"; turnId: string; text: string }
  | { type: "tool-call"; turnId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; turnId: string; toolCallId: string; toolName: string; result: unknown }
  | { type: "tool-error"; turnId: string; toolCallId: string; toolName: string; message: string }
  | { type: "step-finish"; turnId: string; finishReason: string }
  | { type: "turn-finish"; turnId: string; finishReason: string; kind: TurnFinishKind }
  | { type: "error"; turnId: string; message: string }
  | { type: "context-thrash"; turnId: string; stamp: string; budget: number; estimated: number };
```

Consumers iterate this stream via `for await (const log of session.run()) { ... }`.

**Source**: `src/state/log-message.ts`.
