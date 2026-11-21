// Capabilities (statewalker/statewalker-root#157): the Workspace DO mints a user capability; the
// User DO narrows it for one agent session with one block, offline; the gate reads user, project
// and session from the capability alone and authorizes each file action.
import { Biscuit } from "@statewalker/webrun-biscuit";
import { describe, expect, it } from "vitest";
import { attenuateForAgentSession, WorkspaceAuthority } from "../src/index.js";

const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
const grant = { session: "as-1", project: "alpha", agent: "reviewer", mode: "default" };

describe("capabilities", () => {
  it("reads an agent session's user, project and session from its capability alone", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    expect(await authority.agentSessionOf(capability)).toEqual({ user: "ann", ...grant });
    await expect(
      authority.authorize(capability, {
        action: "read",
        path: "/alpha/readme.md",
        project: "alpha",
        role: "reader",
      }),
    ).resolves.toBeUndefined();
  });

  it("an agent session's capability cannot be widened to another project by a later block", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    // The holder appends its own block claiming another session and project.
    const widened = Biscuit.fromBase64(capability)
      .attenuate('agent_session("as-2");\nproject("beta");\nuser("bob");')
      .toBase64();
    expect(await authority.agentSessionOf(widened)).toEqual({ user: "ann", ...grant });
    // Even a gate told "beta" refuses: the session's own block binds every resource to /alpha/.
    for (const cap of [capability, widened])
      await expect(
        authority.authorize(cap, {
          action: "read",
          path: "/beta/notes.md",
          project: "beta",
          role: "owner",
        }),
      ).rejects.toThrow(/EACCES/);
  });

  it("refuses at the gate a bare user capability and one another workspace signed", async () => {
    const bare = authority.mintUser("ann");
    await expect(authority.agentSessionOf(bare)).rejects.toThrow(/EACCES/);
    const elsewhere = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
    const foreign = attenuateForAgentSession(elsewhere.mintUser("ann"), grant);
    await expect(authority.agentSessionOf(foreign)).rejects.toThrow(/EACCES/);
    await expect(authority.userOf(foreign)).rejects.toThrow(/EACCES/);
  });

  it("mints no capability for a user name that is not one path segment", () => {
    for (const user of ["", "..", "../bob", "ann/x"])
      expect(() => authority.mintUser(user)).toThrow(/EINVAL/);
  });
});
