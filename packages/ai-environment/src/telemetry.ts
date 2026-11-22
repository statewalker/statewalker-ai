// Telemetry without content (statewalker/statewalker-root#182, decided in #158): traces, metrics
// and structured logs for the operator, carrying ids, sizes, timings and outcomes only. What may be
// exported is a schema of allowed attributes, each of a kind (an id, a name, an error code, a
// count, a number): an attribute outside it, or a value not of its kind, is dropped before anything
// is kept. There is no flag that lets more through.

/** An attribute's value, as given. */
export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue | undefined | null>;
/** Attributes the schema let through. */
export type CleanAttributes = Record<string, AttributeValue>;

type Kind = "id" | "name" | "permission" | "code" | "count" | "number" | "flag";

/** An internal id: letters, digits and `._:/-`, never `@` or spaces (no emails, no names). */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
/** A name the harness defines (a tool, a meter, a status): short, no spaces. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/**
 * A permission's name, with an id as target at most (`files.write`, `tools.use:plugin/tool`):
 * never a path (a target starting with `/`).
 */
const PERMISSION = /^[a-z][a-z0-9_.-]{0,63}(:[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,127})?$/;
/** An error code: `E` and capitals (`EACCES`, `ELIMIT`). */
const CODE = /^E[A-Z0-9_]{1,31}$/;

/**
 * The attributes telemetry may carry (the decision's list: internal ids, model and provider, token
 * counts, durations, status, `stop_reason`, denied permission names and error codes), and what
 * each holds. Nothing else is ever exported.
 */
export const TELEMETRY_ATTRIBUTES: Readonly<Record<string, Kind>> = {
  "workspace.id": "id",
  "project.id": "id",
  "session.id": "id",
  "turn.id": "id",
  "turn.origin": "id",
  "user.id": "id",
  "agent.id": "id",
  "approval.id": "id",
  "model.id": "id",
  "model.requested": "id",
  "provider.id": "name",
  "tool.name": "name",
  "tool.kind": "name",
  "executor.kind": "name",
  "gate.area": "name",
  "gate.op": "name",
  "gate.decision": "name",
  "gate.step": "name",
  "approval.method": "name",
  "approval.decision": "name",
  permission: "permission",
  meter: "name",
  "limit.level": "name",
  ledger: "name",
  status: "name",
  "turn.status": "name",
  stop_reason: "name",
  event: "name",
  span: "name",
  component: "name",
  "service.name": "name",
  hosting: "name",
  "error.code": "code",
  "tokens.input": "count",
  "tokens.output": "count",
  "tokens.cached": "count",
  attempts: "count",
  items: "count",
  bytes: "count",
  "memory.actions": "count",
  duration_ms: "number",
  cpu_ms: "number",
  wait_ms: "number",
  "sample.rate": "number",
  fallback: "flag",
  continues: "flag",
};

function fits(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case "id":
      return typeof value === "string" && ID.test(value);
    case "name":
      return typeof value === "string" && NAME.test(value);
    case "permission":
      return typeof value === "string" && PERMISSION.test(value);
    case "code":
      return typeof value === "string" && CODE.test(value);
    case "count":
      return typeof value === "number" && Number.isInteger(value) && value >= 0;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "flag":
      return typeof value === "boolean";
  }
}

/** The attributes the schema lets through; everything else is dropped. */
export function cleanAttributes(attributes: Attributes | undefined): CleanAttributes {
  const out: CleanAttributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const kind = Object.hasOwn(TELEMETRY_ATTRIBUTES, key) ? TELEMETRY_ATTRIBUTES[key] : undefined;
    if (kind && fits(kind, value)) out[key] = value as AttributeValue;
  }
  return out;
}

/** A finished span, as exported. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** Milliseconds since the epoch. */
  start: number;
  end: number;
  status: "ok" | "error";
  attributes: CleanAttributes;
}

/** One metric point over the batch's interval: a counter's sum or a histogram's distribution. */
export type MetricRecord =
  | {
      kind: "counter";
      name: string;
      attributes: CleanAttributes;
      value: number;
      start: number;
      end: number;
    }
  | {
      kind: "histogram";
      name: string;
      attributes: CleanAttributes;
      count: number;
      sum: number;
      min: number;
      max: number;
      bounds: readonly number[];
      buckets: number[];
      start: number;
      end: number;
    };

export type Severity = "debug" | "info" | "warn" | "error";

/** A structured log record: an event name and attributes, never a free-text message. */
export interface LogRecord {
  time: number;
  severity: Severity;
  event: string;
  traceId?: string;
  spanId?: string;
  attributes: CleanAttributes;
}

