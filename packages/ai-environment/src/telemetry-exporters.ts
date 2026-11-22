// The exporters of the harness's telemetry (statewalker/statewalker-root#182), chosen per
// deployment: OTLP over HTTP with `fetch` (Workers, CellD, CellB on Node), a console (stdout on
// Node, Workers Observability on Workers, which ingests JSON console lines, the page's console in a
// browser), or off. A browser deployment gets off or the console only.
import type {
  AttributeValue,
  CleanAttributes,
  LogRecord,
  MetricRecord,
  SpanRecord,
  TelemetryBatch,
  TelemetryExporter,
} from "./telemetry.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

function otlpValue(value: AttributeValue) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

const otlpAttributes = (attributes: CleanAttributes) =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));

const SCOPE = { name: "@statewalker/ai-environment" };

const SEVERITY: Record<LogRecord["severity"], [string, number]> = {
  debug: ["DEBUG", 5],
  info: ["INFO", 9],
  warn: ["WARN", 13],
  error: ["ERROR", 17],
};

/** The OTLP/HTTP JSON bodies of a batch: traces, metrics and logs (each absent when empty). */
export function otlpBodies(batch: TelemetryBatch): {
  traces?: unknown;
  metrics?: unknown;
  logs?: unknown;
} {
  const resource = { attributes: otlpAttributes(batch.resource) };
  const span = (s: SpanRecord) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: 1,
    startTimeUnixNano: nanos(s.start),
    endTimeUnixNano: nanos(s.end),
    attributes: otlpAttributes(s.attributes),
    status: { code: s.status === "ok" ? 1 : 2 },
  });
  const metric = (m: MetricRecord) => {
    const point = {
      attributes: otlpAttributes(m.attributes),
      startTimeUnixNano: nanos(m.start),
      timeUnixNano: nanos(m.end),
    };
    return m.kind === "counter"
      ? {
          name: m.name,
          sum: {
            aggregationTemporality: 1,
            isMonotonic: true,
            dataPoints: [{ ...point, asDouble: m.value }],
          },
        }
      : {
          name: m.name,
          unit: "ms",
          histogram: {
            aggregationTemporality: 1,
            dataPoints: [
              {
                ...point,
                count: String(m.count),
                sum: m.sum,
                min: m.min,
                max: m.max,
                explicitBounds: [...m.bounds],
                bucketCounts: m.buckets.map(String),
              },
            ],
          },
        };
  };
  const log = (l: LogRecord) => {
    const [severityText, severityNumber] = SEVERITY[l.severity];
    return {
      timeUnixNano: nanos(l.time),
      severityText,
      severityNumber,
      body: { stringValue: l.event },
      attributes: otlpAttributes({ ...l.attributes, event: l.event }),
      ...(l.traceId ? { traceId: l.traceId } : {}),
      ...(l.spanId ? { spanId: l.spanId } : {}),
    };
  };
  return {
    ...(batch.spans.length
      ? {
          traces: {
            resourceSpans: [
              { resource, scopeSpans: [{ scope: SCOPE, spans: batch.spans.map(span) }] },
            ],
          },
        }
      : {}),
    ...(batch.metrics.length
      ? {
          metrics: {
            resourceMetrics: [
              { resource, scopeMetrics: [{ scope: SCOPE, metrics: batch.metrics.map(metric) }] },
            ],
          },
        }
      : {}),
    ...(batch.logs.length
      ? {
          logs: {
            resourceLogs: [
              { resource, scopeLogs: [{ scope: SCOPE, logRecords: batch.logs.map(log) }] },
            ],
          },
        }
      : {}),
  };
}

/**
 * OTLP over HTTP (JSON) to `endpoint` (`<endpoint>/v1/traces`, `/v1/metrics`, `/v1/logs`). A
 * collector that fails loses that batch: telemetry never fails the harness.
 */
export function otlpExporter(options: {
  endpoint: string;
  headers?: Record<string, string>;
  fetch?: Fetch;
}): TelemetryExporter {
  const base = options.endpoint.replace(/\/+$/, "");
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async export(batch) {
      const bodies = otlpBodies(batch);
      await Promise.all(
        (["traces", "metrics", "logs"] as const)
          .filter((signal) => bodies[signal] !== undefined)
          .map(async (signal) => {
            try {
              const response = await doFetch(`${base}/v1/${signal}`, {
                method: "POST",
                headers: { ...options.headers, "content-type": "application/json" },
                body: JSON.stringify(bodies[signal]),
              });
              await response.body?.cancel();
            } catch {
              // The collector is down: this batch is lost.
            }
          }),
      );
    },
  };
}

