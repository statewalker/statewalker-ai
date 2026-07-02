import { describe, expect, it } from "vitest";
import type { ExecutorContext } from "../../src/runtime/executor.js";
import { withFirstTurnTitle } from "../../src/runtime/executor.js";
import { LoopExecutor } from "../../src/runtime/loop-executor.js";
import { Inbox, type InboxMessage } from "../../src/state/inbox.js";
import type { LogMessage } from "../../src/state/log-message.js";
import { createAgentNodeFactory } from "../../src/state/node-factory.js";
import { NodeType } from "../../src/state/node-types.js";
import type { SessionState } from "../../src/state/session-state.js";

function newState(): SessionState {
  const factory = createAgentNodeFactory();
  return factory<SessionState>({ type: NodeType.session, id: "s1", props: {} });
}

/** A scripted `drive`: appends a Turn (with the user message) and yields a
 * text-delta + terminal turn-finish, recording each call. */
function scriptedDrive(state: SessionState, calls: string[]) {
  return async function* drive(message: InboxMessage): AsyncGenerator<LogMessage> {
    calls.push(message.text);
    const turn = state.addTurn();
    turn.addUserMessage(message.text);
    yield { type: "text-delta", turnId: turn.id, text: "hi" };
    yield { type: "turn-finish", turnId: turn.id, finishReason: "stop", kind: "ok" };
  };
}

describe("withFirstTurnTitle", () => {
  it("sets state.title before a consumer observes the first turn-finish", async () => {
    const state = newState();
    const turn = state.addTurn();
    turn.addUserMessage("what is the capital of France");

    async function* stream(): AsyncGenerator<LogMessage> {
      yield { type: "text-delta", turnId: turn.id, text: "x" };
      yield { type: "turn-finish", turnId: turn.id, finishReason: "stop", kind: "ok" };
    }

    let titleWhenFinishSeen: string | undefined;
    const wrapped = withFirstTurnTitle(stream(), state, async () => "Capital Of France");
    for await (const ev of wrapped) {
      if (ev.type === "turn-finish") titleWhenFinishSeen = state.title;
    }

    expect(titleWhenFinishSeen).toBe("Capital Of France");
  });

  it("does not regenerate an existing title", async () => {
    const state = newState();
    state.title = "Preset";
    const turn = state.addTurn();
    turn.addUserMessage("hello");

    let called = false;
    async function* stream(): AsyncGenerator<LogMessage> {
      yield { type: "turn-finish", turnId: turn.id, finishReason: "stop", kind: "ok" };
    }
    const wrapped = withFirstTurnTitle(stream(), state, async () => {
      called = true;
      return "New";
    });
    for await (const _ of wrapped) {
      /* drain */
    }

    expect(called).toBe(false);
    expect(state.title).toBe("Preset");
  });

  it("only intercepts the first turn-finish", async () => {
    const state = newState();
    const t0 = state.addTurn();
    t0.addUserMessage("first");

    let titleCalls = 0;
    async function* stream(): AsyncGenerator<LogMessage> {
      yield { type: "turn-finish", turnId: t0.id, finishReason: "stop", kind: "ok" };
      yield { type: "turn-finish", turnId: t0.id, finishReason: "stop", kind: "ok" };
    }
    const wrapped = withFirstTurnTitle(stream(), state, async () => {
      titleCalls++;
      return "T";
    });
    for await (const _ of wrapped) {
      /* drain */
    }

    expect(titleCalls).toBe(1);
  });
});

/** Non-blocking inbox for continuation tests: `take` returns queued messages
 * and `undefined` once drained, so the executor's outer loop ends cleanly. */
class TestInbox {
  queue: InboxMessage[] = [];
  push(m: InboxMessage): void {
    this.queue.push(m);
  }
  get pending(): number {
    return this.queue.length;
  }
  async take(): Promise<InboxMessage | undefined> {
    return this.queue.shift();
  }
}

interface TurnScript {
  text?: string;
  act?: (state: SessionState, inbox: TestInbox) => void;
}

function makeDrive(state: SessionState, inbox: TestInbox, scripts: TurnScript[], calls: string[]) {
  let i = 0;
  return async function* drive(message: InboxMessage): AsyncGenerator<LogMessage> {
    calls.push(message.text);
    const s = scripts[i++] ?? {};
    const turn = state.addTurn();
    turn.addUserMessage(message.text);
    if (s.text) turn.addAgentMessage().appendDelta(s.text);
    s.act?.(state, inbox);
    yield { type: "turn-finish", turnId: turn.id, finishReason: "stop", kind: "ok" };
  };
}

const open = [{ id: "a", status: "open" as const, text: "do a" }];
const done = [{ id: "a", status: "done" as const, text: "do a" }];
const setW = (items: typeof open) => (state: SessionState) => {
  state.worklist = items;
};

