// The deployments a run starts, on the runtime CONFORMANCE_RUNTIME names: CellB Node in this
// process (here: a Worker project, wrangler config + main, loaded by @statewalker/cellb with its
// vars overridden for the run and its cells in a fresh directory), CellB in Chromium
// (browser-deployment.ts), CellD or workerd (process-deployment.ts).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import { projectConfig } from "./project-config.js";

export interface Deployment {
  /** A request to the deployment; `path` is resolved against its origin. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
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
  /** A local file system for the Worker: the `local` workspace backend (CellB Node and CellD only). */
  localFiles: RUNTIME === "node" || RUNTIME === "celld",
  /**
   * Deployment-held keys: SECRETS_KEY and the deployment secrets. A browser deployment holds none
   * (its secrets are sealed by a key of its own; `@statewalker/ai-host-do/browser`).
   */
  deploymentSecrets: RUNTIME !== "browser",
} as const;

/** Starts the Worker project on the run's runtime (`RUNTIME`), with `vars` over its configuration. */
export async function startDeployment(
  projectDir: URL,
  vars: Record<string, string> = {},
): Promise<Deployment> {
  if (RUNTIME === "browser") {
    const { startBrowserDeployment } = await import("./browser-deployment.js");
    return startBrowserDeployment(projectDir, vars);
  }
  if (RUNTIME === "celld" || RUNTIME === "workerd") {
    const { startProcessDeployment } = await import("./process-deployment.js");
    return startProcessDeployment(RUNTIME, projectDir, vars);
  }
  return startNodeDeployment(projectDir, vars);
}

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
