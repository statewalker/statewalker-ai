// Telemetry of turns (statewalker/statewalker-root#182): one trace per turn, its root span derived
// from the turn's id (so the hosts' spans of model requests, tool calls and executor runs join
// it), the approval waits as spans, the queue wait as a metric, and lifecycle events as logs, with
// ids and outcomes only. Driven through AgentSessionCore with a scripted core.
import { DatabaseSync } from "node:sqlite";
import { createTelemetry, type TelemetryBatch, turnTrace } from "@statewalker/ai-environment";
import { describe, expect, it } from "vitest";
import { AgentSessionCore, type ApprovalRequest, type SqlLike } from "../src/index.js";

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
  agent: "plug/helper",
  capability: "cap",
};

const SECRET_WORDS = "the user's private words zebra-blue";

async function harness(script: "ok" | "ask" | "fail") {
  const batches: TelemetryBatch[] = [];
  const telemetry = createTelemetry({ exporter: { export: async (b) => void batches.push(b) } });
  let runs = 0;
  const core = new AgentSessionCore({
    sql: sqlite(),
    telemetry,
    runTurn: async (turn, emit) => {
      runs++;
      if (script === "fail") throw new Error(`EIO: the model said ${SECRET_WORDS}`);
      if (script === "ask" && runs === 1) {
        turn.onApproval(
          {
            id: "ap-1",
            session: "s1",
            project: "alpha",
            action: { method: "write", path: "/alpha/x.md" },
            permission: "files.write:/alpha/x.md",
            reason: "the mode asks",
          } as ApprovalRequest,
          { method: "write", path: "/alpha/x.md", content: new TextEncoder().encode(SECRET_WORDS) },
        );
        return {};
      }
      emit({ kind: "message", role: "assistant", text: SECRET_WORDS });
      return { model: "scripted/default" };
    },
    runAction: async () => undefined,
    recordApprovals: async () => [],
  });
  await core.start(CONFIG);
  const sent = await core.send({ content: SECRET_WORDS, delivery: "next", ignored: [] });
  const turn = await core.waitTurn(sent.turn_id);
  const exported = async () => {
    await telemetry.flush();
    return {
      spans: batches.flatMap((b) => b.spans),
      logs: batches.flatMap((b) => b.logs),
      metrics: batches.flatMap((b) => b.metrics),
      text: JSON.stringify(batches),
    };
  };
  return { core, turn, exported };
}

describe("turn telemetry", () => {
  it("traces a turn as one root span whose context any host derives from the turn's id", async () => {
    const h = await harness("ok");
    const { spans, metrics, logs, text } = await h.exported();
    const trace = turnTrace(h.turn.id);
    const root = spans.find((s) => s.name === "turn");
    expect(root).toMatchObject({
      traceId: trace.traceId,
      spanId: trace.spanId,
      status: "ok",
      attributes: {
        "session.id": "s1",
        "turn.id": h.turn.id,
        "workspace.id": "default",
        "project.id": "alpha",
        "user.id": "ann",
        "agent.id": "plug/helper",
        "turn.status": "completed",
        stop_reason: "end_turn",
        "model.id": "scripted/default",
      },
    });
    expect(root?.parentSpanId).toBeUndefined();
    expect(metrics.find((m) => m.name === "harness.turn.queue_wait")).toMatchObject({ count: 1 });
    expect(logs.map((l) => l.event)).toEqual(
      expect.arrayContaining(["session.started", "turn.queued", "turn.started", "turn.completed"]),
    );
    expect(logs.find((l) => l.event === "turn.completed")?.traceId).toBe(trace.traceId);
    expect(text).not.toContain("zebra-blue");
  });

  it("records a failed turn's error code, and logs it as an error", async () => {
    const h = await harness("fail");
    const { spans, logs, text } = await h.exported();
    expect(spans.find((s) => s.name === "turn")).toMatchObject({
      status: "error",
      attributes: { "turn.status": "failed", stop_reason: "error", "error.code": "EIO" },
    });
    expect(logs.find((l) => l.event === "turn.failed")).toMatchObject({
      severity: "error",
      attributes: { "error.code": "EIO" },
    });
    expect(text).not.toContain("zebra-blue");
  });

  it("traces the wait on an approval in the trace of the turn that continues it", async () => {
    const h = await harness("ask");
    expect(h.turn.status).toBe("waiting");
    const accepted = await h.core.answer("ap-1", { decision: "allow", scope: "once" });
    await h.core.waitTurn(accepted.turn_id);
    const { spans, logs, text } = await h.exported();
    const waiting = spans.find((s) => s.name === "turn" && s.attributes["turn.id"] === h.turn.id);
    expect(waiting?.attributes).toMatchObject({
      "turn.status": "waiting",
      stop_reason: "approval",
    });
    const trace = turnTrace(accepted.turn_id);
    const wait = spans.find((s) => s.name === "approval.wait");
    expect(wait).toMatchObject({
      traceId: trace.traceId,
      parentSpanId: trace.spanId,
      attributes: {
        "approval.id": "ap-1",
        "approval.decision": "allow",
        "turn.origin": h.turn.id,
      },
    });
    expect(
      spans.find((s) => s.name === "turn" && s.attributes["turn.id"] === accepted.turn_id)
        ?.attributes,
    ).toMatchObject({ continues: true, "turn.status": "completed" });
    expect(logs.map((l) => l.event)).toEqual(
      expect.arrayContaining(["approval.requested", "approval.answered"]),
    );
    expect(text).not.toContain("zebra-blue");
    expect(text).not.toContain("/alpha/x.md");
  });
});