async function drain(gen: AsyncGenerator<LogMessage>): Promise<LogMessage[]> {
  const out: LogMessage[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("LoopExecutor autonomous continuation", () => {
  it("continues while the worklist has open items and stops when empty", async () => {
    const state = newState();
    const inbox = new TestInbox();
    const calls: string[] = [];
    const scripts: TurnScript[] = [
      { text: "plan", act: setW(open) },
      { text: "finish", act: setW(done) },
    ];
    const ctx: ExecutorContext = {
      inbox: inbox as unknown as Inbox,
      state,
      drive: makeDrive(state, inbox, scripts, calls),
    };
    inbox.push({ role: "user", text: "start" });

    await drain(new LoopExecutor().run(ctx));

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/^Continue working/);
  });

  it("halts on budget when the worklist never empties", async () => {
    const state = newState();
    const inbox = new TestInbox();
    const calls: string[] = [];
    const scripts: TurnScript[] = [
      { text: "t0", act: setW(open) },
      { text: "t1", act: setW(open) },
      { text: "t2", act: setW(open) },
      { text: "t3", act: setW(open) },
    ];
    const ctx: ExecutorContext = {
      inbox: inbox as unknown as Inbox,
      state,
      drive: makeDrive(state, inbox, scripts, calls),
    };
    inbox.push({ role: "user", text: "start" });

    await drain(new LoopExecutor(3).run(ctx));

    expect(calls).toHaveLength(3);
  });

  it("halts on stagnation when a continuation turn repeats", async () => {
    const state = newState();
    const inbox = new TestInbox();
    const calls: string[] = [];
    // Two identical continuation turns (same continuation text + same agent text)
    // produce the same signature → stagnation, well before the budget of 10.
    const scripts: TurnScript[] = [
      { text: "plan", act: setW(open) },
      { text: "work", act: setW(open) },
      { text: "work", act: setW(open) },
    ];
    const ctx: ExecutorContext = {
      inbox: inbox as unknown as Inbox,
      state,
      drive: makeDrive(state, inbox, scripts, calls),
    };
    inbox.push({ role: "user", text: "start" });

    await drain(new LoopExecutor(10).run(ctx));

    expect(calls).toHaveLength(3);
  });

  it("lets an interrupt preempt continuation", async () => {
    const state = newState();
    const inbox = new TestInbox();
    const calls: string[] = [];
    const scripts: TurnScript[] = [
      { text: "t0", act: setW(open) }, // would continue, but a message is waiting
      { text: "t1", act: setW(done) },
    ];
    const ctx: ExecutorContext = {
      inbox: inbox as unknown as Inbox,
      state,
      drive: makeDrive(state, inbox, scripts, calls),
    };
    inbox.push({ role: "user", text: "start" });
    inbox.push({ role: "user", text: "interrupt" });

    await drain(new LoopExecutor().run(ctx));

    expect(calls).toEqual(["start", "interrupt"]);
  });

  it("resets the budget on a new user message", async () => {
    const state = newState();
    const inbox = new TestInbox();
    const calls: string[] = [];
    const scripts: TurnScript[] = [
      { text: "m1t0", act: setW(open) },
      {
        text: "m1t1",
        act: (s, ib) => {
          s.worklist = open;
          ib.push({ role: "user", text: "m2" });
        },
      },
      { text: "m2t0", act: setW(open) },
      { text: "m2t1", act: setW(done) },
    ];
    const ctx: ExecutorContext = {
      inbox: inbox as unknown as Inbox,
      state,
      drive: makeDrive(state, inbox, scripts, calls),
    };
    inbox.push({ role: "user", text: "m1" });

    // maxTurns=2: burst 1 runs 2 turns then the queued m2 interrupts; burst 2
    // gets a FRESH budget and runs its own 2 turns. Carried budget → 3 calls.
    await drain(new LoopExecutor(2).run(ctx));

    expect(calls).toHaveLength(4);
  });
});

describe("LoopExecutor", () => {
  it("drives exactly one turn per inbox message, preserving trajectory order", async () => {
    const state = newState();
    const inbox = new Inbox();
    const calls: string[] = [];
    const ctx: ExecutorContext = { inbox, state, drive: scriptedDrive(state, calls) };

    inbox.push({ role: "user", text: "one" });
    inbox.push({ role: "user", text: "two" });

    const executor = new LoopExecutor();
    const events: LogMessage[] = [];
    let finishes = 0;
    for await (const ev of executor.run(ctx)) {
      events.push(ev);
      if (ev.type === "turn-finish" && ++finishes === 2) break;
    }

    expect(calls).toEqual(["one", "two"]);
    expect(events.map((e) => e.type)).toEqual([
      "text-delta",
      "turn-finish",
      "text-delta",
      "turn-finish",
    ]);
  });
});
