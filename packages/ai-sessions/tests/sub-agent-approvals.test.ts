// A sub-agent's approval waits in its parent's turn (statewalker/statewalker-ai#88): the turn that
// started the sub-agent through `agent.start` waits on the sub-agent's approval as a stored `agent`
// action, without recording it as its own; the answer (or the expiry) continues the sub-agent,
// then the parent with the sub-agent's outcome; passing it over in the parent cancels it at the
// sub-agent's User DO entry. Driven through two AgentSessionCores wired in-process, as the agent
// session DOs wire them.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AgentSessionCore,
  type ApprovalRequest,
  type SqlLike,
  type SubAgentOutcome,
  type TurnView,
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

const BASE = { user: "ann", workspace: "default", project: "alpha", capability: "cap" };
const PATH = "/alpha/x.md";
const ASKED: ApprovalRequest = {
  id: "ap-1",
  session: "c1",
  project: "alpha",
  action: { method: "write", path: PATH },
  permission: `files.write:${PATH}`,
  reason: "the mode asks",
} as ApprovalRequest;

const outcomeOf = (turn: TurnView): SubAgentOutcome => ({
  output: `sub-agent turn ${turn.status}: ${turn.items
    .filter((i) => i.kind === "tool_result")
    .map((i) => i.output)
    .join(" | ")}`,
});

/** A parent whose first turn starts a child that asks one approval. */
async function tree() {
  const recorded: { session: string; ids: string[] }[] = [];
  const cancelled: { session: string; ids: string[] }[] = [];
  let parent: AgentSessionCore | undefined;
  const child: AgentSessionCore = new AgentSessionCore({
    sql: sqlite(),
    runTurn: async (turn, emit) => {
      if (turn.continues) emit({ kind: "message", role: "assistant", text: "child done" });
      else turn.onApproval(ASKED, { method: "write", path: PATH, content: new Uint8Array() });
      return {};
    },
    runAction: async () => undefined,
    recordApprovals: async (config, requests) => {
      recorded.push({ session: config.id, ids: requests.map((r) => r.id) });
      return requests.map((r) => ({ id: r.id, expires: 2_000 }));
    },
    subAgentAnswered: (_config, approval, decision) =>
      (parent as AgentSessionCore).subAgentAnswered(approval, decision),
  });
  await child.start({ ...BASE, id: "c1", agent: "helper", parent: "p1", root: "p1" });
  parent = new AgentSessionCore({
    sql: sqlite(),
    runTurn: async (turn, emit) => {
      if (turn.continues || turn.content !== "delegate") {
        emit({ kind: "message", role: "assistant", text: "parent done" });
        return {};
      }
      emit({ kind: "tool_call", callId: "c-start", name: "agent_start", args: {} });
      const accepted = await child.send({ content: "write", delivery: "next", ignored: [] });
      const ran = await child.waitTurn(accepted.turn_id);
      for (const id of ran.stop_reason?.approval_ids ?? [])
        turn.onApproval(ASKED, { method: "agent", path: "c1", target: id });
      emit({
        kind: "tool_result",
        callId: "c-start",
        output: "sub-agent session c1, turn waiting: waiting on the user's approval of ap-1",
        isError: true,
      });
      return {};
    },
    runAction: async (_config, call) => {
      expect(call).toMatchObject({ method: "agent", path: "c1", target: "ap-1" });
      return outcomeOf(await child.answerTurn(String(call.target)));
    },
    recordApprovals: async (config, requests) => {
      recorded.push({ session: config.id, ids: requests.map((r) => r.id) });
      return [];
    },
    cancelApprovals: async (config, ids) => {
      cancelled.push({ session: config.id, ids });
    },
  });
  await parent.start({ ...BASE, id: "p1", agent: "boss" });
  const first = await parent.send({ content: "delegate", delivery: "next", ignored: [] });
  const waiting = await parent.waitTurn(first.turn_id);
  return { parent, child, waiting, recorded, cancelled };
}

describe("a sub-agent's approval waits in its parent's turn", () => {
  it("the parent's turn waits on it without recording it as its own", async () => {
    const t = await tree();
    expect(t.waiting).toMatchObject({
      status: "waiting",
      stop_reason: { type: "approval", approval_ids: ["ap-1"] },
    });
    expect(t.waiting.items.find((i) => i.kind === "approval")).toMatchObject({
      approval: "ap-1",
      stored: { method: "agent", path: "c1", target: "ap-1" },
    });
    // Only the child's User DO entry holds it.
    expect(t.recorded).toEqual([{ session: "c1", ids: ["ap-1"] }]);
  });

  it("answering it continues the child, then the parent with the child's outcome", async () => {
    const t = await tree();
    const accepted = await t.child.answer("ap-1", { decision: "allow", scope: "once" });
    expect(accepted.session_id).toBe("c1");
    expect(accepted.continued).toEqual([expect.objectContaining({ session_id: "p1" })]);
    const turn = await t.parent.waitTurn(String(accepted.continued?.[0]?.turn_id));
    expect(turn).toMatchObject({ status: "completed", answers: "ap-1" });
    expect(turn.items.map((i) => [i.kind, i.output ?? i.text])).toEqual([
      ["tool_result", `sub-agent turn completed: write ${PATH}: done`],
      ["message", "parent done"],
    ]);
    // Answered once: the parent is not continued again.
    expect(await t.parent.subAgentAnswered("ap-1", "allow")).toEqual([]);
  });

  it("a denial continues the parent with the child's outcome, marked denied", async () => {
    const t = await tree();
    const accepted = await t.child.answer("ap-1", { decision: "deny", scope: "once" });
    const turn = await t.parent.waitTurn(String(accepted.continued?.[0]?.turn_id));
    expect(turn.items[0]).toMatchObject({
      kind: "tool_result",
      approval: "ap-1",
      denied: true,
      output: expect.stringContaining("denied by the user"),
    });
  });

  it("its expiry in the child continues the parent too", async () => {
    const t = await tree();
    t.child.expire(5_000);
    // The parent's answer turn is queued by the child's expiry: wait for it to show up.
    let queued: string | undefined;
    for (let i = 0; i < 200 && !queued; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const { turns } = await t.parent.branches();
      queued = turns.find((x) => x.id !== t.waiting.id)?.id;
    }
    const turn = await t.parent.waitTurn(String(queued));
    expect(turn).toMatchObject({ status: "completed", answers: "ap-1" });
    expect(turn?.items[0]).toMatchObject({
      denied: true,
      output: expect.stringContaining("denied: expired"),
    });
  });

  it("passing it over in the parent cancels it at the child's User DO entry; a late answer continues only the child", async () => {
    const t = await tree();
    const sent = await t.parent.send({
      content: "never mind",
      delivery: "next",
      ignored: [],
      void_approvals: true,
    });
    expect(sent.voided_approvals).toEqual(["ap-1"]);
    expect(t.cancelled).toContainEqual({ session: "c1", ids: ["ap-1"] });
    await t.parent.waitTurn(sent.turn_id);
    const late = await t.child.answer("ap-1", { decision: "allow", scope: "once" });
    expect(late.continued).toBeUndefined();
  });
});
