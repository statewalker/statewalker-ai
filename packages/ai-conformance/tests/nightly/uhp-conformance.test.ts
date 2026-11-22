// Nightly (statewalker/statewalker-root#139, decided in #108): UHP's own conformance suite
// (`uhp-conformance --class core`, HarnessRouter's Python CLI, installed at the spec commit the
// projection is pinned to) against the harness's deployment (ai-host-do on CellB Node), served over
// HTTP on a local port, with the scripted model. The run fails on any failed or erroring check.
//
//   UHP_CONFORMANCE   the suite's command (default `uhp-conformance` on the PATH). Without it the
//                     run is skipped and says so, unless UHP_CONFORMANCE_REQUIRED is set (CI),
//                     when a missing suite fails the run.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  seed,
  startDeployment,
} from "../../src/index.js";

const HOST = new URL("../../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const SUITE = process.env.UHP_CONFORMANCE || "uhp-conformance";
const REQUIRED = !!process.env.UHP_CONFORMANCE_REQUIRED;
const found = spawnSync(SUITE, ["--help"], { stdio: "ignore" }).status === 0;
if (!found && !REQUIRED)
  console.warn(
    `UHP conformance skipped: '${SUITE}' is not installed (pip install it, see nightly.yml)`,
  );

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const CATALOG: Record<string, string> = {
  "/team/plugin.json": JSON.stringify({ $schema: AP, name: "team" }),
  "/team/dev.cellb.harness/agents/lead.md": "---\nname: lead\n---\nYou are lead.\n",
};

let model: FakeModel;
let deployment: Deployment;
let server: Server;
let base = "";

/** The deployment over HTTP: each request passed to it, each answer streamed back as it comes. */
function serve(d: Deployment): Promise<Server> {
  const http = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
      const answer = await d.fetch(String(req.url), {
        method: req.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.flushHeaders();
      if (!answer.body) return void res.end();
      const body = Readable.fromWeb(answer.body as never);
      req.on("close", () => body.destroy());
      body.on("data", (chunk) => res.write(chunk));
      body.on("end", () => res.end());
      body.on("error", () => res.end());
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((ok) => http.listen(0, "127.0.0.1", () => ok(http)));
}

beforeAll(async () => {
  if (!found) return;
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(CATALOG),
  });
  await seed(deployment, ADMIN_KEY, {
    "/uhp/readme.md": "# uhp\n",
    "/uhp/.system/access": JSON.stringify({ suite: "editor" }),
  });
  server = await serve(deployment);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/uhp`;
});
afterAll(async () => {
  await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
  await deployment?.close();
  await model?.close();
});

it.skipIf(!found && !REQUIRED)(
  "passes UHP's conformance suite at class core",
  async () => {
    expect(found, `'${SUITE}' is required here and not installed`).toBe(true);
    const token = await login(deployment, "suite");
    const dir = mkdtempSync(join(tmpdir(), "uhp-conformance-"));
    try {
      const report = join(dir, "report.json");
      // Async, so this process keeps answering the suite's requests meanwhile.
      const code = await new Promise<number | null>((ok) => {
        const run = spawn(
          SUITE,
          [
            "--base-url",
            base,
            "--api-key",
            token,
            "--class",
            "core",
            "--plain",
            "--json",
            report,
            "--task-timeout",
            "120",
          ],
          { stdio: "inherit" },
        );
        run.on("exit", ok);
      });
      const result = JSON.parse(readFileSync(report, "utf8"));
      const bad = (result.checks ?? []).filter((c: { outcome?: string }) =>
        ["fail", "error"].includes(String(c.outcome)),
      );
      expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
      // Skips are listed (the scripted model answers too fast to watch a task mid-turn).
      if (result.skipped_not_verified?.length)
        console.warn(`UHP conformance skipped: ${result.skipped_not_verified.join(", ")}`);
      expect(result.conformant_with_skips).toBe(true);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);