/** What one export carries. */
export interface TelemetryBatch {
  /** The resource: the service and the component exporting. */
  resource: CleanAttributes;
  spans: SpanRecord[];
  metrics: MetricRecord[];
  logs: LogRecord[];
}

/** Where telemetry goes, chosen per deployment (./telemetry-exporters.ts). */
export interface TelemetryExporter {
  export(batch: TelemetryBatch): Promise<void>;
}

/** A span's place in a trace. */
export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface SpanOptions {
  /** The span's parent: its trace, and the span it is under. */
  parent?: SpanContext;
  /** The span IS this context: a trace's root span that other components derive (a turn's). */
  root?: SpanContext;
  /** When it started (now). */
  start?: number;
  /** The share of these spans kept, 0..1 (1): gate operations are sampled. */
  sample?: number;
}

export interface Span {
  readonly context: SpanContext;
  /** Whether the span is kept (a sampled-out span records nothing). */
  readonly recorded: boolean;
  set(attributes: Attributes): void;
  /** Marks the span failed, with the error's code only (its message is never kept). */
  fail(error: unknown): void;
  end(attributes?: Attributes): void;
}

export interface Telemetry {
  startSpan(name: string, attributes?: Attributes, options?: SpanOptions): Span;
  /** Runs `fn` in a span that ends with it (failed with the error's code when it throws). */
  span<T>(
    name: string,
    attributes: Attributes,
    fn: (span: Span) => T | Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
  /** Adds `value` to a counter. */
  count(name: string, value?: number, attributes?: Attributes): void;
  /** Records one value of a histogram (a latency in ms, a wait). */
  record(name: string, value: number, attributes?: Attributes): void;
  log(severity: Severity, event: string, attributes?: Attributes, context?: SpanContext): void;
  /** Exports what is buffered now. */
  flush(): Promise<void>;
}

export interface TelemetryOptions {
  exporter?: TelemetryExporter;
  /** The service's name (`statewalker-ai`). */
  service?: string;
  /** Further resource attributes (the component, the hosting). */
  resource?: Attributes;
  /** How long records wait before they are exported, in ms (1000); 0 exports only on `flush`. */
  flushMs?: number;
  now?: () => number;
  random?: () => number;
}

const hex = (bytes: number, random: () => number) => {
  let s = "";
  for (let i = 0; i < bytes; i++)
    s += Math.floor(random() * 256)
      .toString(16)
      .padStart(2, "0");
  return s;
};

/** FNV-1a, 64 bits, from `seed`: a stable hash (not a secret one; ids are not secrets). */
function fnv64(text: string, seed: bigint): string {
  let h = 0xcbf29ce484222325n ^ seed;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * A turn's trace and its root span, derived from the turn's id: every component that knows the
 * turn (the Agent DO, the Workspace DO) puts its spans in the same trace without passing context.
 */
export function turnTrace(turn: string): SpanContext {
  return {
    traceId: fnv64(turn, 1n) + fnv64(turn, 2n),
    spanId: fnv64(turn, 3n),
  };
}

/** The attributes metrics are kept by: few values each (never a session's or a turn's id). */
const METRIC_KEYS = [
  "span",
  "status",
  "error.code",
  "permission",
  "model.id",
  "provider.id",
  "tool.name",
  "tool.kind",
  "executor.kind",
  "gate.area",
  "gate.op",
  "gate.decision",
  "meter",
  "limit.level",
  "ledger",
  "turn.status",
  "stop_reason",
  "component",
];

/** The codes of refusals: a span ending with one is a denial. */
const DENIALS = new Set(["EACCES", "EPERM", "ELIMIT", "ENOSPC", "EAUTH"]);

/** Histogram bucket bounds, in ms. */
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000] as const;

/** Telemetry that records nothing: what a deployment with telemetry off gets. */
export const NO_TELEMETRY: Telemetry = createTelemetry({});

/** Telemetry exporting through `exporter` (none: nothing is kept). */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  const exporter = options.exporter;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const resource = cleanAttributes({
    "service.name": options.service ?? "statewalker-ai",
    ...options.resource,
  });
  let spans: SpanRecord[] = [];
  const counters = new Map<string, { name: string; attributes: CleanAttributes; value: number }>();
  const histograms = new Map<
    string,
    {
      name: string;
      attributes: CleanAttributes;
      count: number;
      sum: number;
      min: number;
      max: number;
      buckets: number[];
    }
  >();
  const keyOf = (name: string, attributes: CleanAttributes) =>
    JSON.stringify([name, Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : 1))]);
  const metricAttributes = (attributes: Attributes | undefined): CleanAttributes => {
    const clean = cleanAttributes(attributes);
    const out: CleanAttributes = {};
    for (const k of METRIC_KEYS) if (k in clean) out[k] = clean[k] as AttributeValue;
    return out;
  };
  const count = (name: string, value = 1, attributes?: Attributes) => {
    if (!exporter || !Number.isFinite(value) || !NAME.test(name)) return;
    const attrs = metricAttributes(attributes);
    const key = keyOf(name, attrs);
    const c = counters.get(key) ?? { name, attributes: attrs, value: 0 };
    c.value += value;
    counters.set(key, c);
    schedule();
  };
  const record = (name: string, value: number, attributes?: Attributes) => {
    if (!exporter || !Number.isFinite(value) || !NAME.test(name)) return;
    const attrs = metricAttributes(attributes);
    const key = keyOf(name, attrs);
    const h = histograms.get(key) ?? {
      name,
      attributes: attrs,
      count: 0,
      sum: 0,
      min: value,
      max: value,
      buckets: new Array(BOUNDS.length + 1).fill(0),
    };
    h.count++;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
    let i = BOUNDS.findIndex((b) => value <= b);
    if (i < 0) i = BOUNDS.length;
    h.buckets[i] = (h.buckets[i] ?? 0) + 1;
    histograms.set(key, h);
    schedule();
  };
  let logs: LogRecord[] = [];
  let since = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flushMs = options.flushMs ?? 1000;

  const schedule = () => {
    if (!exporter || flushMs <= 0 || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(() => {});
    }, flushMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const startSpan = (name: string, attributes?: Attributes, opts: SpanOptions = {}): Span => {
    const context = opts.root
      ? { traceId: opts.root.traceId, spanId: opts.root.spanId }
      : { traceId: opts.parent?.traceId ?? hex(16, random), spanId: hex(8, random) };
    const sample = opts.sample ?? 1;
    const recorded = !!exporter && (sample >= 1 || random() < sample);
    const start = opts.start ?? now();
    let attrs = cleanAttributes({
      ...attributes,
      ...(sample < 1 ? { "sample.rate": sample } : {}),
    });
    let status: SpanRecord["status"] = "ok";
    let ended = false;
    return {
      context,
      recorded,
      set(more) {
        attrs = { ...attrs, ...cleanAttributes(more) };
      },
      fail(error) {
        status = "error";
        attrs = { ...attrs, ...cleanAttributes({ "error.code": codeOfError(error) }) };
      },
      end(more) {
        if (ended) return;
        ended = true;
        if (!recorded) return;
        attrs = { ...attrs, ...cleanAttributes(more) };
        const end = now();
        spans.push({
          ...context,
          ...(opts.parent && !opts.root ? { parentSpanId: opts.parent.spanId } : {}),
          name,
          start,
          end,
          status,
          attributes: attrs,
        });
        // Every span is measured: its latency, and its failure by code (a refusal is a denial).
        const measured = { ...attrs, span: name, status };
        record("harness.span.duration", end - start, measured);
        if (status === "error") {
          count("harness.errors", 1, measured);
          if (DENIALS.has(String(attrs["error.code"]))) count("harness.denials", 1, measured);
        }
        schedule();
      },
    };
  };

  const flush = async () => {
    if (!exporter) return;
    const end = now();
    const metrics: MetricRecord[] = [
      ...[...counters.values()].map((c) => ({ kind: "counter", ...c, start: since, end }) as const),
      ...[...histograms.values()].map(
        (h) => ({ kind: "histogram", ...h, bounds: BOUNDS, start: since, end }) as const,
      ),
    ];
    counters.clear();
    histograms.clear();
    const batch: TelemetryBatch = { resource, spans, metrics, logs };
    spans = [];
    logs = [];
    since = end;
    if (!batch.spans.length && !batch.metrics.length && !batch.logs.length) return;
    await exporter.export(batch);
  };

  return {
    startSpan,
    async span(name, attributes, fn, opts) {
      const s = startSpan(name, attributes, opts);
      try {
        return await fn(s);
      } catch (e) {
        s.fail(e);
        throw e;
      } finally {
        s.end();
      }
    },
    count,
    record,
    log(severity, event, attributes, context) {
      if (!exporter) return;
      logs.push({
        time: now(),
        severity,
        event,
        ...(context ? { traceId: context.traceId, spanId: context.spanId } : {}),
        attributes: cleanAttributes(attributes),
      });
      schedule();
    },
    flush,
  };
}

/** An error's code (`EACCES`), never its message. */
export function codeOfError(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && CODE.test(code)) return code;
  const message = String((error as Error)?.message ?? error ?? "");
  return /^(E[A-Z0-9_]{1,31})\b/.exec(message)?.[1] ?? "EIO";
}
