// The deployments a run starts, on the runtime CONFORMANCE_RUNTIME names: CellB Node in this
// process (here: a Worker project, wrangler config + main, loaded by @statewalker/cellb with its
// vars overridden for the run and its cells in a fresh directory), CellB in Chromium
// (browser-deployment.ts), CellD or workerd (process-deployment.ts).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCodeEngines } from "@statewalker/ai-environment/code-engines";
import { pyodideEngine, pyodideNodeHost } from "@statewalker/ai-environment/pyodide";
import { loadProject } from "@statewalker/cellb/node";
import { projectConfig } from "./project-config.js";

export interface Deployment {
  /** A request to the deployment; `path` is resolved against its origin. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
  /**
   * The page's local model engine, where the runtime has one (a browser): `download` is the
   * user's action that puts a model's weights in the browser's cache. The runner's engine is a
   * stand-in whose "weights" answer through the scripted model at `scripted` (its /v1 URL).
   */
  localModels?: { download(model: string, scripted: string): Promise<void> };
}

/** The runtimes the conformance suite runs on (statewalker/statewalker-root#85). */
export type Runtime = "node" | "browser" | "celld" | "workerd";

const RUNTIMES: Runtime[] = ["node", "browser", "celld", "workerd"];

function runtimeOf(name: string | undefined): Runtime {
  if (!name) return "node";
  if (!RUNTIMES.includes(name as Runtime))
    throw new Error(`CONFORMANCE_RUNTIME=${name}: not one of ${RUNTIMES.join(", ")}`);
  return name as Runtime;
}

/** The runtime deployments start on: `CONFORMANCE_RUNTIME`, "node" (default), "browser", "celld" or "workerd". */
export const RUNTIME: Runtime = runtimeOf(process.env.CONFORMANCE_RUNTIME);

/**
 * What the run's runtime offers that not every runtime does, as the spec declares it; a scenario
 * that needs one runs only where it is offered (`it.runIf(CAN.localFiles)`).
 */
export const CAN = {
  /**
   * A local file system for the Worker: the `local` workspace backend, CellB Node only (CellD's
   * node:fs is a request-local /tmp and the read-only bundle; workerd and browsers have none).
   */
  localFiles: RUNTIME === "node",
  /**
   * Deployment-held keys: SECRETS_KEY and the deployment secrets. A browser deployment holds none
   * (its secrets are sealed by a key of its own; `@statewalker/ai-host-do/browser`).
   */
  deploymentSecrets: RUNTIME !== "browser",
  /**
   * A Python engine (Pyodide) and a POSIX one (Wasmer) installed by the runtime's host
   * (statewalker/statewalker-root#142): CellB in a browser and on Node. Elsewhere `python` and
   * POSIX programs answer ENOSYS.
   */
  python: RUNTIME === "node" || RUNTIME === "browser",
} as const;

/** Whether the run's deployments have a local model engine: a capability of the browser runtime. */
export const LOCAL_MODELS = RUNTIME === "browser";

/** Starts the Worker project on the run's runtime (`RUNTIME`), with `vars` over its configuration. */
export async function startDeployment(
  projectDir: URL,
  vars: Record<string, string> = {},
): Promise<Deployment> {
  const v = scenarioRates(vars);
  if (RUNTIME === "browser") {
    const { startBrowserDeployment } = await import("./browser-deployment.js");
    return startBrowserDeployment(projectDir, v);
  }
  if (RUNTIME === "celld" || RUNTIME === "workerd") {
    const { startProcessDeployment } = await import("./process-deployment.js");
    return startProcessDeployment(RUNTIME, projectDir, v);
  }
  return startNodeDeployment(projectDir, v);
}

/**
 * The session API's rate limits for scenario deployments (statewalker/statewalker-root#180): one
 * user runs many scenarios a minute, past the default 60 requests a minute per user and 600 per
 * workspace, so a deployment whose LIMITS names no `api_requests` limit is given far higher ones.
 * A deployment that names one (tests/rate-limits.test.ts) keeps the defaults and its own.
 */
export function scenarioRates(vars: Record<string, string>): Record<string, string> {
  let list: unknown[] = [];
  if (vars.LIMITS) {
    try {
      const parsed = JSON.parse(vars.LIMITS) as unknown;
      const found = Array.isArray(parsed) ? parsed : (parsed as { limits?: unknown })?.limits;
      if (!Array.isArray(found)) return vars;
      list = found;
    } catch {
      return vars;
    }
  }
  if (list.some((l) => (l as { meter?: unknown })?.meter === "api_requests")) return vars;
  const rate = (level: string) => ({
    meter: "api_requests",
    level,
    value: 1_000_000,
    period: "minute",
    on_exceed: "delay",
  });
  return { ...vars, LIMITS: JSON.stringify([...list, rate("user"), rate("workspace")]) };
}

/** Pyodide's folder, as the runner serves and installs it. */
export const PYODIDE_DIR = `${dirname(createRequire(import.meta.url).resolve("pyodide/package.json"))}/`;

// CellB Node runs the deployment in this realm: its host (this runner) declares the engines it
// has, as an operator's host would (statewalker/statewalker-root#142).
if (RUNTIME === "node")
  installCodeEngines({ pyodide: pyodideEngine(pyodideNodeHost({ indexDir: PYODIDE_DIR })) });

/** Starts the Worker project on CellB Node, in this process. */
export async function startNodeDeployment(
  projectDir: URL,
  vars: Record<string, string> = {},
): Promise<Deployment> {
  const dir = fileURLToPath(projectDir);
  const config = projectConfig(dir);
  config.vars = { ...config.vars, ...vars };
  config.main = join(dir, config.main);
  const tmp = mkdtempSync(join(tmpdir(), "ai-conformance-"));
  writeFileSync(join(tmp, "wrangler.json"), JSON.stringify(config));
  let project: Awaited<ReturnType<typeof loadProject>>;
  try {
    project = await loadProject(tmp, { data: join(tmp, "data") });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return {
    fetch: (path, init) => project.fetch(new Request(new URL(path, "http://localhost"), init)),
    close: async () => {
      await project.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
