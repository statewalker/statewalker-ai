import { validate } from "@statewalker/fsm-validator";
import { describe, expect, it } from "vitest";
import type { ExecutorContext } from "../../../src/runtime/executor.js";
import { FsmExecutor } from "../../../src/runtime/fsm/fsm-executor.js";
import type {
  Check,
  Condition,
  FsmProcessDefinition,
} from "../../../src/runtime/fsm/process-config.js";
import { Inbox, type InboxMessage } from "../../../src/state/inbox.js";
import type { LogMessage } from "../../../src/state/log-message.js";
import { createAgentNodeFactory } from "../../../src/state/node-factory.js";
import { NodeType } from "../../../src/state/node-types.js";
import type { SessionState } from "../../../src/state/session-state.js";
import { openTodos } from "../../../src/state/worklist.js";

function newState(): SessionState {
  const factory = createAgentNodeFactory();
  return factory<SessionState>({ type: NodeType.session, id: "s1", props: {} });
}

/** Scripted drive: records the driven message text, mutates state per `onTurn`. */
function scriptedDrive(
  state: SessionState,
  calls: string[],
  onTurn?: (msg: InboxMessage, state: SessionState) => void,
) {
  return async function* drive(message: InboxMessage): AsyncGenerator<LogMessage> {
    calls.push(message.text);
    const turn = state.addTurn();
    turn.addUserMessage(message.text);
    onTurn?.(message, state);
    yield { type: "turn-finish", turnId: turn.id, finishReason: "stop", kind: "ok" };
  };
}

interface ProcOpts {
  workConditions?: Condition[];
  workMaxTurns?: number;
  workMaxTurnsEvent?: string;
  workStagnation?: Check;
  workStagnationEvent?: string;
  workPost?: Condition;
}

/** A three-state process: Work → (complete → Done | budget/stuck/replan → Alt),
 * Alt → complete → Done, Done terminal. `visited` records each turn's state. */
function buildProc(opts: ProcOpts, visited: string[]): FsmProcessDefinition {
  return {
    config: {
      key: "Proc",
      description: "Test process for the FsmExecutor.",
      transitions: [
        ["", "*", "Work"],
        ["Work", "complete", "Done"],
        ["Work", "budget", "Alt"],
        ["Work", "stuck", "Alt"],
        ["Work", "replan", "Alt"],
        ["Alt", "complete", "Done"],
        ["Done", "done", ""],
      ],
      states: [
        {
          key: "Work",
          description: "Primary work state.",
          events: {
            complete: "Work is done.",
            budget: "Turn budget exhausted.",
            stuck: "No progress.",
            replan: "Post-check wants a replan.",
          },
        },
        { key: "Alt", description: "Alternative path.", events: { complete: "Alt is done." } },
        { key: "Done", description: "Terminal state.", events: { done: "Finished." } },
      ],
    },
    handlers: {
      Work: {
        prompt: () => {
          visited.push("Work");
          return { role: "system", text: "WORK" };
        },
        conditions: opts.workConditions ?? [
          { when: (c) => openTodos(c.state.worklist).length === 0, event: "complete" },
        ],
        maxTurns: opts.workMaxTurns ?? 25,
        ...(opts.workMaxTurnsEvent && { maxTurnsEvent: opts.workMaxTurnsEvent }),
        ...(opts.workStagnation && { stagnation: opts.workStagnation }),
        ...(opts.workStagnationEvent && { stagnationEvent: opts.workStagnationEvent }),
        ...(opts.workPost && { post: opts.workPost }),
      },
      Alt: {
        prompt: () => {
          visited.push("Alt");
          return { role: "system", text: "ALT" };
        },
        // async (model-backed style) check — always resolves true.
        conditions: [{ when: async () => true, event: "complete" }],
        maxTurns: 3,
        maxTurnsEvent: "complete",
      },
      Done: { terminal: true },
    },
  };
}

