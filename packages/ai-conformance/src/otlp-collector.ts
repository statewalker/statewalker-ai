// A fake OpenTelemetry collector (statewalker/statewalker-root#182): an OTLP/HTTP JSON endpoint
// that keeps every body it is posted (`/v1/traces`, `/v1/metrics`, `/v1/logs`), and reads them
// back as spans, metric points and log records with plain attribute objects. A deployment exports
// to it with TELEMETRY `{"exporter": "otlp", "endpoint": <url>}`.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type OtlpAttributes = Record<string, string | number | boolean>;

export interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  status: "ok" | "error" | "unset";
  attributes: OtlpAttributes;
  resource: OtlpAttributes;
}

export interface CollectedMetric {
  name: string;
  kind: "sum" | "histogram";
  attributes: OtlpAttributes;
  /** A sum's value, a histogram's count. */
  value: number;
  resource: OtlpAttributes;
}

export interface CollectedLog {
  event: string;
  severity: string;
  traceId?: string;
  attributes: OtlpAttributes;
  resource: OtlpAttributes;
}

export interface FakeCollector {
  /** The OTLP base URL (`http://127.0.0.1:<port>`). */
  url: string;
  /** Every body posted, as received (the raw text, for content checks). */
  bodies: { signal: string; text: string; headers: Record<string, string> }[];
  spans(): CollectedSpan[];
  metrics(): CollectedMetric[];
  logs(): CollectedLog[];
  /** Everything exported so far, as one text. */
  text(): string;
  /** Resolves once `ready()` holds over what was collected (polling, up to `timeoutMs`). */
  until(ready: () => boolean, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: OTLP JSON, read loosely
type Loose = any;

type Value = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
};
const plain = (v: Value): string | number | boolean =>
  v.stringValue ??
  (v.intValue !== undefined ? Number(v.intValue) : (v.doubleValue ?? v.boolValue ?? ""));
const attrs = (list: { key: string; value: Value }[] | undefined): OtlpAttributes =>
  Object.fromEntries((list ?? []).map(({ key, value }) => [key, plain(value)]));

export async function fakeCollector(): Promise<FakeCollector> {
  const bodies: FakeCollector["bodies"] = [];
  const parsed = () =>
    bodies.map((b) => ({ signal: b.signal, body: JSON.parse(b.text) as Record<string, Loose> }));
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
    const signal = String(req.url).replace(/^\/v1\//, "");
    bodies.push({ signal, text, headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  const state: FakeCollector = {
    url: `http://127.0.0.1:${port}`,
    bodies,
    spans: () =>
      parsed()
        .filter((b) => b.signal === "traces")
        .flatMap((b) =>
          (b.body.resourceSpans ?? []).flatMap((rs: Loose) =>
            (rs.scopeSpans ?? []).flatMap((ss: Loose) =>
              (ss.spans ?? []).map(
                (s: Loose): CollectedSpan => ({
                  traceId: s.traceId,
                  spanId: s.spanId,
                  ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                  name: s.name,
                  status: s.status?.code === 1 ? "ok" : s.status?.code === 2 ? "error" : "unset",
                  attributes: attrs(s.attributes),
                  resource: attrs(rs.resource?.attributes),
                }),
              ),
            ),
          ),
        ),
    metrics: () =>
      parsed()
        .filter((b) => b.signal === "metrics")
        .flatMap((b) =>
          (b.body.resourceMetrics ?? []).flatMap((rm: Loose) =>
            (rm.scopeMetrics ?? []).flatMap((sm: Loose) =>
              (sm.metrics ?? []).flatMap((m: Loose) =>
                (m.sum?.dataPoints ?? m.histogram?.dataPoints ?? []).map(
                  (p: Loose): CollectedMetric => ({
                    name: m.name,
                    kind: m.sum ? "sum" : "histogram",
                    attributes: attrs(p.attributes),
                    value: m.sum ? Number(p.asDouble ?? p.asInt) : Number(p.count),
                    resource: attrs(rm.resource?.attributes),
                  }),
                ),
              ),
            ),
          ),
        ),
    logs: () =>
      parsed()
        .filter((b) => b.signal === "logs")
        .flatMap((b) =>
          (b.body.resourceLogs ?? []).flatMap((rl: Loose) =>
            (rl.scopeLogs ?? []).flatMap((sl: Loose) =>
              (sl.logRecords ?? []).map(
                (l: Loose): CollectedLog => ({
                  event: l.body?.stringValue ?? "",
                  severity: l.severityText ?? "",
                  ...(l.traceId ? { traceId: l.traceId } : {}),
                  attributes: attrs(l.attributes),
                  resource: attrs(rl.resource?.attributes),
                }),
              ),
            ),
          ),
        ),
    text: () => bodies.map((b) => b.text).join("\n"),
    async until(ready, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (!ready()) {
        if (Date.now() > deadline)
          throw new Error(
            `the collector did not get the telemetry in time; it has spans ${JSON.stringify(
              state.spans().map((s) => `${s.name}:${s.attributes["tool.name"] ?? ""}`),
            )}`,
          );
        await new Promise((ok) => setTimeout(ok, 25));
      }
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
  return state;
}
