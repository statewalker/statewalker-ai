// A folder's removal through the whole gate (statewalker-ai#49): the gated view, with every entry
// authorized under a real capability and the member's roles, and the mode deciding every entry by
// the rule layers, as the Workspace DO wires them. A folder of 10,000 entries is decided well
// within a Durable Object's CPU limit (30 s by default), and a rule on one entry still applies.
import {
  attenuateForAgentSession,
  decideMode,
  type FileAction,
  modeOf,
  resolveRoles,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { gatedFiles, modeGated } from "../src/index.js";

/** CPU milliseconds the test's own thread has used: what a Durable Object's CPU limit counts. */
const cpuMs = () => {
  const usage = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
  const { user, system } = usage ? usage() : process.cpuUsage();
  return (user + system) / 1000;
};

const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
const capability = attenuateForAgentSession(authority.mintUser("ann"), {
  session: "as-1",
  project: "alpha",
  agent: "dev",
});
const grants = resolveRoles(["editor"], {}).grants;

async function gate(entries: number, deny: string[] = []) {
  const store = new MemFilesApi();
  for (let i = 0; i < entries; i++)
    await writeText(store, `/alpha/build/d${i % 100}/f${i}.js`, "x");
  const authorizeAll = async (checks: readonly [FileAction, string][]) =>
    authority.authorizeMany(capability, {
      project: "alpha",
      grants,
      checks: checks.map(([action, path]) => ({ action, path })),
    });
  const view = gatedFiles(store, {
    systemFolder: ".system",
    visible: async (project) => project === "alpha",
    authorize: (action, path) => authorizeAll([[action, path]]),
    authorizeAll,
  });
  const layers = [
    { source: "deployment", rules: { deny: ["files.delete:/locked/**"] } },
    { source: "project", rules: { deny } },
    { source: "user", rules: { allow: ["files.delete:/build/**"] } },
  ];
  const mode = modeOf("default");
  const files = modeGated(view, {
    session: "as-1",
    project: "alpha",
    decide: async (checks) =>
      checks.map(([action, path]) =>
        decideMode({ area: "files", action, target: path.slice(6) }, { mode, layers }),
      ),
    consume: async () => false,
  });
  return { store, files };
}

describe("a folder's removal through the gate", () => {
  it("removes a folder of 10,000 entries well within a Durable Object's CPU limit", async () => {
    const { store, files } = await gate(10_000);
    const started = cpuMs();
    expect(await files.remove("/alpha/build")).toBe(true);
    expect(cpuMs() - started).toBeLessThan(10_000);
    expect(await store.exists("/alpha/build")).toBe(false);
  }, 60_000);

  it("still applies a deny rule on one entry inside the folder, removing nothing", async () => {
    const { store, files } = await gate(300, ["files.delete:/build/d7/f207.js"]);
    await expect(files.remove("/alpha/build")).rejects.toThrow(/EACCES.*d7\/f207\.js/);
    expect(await store.exists("/alpha/build/d0/f0.js")).toBe(true);
  });
});
