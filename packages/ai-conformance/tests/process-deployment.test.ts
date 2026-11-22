// How the runner starts a deployment on a runtime that runs as a process of its own (CellD,
// workerd; statewalker/statewalker-ai#100): the deployment it hands out answers from that
// runtime, never from another process that holds the port it was given. On a shared machine
// the port the runner asked for can be taken before the runtime binds it (another workerd's
// inspector took it in CI, answering the first request "501 Unsupported Operation").
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAN, RUNTIME, seed } from "../src/index.js";
import { startProcessDeployment } from "../src/process-deployment.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

/** A server that answers as workerd's inspector port does. */
async function foreignServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.method === "GET") res.writeHead(500, "Not yet implemented");
    else res.writeHead(501, "Unsupported Operation");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
}

describe.runIf(CAN.processDeployments)("process deployments", () => {
  let foreign: { server: Server; port: number };
  beforeAll(async () => {
    foreign = await foreignServer();
  });
  afterAll(() => new Promise<void>((r) => foreign.server.close(() => r())));

  it("starts on a port of its own when the port it was given is held by another process", async () => {
    let asked = 0;
    const deployment = await startProcessDeployment(
      RUNTIME as "celld" | "workerd",
      HOST,
      { ADMIN_KEY },
      // The first port the runner hands the runtime is the foreign server's; later ones are free.
      { port: async (free) => (++asked === 1 ? foreign.port : free()) },
    );
    try {
      expect(asked).toBeGreaterThan(0);
      await seed(deployment, ADMIN_KEY, { "/alpha/readme.md": "# alpha\n" });
    } finally {
      await deployment.close();
    }
  });
});