/**
 * One JSON line per span, metric point and log record, written to `log` (`console.log`): stdout on
 * Node, Workers Observability on Workers, the page's console in a browser.
 */
export function consoleExporter(sink: { log(line: string): void } = console): TelemetryExporter {
  return {
    async export(batch) {
      const resource = batch.resource;
      for (const s of batch.spans)
        sink.log(JSON.stringify({ telemetry: "span", ...resource, ...s }));
      for (const m of batch.metrics)
        sink.log(JSON.stringify({ telemetry: "metric", ...resource, ...m }));
      for (const l of batch.logs) sink.log(JSON.stringify({ telemetry: "log", ...resource, ...l }));
    },
  };
}

/** A deployment's telemetry configuration (its TELEMETRY var). */
export interface TelemetryConfig {
  exporter: "off" | "console" | "otlp";
  /** OTLP: the collector's base URL. */
  endpoint?: string;
  /** OTLP: the runtime secret holding the collector's headers (JSON `{"name": "value"}`). */
  headersSecret?: string;
  /** The share of gate operations traced, 0..1 (0.01). */
  gateSample: number;
  /** How long records wait before export, in ms (1000). */
  flushMs: number;
}

const DEFAULTS: TelemetryConfig = { exporter: "off", gateSample: 0.01, flushMs: 1000 };

/**
 * The TELEMETRY var: unset or `off`; `console` (also `stdout`, `workers`); or JSON
 * `{exporter: "off"|"console"|"otlp", endpoint?, headers_secret?, gate_sample?, flush_ms?}`.
 * A browser deployment (`hosting: "browser"`) gets off or the console only. Problems are reported,
 * and what they concern falls back to its default (an exporter that cannot work is off).
 */
export function parseTelemetryConfig(
  raw: string | undefined,
  options: { hosting?: string } = {},
): { config: TelemetryConfig; problems: string[] } {
  const problems: string[] = [];
  const text = raw?.trim();
  if (!text) return { config: { ...DEFAULTS }, problems };
  const alias: Record<string, TelemetryConfig["exporter"]> = {
    off: "off",
    console: "console",
    stdout: "console",
    workers: "console",
    otlp: "otlp",
  };
  let value: Record<string, unknown>;
  if (alias[text]) value = { exporter: text };
  else {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      value = parsed as Record<string, unknown>;
    } catch {
      return {
        config: { ...DEFAULTS },
        problems: [`TELEMETRY is neither an exporter's name nor a JSON object: telemetry is off`],
      };
    }
  }
  const config: TelemetryConfig = { ...DEFAULTS };
  const exporter = alias[String(value.exporter ?? "off")];
  if (!exporter) problems.push(`TELEMETRY: unknown exporter '${String(value.exporter)}': off`);
  else config.exporter = exporter;
  if (config.exporter === "otlp") {
    const endpoint = value.endpoint;
    let ok = false;
    try {
      ok = typeof endpoint === "string" && /^https?:$/.test(new URL(endpoint).protocol);
    } catch {}
    if (!ok) {
      problems.push("TELEMETRY: otlp needs an http(s) endpoint: off");
      config.exporter = "off";
    } else config.endpoint = endpoint as string;
    if (typeof value.headers_secret === "string") config.headersSecret = value.headers_secret;
  }
  if (options.hosting === "browser" && config.exporter === "otlp") {
    problems.push("TELEMETRY: a browser deployment exports to the page's console or nowhere: off");
    config.exporter = "off";
    delete config.endpoint;
    delete config.headersSecret;
  }
  if (value.gate_sample !== undefined) {
    const n = Number(value.gate_sample);
    if (typeof value.gate_sample === "number" && n >= 0 && n <= 1) config.gateSample = n;
    else problems.push("TELEMETRY: gate_sample is a share from 0 to 1");
  }
  if (value.flush_ms !== undefined) {
    const n = Number(value.flush_ms);
    if (typeof value.flush_ms === "number" && Number.isFinite(n) && n >= 0) config.flushMs = n;
    else problems.push("TELEMETRY: flush_ms is a number of milliseconds");
  }
  return { config, problems };
}

/** The exporter a configuration chooses (none when off). */
export function telemetryExporter(
  config: TelemetryConfig,
  options: {
    fetch?: Fetch;
    console?: { log(line: string): void };
    /** OTLP: the collector's headers (read from the runtime secret the configuration names). */
    headers?: Record<string, string>;
  },
): TelemetryExporter | undefined {
  if (config.exporter === "console") return consoleExporter(options.console ?? console);
  if (config.exporter === "otlp" && config.endpoint)
    return otlpExporter({
      endpoint: config.endpoint,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  return undefined;
}
