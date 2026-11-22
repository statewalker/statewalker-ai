// Approvals resume the agent's turn (statewalker/statewalker-root#214, the human's decision of
// 2026-11-22): answering an approval runs the stored action (re-checked at the gate) and the agent
// continues with its result, with no new user message; a denial, or an approval no one answered in
// its time, continues it with the refusal. Driven through AgentSessionCore with a scripted core
// (which records what each turn is given) and a fake clock for expiry.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  type ActionCall,
  AgentSessionCore,
  type ApprovalRequest,
  type SqlLike,
  type TurnRun,
} from "../src/index.js";

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const statements = query.split(";").filter((s) => s.trim());
      let rows: Record<string, unknown>[] = [];
      for (const s of statements) {
        const st = db.prepare(s);
        if (st.columns().length)
          rows = st.all(...(bindings as never[])) as Record<string, unknown>[];
        else {
          st.run(...(bindings as never[]));
          rows = [];
        }
      }
      return { toArray: () => rows };
    },
  };
};

const CONFIG = {
  id: "s1",
  user: "ann",
  workspace: "default",
  project: "alpha",
  agent: "a",
  capability: "cap",
};

const request = (id: string, path: string): ApprovalRequest =>
  ({
    id,
    session: "s1",
    project: "alpha",
    action: { method: "write", path },
    permission: `files.write:${path}`,
    reason: "the mode asks",
  }) as ApprovalRequest;

/** A core whose first turn asks the given approvals; later turns answer "ok". */
async function harness(asks: string[], ttl = 1000) {
  const runs: TurnRun[] = [];
  const ran: ActionCall[] = [];
  const wakes: number[] = [];
  const clock = { now: 1_000 };
  const core = new AgentSessionCore({
    sql: sqlite(),
    runTurn: async (turn, emit) => {
      runs.push(turn);
      if (runs.length === 1) {
        for (const id of asks) {
          const path = `/alpha/${id}.md`;
          emit({ kind: "tool_call", callId: `c-${id}`, name: "write", args: { path } });
          turn.onApproval(request(id, path), {
            method: "write",
            path,
            content: new TextEncoder().encode(id),
          });
          emit({
            kind: "tool_result",
            callId: `c-${id}`,
            output: `waiting on the user's approval ${id}`,
            isError: true,
          });
        }
        return {};
      }
      emit({ kind: "message", role: "assistant", text: "ok" });
      return {};
    },
    runAction: async (_config, call) => {
      ran.push(call);
      return undefined;
    },
    recordApprovals: async (_config, requests) =>
      requests.map((r) => ({ id: r.id, expires: clock.now + ttl })),
    wake: (at) => wakes.push(at),
  });
  await core.start(CONFIG);
  const first = await core.send({ content: "write them", delivery: "next", ignored: [] });
  const waiting = await core.waitTurn(first.turn_id);
  return { core, runs, ran, wakes, clock, waiting };
}

describe("approvals resume the turn", () => {
  it("allowing runs the stored action, then the agent continues with no new user message", async () => {
    const h = await harness(["ap-1"]);
    expect(h.waiting.status).toBe("waiting");
    const accepted = await h.core.answer("ap-1", { decision: "allow", scope: "once" });
    const turn = await h.core.waitTurn(accepted.turn_id);
    expect(h.ran).toMatchObject([{ method: "write", path: "/alpha/ap-1.md" }]);
    expect(turn).toMatchObject({ status: "completed", answers: "ap-1" });
    expect(turn.items.map((i) => i.kind)).toEqual(["tool_result", "message"]);
    expect(h.runs[1]?.continues).toBe(true);
    // The continuation's context ends with the action's result: no user message after it.
    const last = h.runs[1]?.context.at(-1);
    expect(last?.type === "item" && last.item).toMatchObject({
      kind: "tool_result",
      approval: "ap-1",
      output: "write /alpha/ap-1.md: done",
    });
  });

  it("several approvals: each answer runs its action, the last one continues the turn", async () => {
    const h = await harness(["ap-1", "ap-2"]);
    expect(h.waiting.stop_reason).toMatchObject({ approval_ids: ["ap-1", "ap-2"] });
    const a = await h.core.answer("ap-2", { decision: "deny", scope: "once", message: "no" });
    const first = await h.core.waitTurn(a.turn_id);
    expect(first).toMatchObject({
      status: "waiting",
      stop_reason: { type: "approval", approval_ids: ["ap-1"] },
    });
    expect(h.runs).toHaveLength(1);
    const b = await h.core.answer("ap-1", { decision: "allow", scope: "once" });
    expect(await h.core.waitTurn(b.turn_id)).toMatchObject({ status: "completed" });
    expect(h.runs).toHaveLength(2);
    expect(await h.core.status()).toBe("idle");
  });

  it("answers given together continue the turn once, after the last", async () => {
    const h = await harness(["ap-1", "ap-2"]);
    const a = await h.core.answer("ap-1", { decision: "allow", scope: "once" });
    const b = await h.core.answer("ap-2", { decision: "allow", scope: "once" });
    expect((await h.core.waitTurn(a.turn_id)).status).toBe("waiting");
    expect((await h.core.waitTurn(b.turn_id)).status).toBe("completed");
    expect(h.runs).toHaveLength(2);
    expect(h.ran).toHaveLength(2);
  });

  it("an approval no one answers in its time continues the turn as a denial, reason expired", async () => {
    const h = await harness(["ap-1"], 1000);
    // The host is asked to wake the session when it expires (its alarm).
    expect(h.wakes).toEqual([2_000]);
    expect(h.core.nextExpiry()).toBe(2_000);
    // Not yet expired: nothing happens.
    expect(await h.core.expire(1_999)).toBe(2_000);
    expect(h.runs).toHaveLength(1);
    expect(await h.core.expire(2_000)).toBeUndefined();
    const { items } = await h.core.items({ types: ["tool_result"] });
    const result = items.find((i) => i.approval === "ap-1");
    expect(result).toMatchObject({
      isError: true,
      denied: true,
      output: "write /alpha/ap-1.md: denied: expired",
    });
    const turn = await h.core.waitTurn(String(result?.turn));
    expect(turn).toMatchObject({ status: "completed", answers: "ap-1" });
    expect(h.ran).toEqual([]);
    expect(h.runs).toHaveLength(2);
  });

  it("an answer reaching the session after the approval expired continues nothing more", async () => {
    const h = await harness(["ap-1"], 1000);
    await h.core.expire(2_000);
    const { items } = await h.core.items({ types: ["tool_result"] });
    const expired = items.find((i) => i.approval === "ap-1");
    await h.core.waitTurn(String(expired?.turn));
    // The User DO took the answer just before it expired; it arrives after the alarm ran.
    const late = await h.core.answer("ap-1", { decision: "allow", scope: "once" });
    expect(late.turn_id).toBe(expired?.turn);
    expect(h.ran).toEqual([]);
    expect(h.runs).toHaveLength(2);
  });

  it("an approval answered in time does not expire", async () => {
    const h = await harness(["ap-1"], 1000);
    const a = await h.core.answer("ap-1", { decision: "allow", scope: "once" });
    await h.core.waitTurn(a.turn_id);
    await h.core.expire(5_000);
    const { items } = await h.core.items({ types: ["tool_result"] });
    expect(items.filter((i) => i.approval === "ap-1")).toHaveLength(1);
    expect(h.runs).toHaveLength(2);
  });
});
