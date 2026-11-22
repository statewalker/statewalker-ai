// Databases behind capabilities (statewalker/statewalker-root#81, built by #136): `db.read`,
// `db.write` and `db.admin` on a database's name, authorized under the capability like a file
// action (an agent session's database calls stay inside its project); the built-in roles and modes
// give the decision's defaults; a plugin's tool gets a capability the workspace narrows for it, so
// only that tool reaches the plugin's private databases.
import { Biscuit } from "@statewalker/webrun-biscuit";
import { describe, expect, it } from "vitest";
import {
  attenuateForAgentSession,
  decide,
  decideMode,
  modeOf,
  resolveRoles,
  WorkspaceAuthority,
} from "../src/index.js";

const grant = { session: "as-1", project: "alpha", agent: "lead" };
const roles = (...held: string[]) => resolveRoles(held, {}).grants;
const db = (action: string, target = "notes") => ({ area: "db", action, target });
const verdict = (mode: string, action: string) =>
  decideMode(db(action), { mode: modeOf(mode), layers: [] }).verdict;

function setup() {
  const revoked = new Set<string>();
  const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate(), {
    isRevoked: (ids) => ids.some((id) => revoked.has(id)),
  });
  const user = authority.mintUser("ann");
  const agent = attenuateForAgentSession(user, grant);
  return { authority, user, agent, revoked };
}

describe("databases", () => {
  it("give owners db.admin, editors db.read and db.write, readers db.read", () => {
    expect(decide(roles("owner"), db("admin"))).toBe(true);
    expect(decide(roles("editor"), db("read"))).toBe(true);
    expect(decide(roles("editor"), db("write"))).toBe(true);
    expect(decide(roles("editor"), db("admin"))).toBe(false);
    expect(decide(roles("reader"), db("read"))).toBe(true);
    expect(decide(roles("reader"), db("write"))).toBe(false);
    expect(decide(roles("reader"), db("admin"))).toBe(false);
  });

  it("plan and default read databases and ask before writes; acceptEdits writes", () => {
    for (const mode of ["default", "plan", "auto", "acceptEdits", "dontAsk"])
      expect(verdict(mode, "read")).toBe("allow");
    expect(verdict("default", "write")).toBe("ask");
    expect(verdict("plan", "write")).toBe("ask");
    expect(verdict("acceptEdits", "write")).toBe("allow");
    expect(verdict("dontAsk", "write")).toBe("deny");
    expect(verdict("acceptEdits", "admin")).toBe("ask");
  });

  it("authorizes a database action by the member's roles, inside the agent session's project", async () => {
    const { authority, user, agent } = setup();
    const req = (action: "read" | "write" | "admin", project = "alpha") => ({
      action,
      database: "notes",
      project,
      grants: roles("editor"),
    });
    await expect(authority.authorizeDatabase(agent, req("read"))).resolves.toBeUndefined();
    await expect(authority.authorizeDatabase(agent, req("write"))).resolves.toBeUndefined();
    await expect(authority.authorizeDatabase(agent, req("admin"))).rejects.toThrow(/EACCES/);
    // The agent session's block binds it to its project, whatever the gate is told.
    await expect(authority.authorizeDatabase(agent, req("read", "beta"))).rejects.toThrow(/EACCES/);
    // The user's own session reaches any project the roles grant.
    await expect(authority.authorizeDatabase(user, req("read", "beta"))).resolves.toBeUndefined();
    const narrowed = Biscuit.fromBase64(agent)
      .attenuate('check if operation("db", "read");')
      .toBase64();
    await expect(authority.authorizeDatabase(narrowed, req("read"))).resolves.toBeUndefined();
    await expect(authority.authorizeDatabase(narrowed, req("write"))).rejects.toThrow(/EACCES/);
  });

  it("narrows an agent session's capability for one plugin's tool with a block only the workspace signs", async () => {
    const { authority, user, agent, revoked } = setup();
    const tool = await authority.forTool(agent, { plugin: "search", tool: "reindex" });
    expect(await authority.agentSessionOf(tool)).toEqual({
      user: "ann",
      ...grant,
      unattended: false,
      tool: { plugin: "search", tool: "reindex" },
    });
    // A block the holder appends claiming a tool is no tool.
    const forged = Biscuit.fromBase64(agent)
      .attenuate('tool_plugin("search");\ntool_name("reindex");')
      .toBase64();
    expect((await authority.agentSessionOf(forged)).tool).toBeUndefined();
    // Only an agent session's capability is narrowed for a tool, and only once.
    await expect(authority.forTool(user, { plugin: "search", tool: "reindex" })).rejects.toThrow(
      /EACCES/,
    );
    await expect(authority.forTool(tool, { plugin: "other", tool: "x" })).rejects.toThrow(/EACCES/);
    await expect(authority.forTool(agent, { plugin: "../x", tool: "x" })).rejects.toThrow(/EINVAL/);
    // Revoking the agent session stops its tools' capabilities.
    revoked.add((await authority.revocationOf(user, agent)) as string);
    await expect(authority.agentSessionOf(tool)).rejects.toThrow(/EACCES/);
  });
});
