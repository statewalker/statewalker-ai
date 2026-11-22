// Telemetry without content (statewalker/statewalker-root#182): what the harness's telemetry
// exports, through the exporter a deployment chooses.
import { describe, expect, it } from "vitest";
import { createTelemetry, type TelemetryBatch, turnTrace } from "../src/telemetry.js";

function collector() {
  const batches: TelemetryBatch[] = [];
  return {
    batches,
    exporter: {
      async export(batch: TelemetryBatch) {
        batches.push(batch);
      },
    },
    spans: () => batches.flatMap((b) => b.spans),
    metrics: () => batches.flatMap((b) => b.metrics),
    logs: () => batches.flatMap((b) => b.logs),
  };
}

describe("attributes", () => {
  it("keeps only the schema's attributes, each of its kind", async () => {
    const c = collector();
    const t = createTelemetry({ exporter: c.exporter, service: "test" });
    t.startSpan("tool.call", {
      "session.id": "as-1",
      "tool.name": "read",
      "tokens.input": 12,
      prompt: "the user's words",
      "tool.input": '{"path":"/a"}',
      "user.id": "ann@example.com",
      "error.code": "not a code",
      "tokens.output": -3,
    }).end();
    await t.flush();
    const [span] = c.spans();
    expect(span?.attributes).toEqual({
      "session.id": "as-1",
      "tool.name": "read",
      "tokens.input": 12,
    });
  });
});

describe("traces", () => {
  it("puts a turn's spans in one trace, which every component derives from the turn's id", async () => {
    const c = collector();
    const agent = createTelemetry({ exporter: c.exporter });
    const workspace = createTelemetry({ exporter: c.exporter });
    const trace = turnTrace("as-1.tu-1");
    expect(trace).toEqual(turnTrace("as-1.tu-1"));
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(turnTrace("as-1.tu-2").traceId).not.toBe(trace.traceId);
    const turn = agent.startSpan("turn", { "turn.id": "as-1.tu-1" }, { root: trace });
    await agent.span("model.request", {}, () => "ok", { parent: trace });
    workspace.startSpan("executor.run", {}, { parent: trace }).end();
    turn.end();
    await agent.flush();
    await workspace.flush();
    const spans = c.spans();
    expect(spans.map((s) => s.name).sort()).toEqual(["executor.run", "model.request", "turn"]);
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([trace.traceId]));
    for (const s of spans.filter((s) => s.name !== "turn"))
      expect(s.parentSpanId).toBe(trace.spanId);
  });

  it("records a failure's error code, never its message", async () => {
    const c = collector();
    const t = createTelemetry({ exporter: c.exporter });
    await expect(
      t.span("tool.call", {}, () => {
        throw new Error("EACCES: may not read '/alpha/secret-plans.md'");
      }),
    ).rejects.toThrow();
    await expect(
      t.span("tool.call", {}, () => {
        throw new Error("the file said: hunter2");
      }),
    ).rejects.toThrow();
    await t.flush();
    const [a, b] = c.spans();
    expect(a).toMatchObject({ status: "error", attributes: { "error.code": "EACCES" } });
    expect(b).toMatchObject({ status: "error", attributes: { "error.code": "EIO" } });
    expect(JSON.stringify(c.batches)).not.toMatch(/secret-plans|hunter2/);
  });

  it("keeps the sampled share of spans", async () => {
    const c = collector();
    const low = createTelemetry({ exporter: c.exporter, random: () => 0.1 });
    const high = createTelemetry({ exporter: c.exporter, random: () => 0.5 });
    low.startSpan("gate.files", {}, { sample: 0.2 }).end();
    high.startSpan("gate.files", {}, { sample: 0.2 }).end();
    high.startSpan("tool.call").end();
    await low.flush();
    await high.flush();
    const kept = c.spans();
    expect(kept.map((s) => [s.name, s.attributes["sample.rate"]])).toEqual([
      ["gate.files", 0.2],
      ["tool.call", undefined],
    ]);
  });
});

describe("metrics", () => {
  it("sums counters and summarizes histograms per attribute set, between exports", async () => {
    const c = collector();
    const t = createTelemetry({ exporter: c.exporter });
    t.count("harness.usage", 3, { meter: "tool_calls" });
    t.count("harness.usage", 2, { meter: "tool_calls" });
    t.count("harness.usage", 7, { meter: "turns" });
    t.record("harness.queue.wait", 5, { meter: "api_requests" });
    t.record("harness.queue.wait", 250, { meter: "api_requests" });
    await t.flush();
    const metrics = c.metrics();
    expect(
      metrics
        .filter((m) => m.kind === "counter")
        .map((m) => [m.attributes.meter, m.kind === "counter" && m.value]),
    ).toEqual([
      ["tool_calls", 5],
      ["turns", 7],
    ]);
    const h = metrics.find((m) => m.kind === "histogram");
    expect(h).toMatchObject({ name: "harness.queue.wait", count: 2, sum: 255, min: 5, max: 250 });
    t.count("harness.usage", 1, { meter: "turns" });
    await t.flush();
    expect(c.batches.at(-1)?.metrics).toMatchObject([{ kind: "counter", value: 1 }]);
  });

  it("measures every span: a latency histogram, and errors and denials counted by code", async () => {
    const c = collector();
    let clock = 1000;
    const t = createTelemetry({ exporter: c.exporter, now: () => clock });
    await t.span("model.request", { "model.id": "scripted/default" }, () => {
      clock += 40;
    });
    await t
      .span("tool.call", { "tool.name": "write", permission: "files.write" }, () => {
        throw new Error("EACCES: no");
      })
      .catch(() => {});
    await t
      .span("model.request", {}, () => {
        throw new Error("EIO: provider down");
      })
      .catch(() => {});
    await t.flush();
    const metrics = c.metrics();
    const latency = metrics.find(
      (m) =>
        m.kind === "histogram" &&
        m.name === "harness.span.duration" &&
        m.attributes.status === "ok",
    );
    expect(latency).toMatchObject({
      count: 1,
      sum: 40,
      attributes: { span: "model.request", status: "ok", "model.id": "scripted/default" },
    });
    expect(
      metrics
        .filter((m) => m.name === "harness.errors")
        .map((m) => m.attributes["error.code"])
        .sort(),
    ).toEqual(["EACCES", "EIO"]);
    expect(metrics.find((m) => m.name === "harness.denials")?.attributes).toMatchObject({
      permission: "files.write",
      "error.code": "EACCES",
    });
  });
});

describe("logs", () => {
  it("are an event and attributes, in the trace they belong to", async () => {
    const c = collector();
    const t = createTelemetry({ exporter: c.exporter });
    const trace = turnTrace("as-1.tu-1");
    t.log(
      "info",
      "turn.completed",
      { "turn.id": "as-1.tu-1", text: "the answer was zebra-blue" },
      trace,
    );
    t.log("error", "turn.failed", { "error.code": "EIO" });
    await t.flush();
    expect(c.logs()).toMatchObject([
      {
        severity: "info",
        event: "turn.completed",
        traceId: trace.traceId,
        attributes: { "turn.id": "as-1.tu-1" },
      },
      { severity: "error", event: "turn.failed", attributes: { "error.code": "EIO" } },
    ]);
    expect(JSON.stringify(c.logs())).not.toContain("zebra-blue");
  });
});