function makeCtx(
  state: SessionState,
  calls: string[],
  onTurn?: Parameters<typeof scriptedDrive>[2],
): ExecutorContext {
  return { inbox: new Inbox(), state, drive: scriptedDrive(state, calls, onTurn) };
}

async function drain(gen: AsyncGenerator<LogMessage>): Promise<LogMessage[]> {
  const out: LogMessage[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const openA = [{ id: "a", status: "open" as const, text: "a" }];
const doneA = [{ id: "a", status: "done" as const, text: "a" }];

describe("FsmExecutor — config validation", () => {
  it("the sample process passes @statewalker/fsm-validator with no errors", () => {
    const def = buildProc({}, []);
    const result = validate(def.config as unknown as Parameters<typeof validate>[0]);
    const fmt = (xs: typeof result.errors) =>
      xs.map((i) => `[${i.rule}] ${i.path.join(">")}: ${i.message}`).join("\n");
    expect(fmt(result.errors), "errors").toBe("");
    expect(result.valid).toBe(true);
  });
});

describe("FsmExecutor — execution", () => {
  it("a satisfied condition fires its event and drives the transition to a terminal state", async () => {
    const state = newState();
    state.worklist = openA;
    const calls: string[] = [];
    const visited: string[] = [];
    const ctx = makeCtx(state, calls, (msg, s) => {
      if (msg.text === "WORK") s.worklist = doneA; // Work completes on its first turn
    });

    await drain(new FsmExecutor(buildProc({}, visited)).run(ctx));

    expect(calls).toEqual(["WORK"]);
    expect(visited).toEqual(["Work"]);
  });

  it("max-turns routes to an alternative path, whose async check completes", async () => {
    const state = newState();
    state.worklist = openA; // Work never completes → budget fires
    const calls: string[] = [];
    const visited: string[] = [];
    const ctx = makeCtx(state, calls); // worklist stays open

    await drain(
      new FsmExecutor(buildProc({ workMaxTurns: 2, workMaxTurnsEvent: "budget" }, visited)).run(
        ctx,
      ),
    );

    expect(calls).toEqual(["WORK", "WORK", "ALT"]);
    expect(visited).toEqual(["Work", "Work", "Alt"]);
  });

  it("a stagnation check routes to the alternative path", async () => {
    const state = newState();
    state.worklist = openA; // never completes
    const calls: string[] = [];
    const visited: string[] = [];
    let stagChecks = 0;
    const stagnation: Check = () => ++stagChecks >= 2; // stagnant on the 2nd turn
    const ctx = makeCtx(state, calls);

    await drain(
      new FsmExecutor(
        buildProc(
          { workStagnation: stagnation, workStagnationEvent: "stuck", workMaxTurns: 10 },
          visited,
        ),
      ).run(ctx),
    );

    expect(calls).toEqual(["WORK", "WORK", "ALT"]);
    expect(visited).toEqual(["Work", "Work", "Alt"]);
  });

  it("a failed post-check emits a routable event without blocking the transition", async () => {
    const state = newState();
    state.worklist = doneA; // Work's completion condition fires on turn 1
    const calls: string[] = [];
    const visited: string[] = [];
    const ctx = makeCtx(state, calls);

    // post fails → emits "replan" (routes Work→Alt) instead of blocking; Alt then completes.
    await drain(
      new FsmExecutor(buildProc({ workPost: { when: () => false, event: "replan" } }, visited)).run(
        ctx,
      ),
    );

    expect(calls).toEqual(["WORK", "ALT"]);
    expect(visited).toEqual(["Work", "Alt"]);
  });

  it("forwards the driven turns' LogMessages to the output stream", async () => {
    const state = newState();
    state.worklist = doneA;
    const calls: string[] = [];
    const ctx = makeCtx(state, calls);

    const events = await drain(new FsmExecutor(buildProc({}, [])).run(ctx));

    expect(events.map((e) => e.type)).toContain("turn-finish");
  });
});
