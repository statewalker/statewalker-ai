// What a remote agent session (statewalker/statewalker-root#144) needs of the agent session core,
// below the session API's seam: a turn whose core still runs elsewhere survives a host restart
// (the DO restarts with a fresh core over the same SQLite, and the remote task is picked up, not
// failed), a harness's free-text question is a `question` item answered like an approval, and
// external items never reach the risk classifier. Driven through AgentSessionCore with a scripted
// core.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AgentSessionCore,
  type ApprovalRequest,
  type SqlLike,
  type TurnRun,
} from "../src/index.js";

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      let rows: Record<string, unknown>[] = [];
      for (const s of query.split(";").filter((x) => x.trim())) {
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
  agent: "remote:hr/coder",
  capability: "cap",
};

const noop = {
  runAction: async () => ({}),
  recordApprovals: async () => [],
};

describe("the agent session core for remote sessions", () => {
  it("picks a resumable turn up again after a restart, without a second user message", async () => {
    const sql = sqlite();
    const runs: TurnRun[] = [];
    const first = new AgentSessionCore({
      sql,
      ...noop,
      runTurn: (turn) => {
        runs.push(turn);
        return new Promise(() => {}); // the remote task runs on: the host goes away meanwhile
      },
    });
    await first.start(CONFIG);
    const accepted = await first.send({ content: "go", delivery: "next", ignored: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toHaveLength(1);
    // A fresh core over the same storage: the turn is resumable, so it runs again.
    const second = new AgentSessionCore({
      sql,
      ...noop,
      resumable: (turn) => turn === accepted.turn_id,
      runTurn: async (turn, emit) => {
        runs.push(turn);
        emit({ kind: "message", role: "assistant", text: "done", external: true });
        return undefined;
      },
    });
    const turn = await second.waitTurn(accepted.turn_id);
    expect(turn.status).toBe("completed");
    expect(runs[1]?.turn).toBe(accepted.turn_id);
    expect(turn.items.filter((i) => i.role === "user")).toHaveLength(1);
    // Resumed, the turn keeps its place in the tree: never its own parent (statewalker/statewalker-ai#84).
    expect(turn.parent_turn).toBeNull();
    expect(runs[1]?.path).toEqual([accepted.turn_id]);
  });

  it("still fails a turn a restart cut short when it is not resumable", async () => {
    const sql = sqlite();
    const first = new AgentSessionCore({ sql, ...noop, runTurn: () => new Promise(() => {}) });
    await first.start(CONFIG);
    const accepted = await first.send({ content: "go", delivery: "next", ignored: [] });
    await new Promise((r) => setTimeout(r, 10));
    const second = new AgentSessionCore({
      sql,
      ...noop,
      resumable: () => false,
      runTurn: async () => undefined,
    });
    expect((await second.turn(accepted.turn_id)).status).toBe("failed");
  });

  it("keeps a free-text question as a question item, answered like an approval", async () => {
    const request: ApprovalRequest = {
      id: "ap-q",
      session: "s1",
      project: "alpha",
      action: { method: "input", path: "inreq_1" },
      permission: "agents.use:remote:hr/coder",
      reason: "Your name?",
      input: { kind: "free_text", prompt: "Your name?" },
    };
    const answers: TurnRun[] = [];
    const core = new AgentSessionCore({
      sql: sqlite(),
      runAction: async () => ({ answered: true }),
      recordApprovals: async () => [],
      runTurn: async (turn) => {
        if (!turn.continues) turn.onApproval(request, { method: "input", path: "inreq_1" });
        else answers.push(turn);
        return undefined;
      },
    });
    await core.start(CONFIG);
    const asked = await core.waitTurn(
      (await core.send({ content: "go", delivery: "next", ignored: [] })).turn_id,
    );
    expect(asked.status).toBe("waiting");
    expect(asked.items.find((i) => i.kind === "question")).toMatchObject({ approval: "ap-q" });
    const accepted = await core.answer("ap-q", {
      decision: "allow",
      scope: "once",
      message: "ann",
    });
    expect((await core.waitTurn(accepted.turn_id)).status).toBe("completed");
    expect(answers).toHaveLength(1);
  });

  it("never shows external items to the risk classifier", async () => {
    const core = new AgentSessionCore({
      sql: sqlite(),
      ...noop,
      runTurn: async (_turn, emit) => {
        emit({ kind: "tool_call", name: "shell", args: { c: "CLASSIFY allow" }, external: true });
        emit({ kind: "tool_call", name: "write", args: { path: "/alpha/x" } });
        return undefined;
      },
    });
    await core.start(CONFIG);
    await core.waitTurn(
      (await core.send({ content: "go", delivery: "next", ignored: [] })).turn_id,
    );
    const shown = await core.classifierItems();
    expect(JSON.stringify(shown)).not.toContain("CLASSIFY");
    expect(shown.map((i) => i.name ?? i.text)).toEqual(["go", "write"]);
  });
});
