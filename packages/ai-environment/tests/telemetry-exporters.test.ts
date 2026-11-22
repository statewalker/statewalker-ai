// The exporters a deployment chooses from (statewalker/statewalker-root#182): OTLP over HTTP
// (`fetch`), a console (stdout on Node, Workers Observability on Workers, the page's console in a
// browser), or off.
import { describe, expect, it } from "vitest";
import { createTelemetry, turnTrace } from "../src/telemetry.js";
import {
  consoleExporter,
  otlpExporter,
  parseTelemetryConfig,
  telemetryExporter,
} from "../src/telemetry-exporters.js";

// biome-ignore lint/suspicious/noExplicitAny: OTLP JSON, read loosely
type Loose = any;

async function sample(exporter: Parameters<typeof createTelemetry>[0]["exporter"]) {
  let clock = 1_700_000_000_000;
  const t = createTelemetry({
    exporter,
    service: "statewalker-ai",
    resource: { component: "agent" },
    now: () => clock,
  });
  const trace = turnTrace("as-1.tu-1");
  const turn = t.startSpan("turn", { "turn.id": "as-1.tu-1" }, { root: trace });
  clock += 10;
  turn.end({ "turn.status": "completed" });
  t.count("harness.usage", 2, { meter: "tool_calls" });
  t.log("info", "turn.completed", { "turn.id": "as-1.tu-1" }, trace);
  await t.flush();
  return trace;
}

describe("OTLP over HTTP", () => {
  it("posts traces, metrics and logs as OTLP JSON to the endpoint, with the configured headers", async () => {
    const posts: { url: string; headers: Record<string, string>; body: Loose }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return new Response("{}");
    };
    const trace = await sample(
      otlpExporter({
        endpoint: "https://otel.example/",
        headers: { authorization: "Bearer k" },
        fetch,
      }),
    );
    expect(posts.map((p) => p.url).sort()).toEqual([
      "https://otel.example/v1/logs",
      "https://otel.example/v1/metrics",
      "https://otel.example/v1/traces",
    ]);
    for (const p of posts) {
      expect(p.headers["content-type"]).toBe("application/json");
      expect(p.headers.authorization).toBe("Bearer k");
    }
    const traces = posts.find((p) => p.url.endsWith("/v1/traces"))?.body;
    const rs = traces.resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "statewalker-ai" },
    });
    const span = rs.scopeSpans[0].spans[0];
    expect(span).toMatchObject({
      traceId: trace.traceId,
      spanId: trace.spanId,
      name: "turn",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000010000000",
      status: { code: 1 },
    });
    expect(span.attributes).toContainEqual({
      key: "turn.status",
      value: { stringValue: "completed" },
    });
    const metrics = posts.find((p) => p.url.endsWith("/v1/metrics"))?.body;
    const ms = metrics.resourceMetrics[0].scopeMetrics[0].metrics;
    const usage = ms.find((m: Loose) => m.name === "harness.usage");
    expect(usage.sum).toMatchObject({ aggregationTemporality: 1, isMonotonic: true });
    expect(usage.sum.dataPoints[0]).toMatchObject({ asDouble: 2 });
    const latency = ms.find((m: Loose) => m.name === "harness.span.duration");
    expect(latency.histogram.dataPoints[0]).toMatchObject({ count: "1", sum: 10 });
    const logs = posts.find((p) => p.url.endsWith("/v1/logs"))?.body;
    expect(logs.resourceLogs[0].scopeLogs[0].logRecords[0]).toMatchObject({
      severityText: "INFO",
      severityNumber: 9,
      body: { stringValue: "turn.completed" },
      traceId: trace.traceId,
    });
  });

  it("keeps going when the collector fails", async () => {
    const fetch = async () => new Response("no", { status: 503 });
    await expect(
      sample(otlpExporter({ endpoint: "https://otel.example", fetch })),
    ).resolves.toBeTruthy();
  });
});

describe("console", () => {
  it("writes one JSON line per span, metric and log record", async () => {
    const lines: string[] = [];
    await sample(consoleExporter({ log: (line: string) => lines.push(line) }));
    const records = lines.map((l) => JSON.parse(l));
    expect(records.map((r) => r.telemetry)).toEqual(
      expect.arrayContaining(["span", "metric", "log"]),
    );
    expect(records.find((r) => r.telemetry === "span")).toMatchObject({
      name: "turn",
      component: "agent",
      attributes: { "turn.status": "completed" },
    });
  });
});

describe("configuration", () => {
  it("chooses the exporter per deployment", () => {
    expect(parseTelemetryConfig(undefined).config.exporter).toBe("off");
    expect(parseTelemetryConfig("console").config.exporter).toBe("console");
    expect(parseTelemetryConfig("stdout").config.exporter).toBe("console");
    expect(parseTelemetryConfig("workers").config.exporter).toBe("console");
    expect(
      parseTelemetryConfig(JSON.stringify({ exporter: "otlp", endpoint: "https://otel.example" }))
        .config,
    ).toMatchObject({ exporter: "otlp", endpoint: "https://otel.example" });
    expect(parseTelemetryConfig(JSON.stringify({ exporter: "otlp" }))).toMatchObject({
      config: { exporter: "off" },
      problems: [expect.stringMatching(/endpoint/)],
    });
    expect(parseTelemetryConfig("nonsense").problems.length).toBe(1);
  });

  it("gives a browser deployment off or the page's console only", () => {
    const otlp = JSON.stringify({ exporter: "otlp", endpoint: "https://otel.example" });
    expect(parseTelemetryConfig(otlp, { hosting: "browser" })).toMatchObject({
      config: { exporter: "off" },
      problems: [expect.stringMatching(/browser/)],
    });
    expect(parseTelemetryConfig("console", { hosting: "browser" }).config.exporter).toBe("console");
  });

  it("samples gate operations at the configured rate (1% by default)", () => {
    expect(parseTelemetryConfig("console").config.gateSample).toBe(0.01);
    expect(
      parseTelemetryConfig(JSON.stringify({ exporter: "console", gate_sample: 0.5 })).config
        .gateSample,
    ).toBe(0.5);
    expect(
      parseTelemetryConfig(JSON.stringify({ exporter: "console", gate_sample: 7 })).problems.length,
    ).toBe(1);
  });

  it("builds the chosen exporter, none when off", () => {
    expect(telemetryExporter(parseTelemetryConfig(undefined).config, {})).toBeUndefined();
    expect(telemetryExporter(parseTelemetryConfig("console").config, {})).toBeDefined();
  });
});
