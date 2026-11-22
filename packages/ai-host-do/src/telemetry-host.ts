// The deployment's telemetry (statewalker/statewalker-root#182): the exporter its TELEMETRY var
// chooses (OTLP over `fetch`, a console — stdout on CellB and CellD on Node, Workers Observability
// on Workers, the page's console in a browser — or off; a browser deployment never exports
// elsewhere), one Telemetry per component of the isolate. Only the operator sees it: it goes to
// the operator's collector or logs, never through the session API.
import {
  createTelemetry,
  NO_TELEMETRY,
  parseTelemetryConfig,
  type Telemetry,
  type TelemetryConfig,
  telemetryExporter,
} from "@statewalker/ai-environment";
import type { Env } from "./env.js";

const configs = new WeakMap<object, TelemetryConfig>();
const instances = new WeakMap<object, Map<string, Telemetry>>();

/** The deployment's telemetry configuration (problems warned once). */
export function telemetryConfigOf(env: Env): TelemetryConfig {
  let config = configs.get(env);
  if (!config) {
    const parsed = parseTelemetryConfig(env.TELEMETRY, {
      ...(env.HOSTING ? { hosting: env.HOSTING } : {}),
    });
    for (const problem of parsed.problems) console.warn(problem);
    config = parsed.config;
    configs.set(env, config);
  }
  return config;
}

/** The collector's headers, from the runtime secret the configuration names. */
function headersOf(env: Env, config: TelemetryConfig): Record<string, string> | undefined {
  if (!config.headersSecret) return undefined;
  const raw = (env as unknown as Record<string, unknown>)[config.headersSecret];
  if (typeof raw !== "string") {
    console.warn(`TELEMETRY: the secret ${config.headersSecret} is not set: no headers`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
  } catch {}
  console.warn(`TELEMETRY: the secret ${config.headersSecret} is not a JSON object: no headers`);
  return undefined;
}

/** The telemetry of one component (agent, workspace, user, worker) of this isolate. */
export function telemetryOf(env: Env, component: string): Telemetry {
  let byComponent = instances.get(env);
  if (!byComponent) {
    byComponent = new Map();
    instances.set(env, byComponent);
  }
  let telemetry = byComponent.get(component);
  if (!telemetry) {
    const config = telemetryConfigOf(env);
    const headers = headersOf(env, config);
    const exporter = telemetryExporter(config, headers ? { headers } : {});
    telemetry = exporter
      ? createTelemetry({
          exporter,
          resource: { component, ...(env.HOSTING ? { hosting: env.HOSTING } : {}) },
          flushMs: config.flushMs,
        })
      : NO_TELEMETRY;
    byComponent.set(component, telemetry);
  }
  return telemetry;
}
