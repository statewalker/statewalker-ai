// Sub-agent capabilities (statewalker/statewalker-root#126): the Workspace DO narrows a parent agent
// session's capability for a child with a block it signs itself (a third-party block under the
// workspace's key), so the gate trusts the child's session, agent and mode from that block alone,
// never from a block the holder appended. The child's capability holds every block of its
// parent's, so revoking any ancestor stops it.
import { Biscuit } from "@statewalker/webrun-biscuit";
import { describe, expect, it } from "vitest";
import { attenuateForAgentSession, resolveRoles, WorkspaceAuthority } from "../src/index.js";

const grant = { session: "as-1", project: "alpha", agent: "lead" };
const roles = (...held: string[]) => resolveRoles(held, {}).grants;

function setup() {
  const revoked = new Set<string>();
  const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate(), {
    isRevoked: (ids) => ids.some((id) => revoked.has(id)),
  });
  const user = authority.mintUser("ann");
  const parent = attenuateForAgentSession(user, grant);
  return { authority, user, parent, revoked };
}

describe("sub-agent capabilities", () => {
  it("reads a child's session, agent, parent and lineage from the block the workspace signed", async () => {
    const { authority, user, parent } = setup();
    const child = await authority.delegate(user, parent, { session: "as-2", agent: "helper" });
    expect(await authority.agentSessionOf(child)).toEqual({
      user: "ann",
      session: "as-2",
      project: "alpha",
      agent: "helper",
      unattended: false,
      parent: "as-1",
      lineage: ["as-1"],
    });
    const grandchild = await authority.delegate(user, child, {
      session: "as-3",
      agent: "checker",
      modes: ["plan"],
    });
    expect(await authority.agentSessionOf(grandchild)).toMatchObject({
      session: "as-3",
      parent: "as-2",
      lineage: ["as-1", "as-2"],
      modes: ["plan"],
    });
  });

  it("ignores a sub-agent block the holder appended itself", async () => {
    const { authority, parent } = setup();
    const forged = Biscuit.fromBase64(parent)
      .attenuate('agent_session("as-9");\nagent("x");\nparent_session("as-1");')
      .toBase64();
    expect(await authority.agentSessionOf(forged)).toEqual({
      user: "ann",
      ...grant,
      unattended: false,
    });
  });

  it("delegates only an agent session's capability narrowed from the caller's user capability", async () => {
    const { authority, user, parent } = setup();
    // Another user session of the same user: a different authority block.
    const other = authority.mintUser("ann");
    await expect(
      authority.delegate(other, parent, { session: "as-2", agent: "helper" }),
    ).rejects.toThrow(/EACCES/);
    // An attenuated capability is not a user capability, and a bare one is no agent session.
    await expect(
      authority.delegate(parent, parent, { session: "as-2", agent: "helper" }),
    ).rejects.toThrow(/EACCES/);
    await expect(
      authority.delegate(user, user, { session: "as-2", agent: "helper" }),
    ).rejects.toThrow(/EACCES/);
  });

  it("keeps the child in the parent's project, whatever the gate is told", async () => {
    const { authority, user, parent } = setup();
    const child = await authority.delegate(user, parent, { session: "as-2", agent: "helper" });
    await expect(
      authority.authorize(child, {
        action: "read",
        path: "/alpha/readme.md",
        project: "alpha",
        grants: roles("reader"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      authority.authorize(child, {
        action: "read",
        path: "/beta/readme.md",
        project: "beta",
        grants: roles("owner"),
      }),
    ).rejects.toThrow(/EACCES/);
  });

  it("revoking a session's block stops it and its descendants, not its siblings", async () => {
    const { authority, user, parent, revoked } = setup();
    const one = await authority.delegate(user, parent, { session: "as-2", agent: "a" });
    const two = await authority.delegate(user, parent, { session: "as-3", agent: "b" });
    const under = await authority.delegate(user, one, { session: "as-4", agent: "c" });
    revoked.add(await authority.revocationOf(user, one));
    await expect(authority.agentSessionOf(one)).rejects.toThrow(/EACCES/);
    await expect(authority.agentSessionOf(under)).rejects.toThrow(/EACCES/);
    await expect(authority.agentSessionOf(two)).resolves.toMatchObject({ session: "as-3" });
    await expect(authority.agentSessionOf(parent)).resolves.toMatchObject({ session: "as-1" });
    revoked.add(await authority.revocationOf(user, parent));
    await expect(authority.agentSessionOf(two)).rejects.toThrow(/EACCES/);
  });

  it("an unattended parent's children are unattended", async () => {
    const { authority, user } = setup();
    const parent = attenuateForAgentSession(user, { ...grant, unattended: true });
    const child = await authority.delegate(user, parent, { session: "as-2", agent: "helper" });
    expect(await authority.agentSessionOf(child)).toMatchObject({ unattended: true });
  });
});
