// A deployment on CellB Node, in this process (or in Chromium: browser-deployment.ts): a Worker project (wrangler config + main) loaded by
// @statewalker/cellb, with its vars overridden for the run and its cells in a fresh directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";

export interface Deployment {
  /** A request to the deployment; `path` is resolved against its origin. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** JSONC → JSON: line and block comments outside strings, and trailing commas. */
function stripJsonc(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      const start = i;
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
      out += source.slice(start, i + 1);
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The runtime deployments start on: `CONFORMANCE_RUNTIME`, "node" (default) or "browser". */
export const RUNTIME: "node" | "browser" =
  process.env.CONFORMANCE_RUNTIME === "browser" ? "browser" : "node";

/** Starts the Worker project on the run's runtime (`RUNTIME`), with `vars` over its configuration. */
export async function startDeployment(
  projectDir: URL,
  vars: Record<string, string> = {},
): Promise<Deployment> {
  if (RUNTIME === "browser") {
    const { startBrowserDeployment } = await import("./browser-deployment.js");
    return startBrowserDeployment(projectDir, vars);
  }
  return startNodeDeployment(projectDir, vars);
}

/** Starts the Worker project on CellB Node, in this process. */
export async function startNodeDeployment(
  projectDir: URL,
  vars: Record<string, string> = {},
): Promise<Deployment> {
  const dir = fileURLToPath(projectDir);
  const config = JSON.parse(stripJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")));
  config.vars = { ...config.vars, ...vars };
  config.main = join(dir, config.main);
  delete config.$schema;
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
