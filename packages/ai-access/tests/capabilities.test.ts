// Capabilities (statewalker/statewalker-root#157): the Workspace DO mints a user capability; the
// User DO narrows it for one agent session with one block, offline; the gate reads user, project
// and session from the capability alone and authorizes each file action.
import { Biscuit } from "@statewalker/webrun-biscuit";
import { describe, expect, it } from "vitest";
import { attenuateForAgentSession, resolveRoles, WorkspaceAuthority } from "../src/index.js";

const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
const grant = { session: "as-1", project: "alpha", agent: "reviewer" };
const roles = (...held: string[]) => resolveRoles(held, {}).grants;

describe("capabilities", () => {
  it("reads an agent session's user, project and session from its capability alone", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    expect(await authority.agentSessionOf(capability)).toEqual({
      user: "ann",
      ...grant,
      unattended: false,
    });
    await expect(
      authority.authorize(capability, {
        action: "read",
        path: "/alpha/readme.md",
        project: "alpha",
        grants: roles("reader"),
      }),
    ).resolves.toBeUndefined();
  });

  it("an agent session's capability cannot be widened to another project by a later block", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    // The holder appends its own block claiming another session and project.
    const widened = Biscuit.fromBase64(capability)
      .attenuate('agent_session("as-2");\nproject("beta");\nuser("bob");')
      .toBase64();
    expect(await authority.agentSessionOf(widened)).toEqual({
      user: "ann",
      ...grant,
      unattended: false,
    });
    // Even a gate told "beta" refuses: the session's own block binds every resource to /alpha/.
    for (const cap of [capability, widened])
      await expect(
        authority.authorize(cap, {
          action: "read",
          path: "/beta/notes.md",
          project: "beta",
          grants: roles("owner"),
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

  it("authorizes each file action by the permissions the member's roles grant at that moment", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    const custom = resolveRoles(["drafts"], { drafts: "files.read:/drafts/**" }).grants;
    const at = (action: "read" | "list", path: string, grants: typeof custom) =>
      authority.authorize(capability, { action, path, project: "alpha", grants });
    await expect(at("read", "/alpha/drafts/a.md", custom)).resolves.toBeUndefined();
    await expect(at("read", "/alpha/readme.md", custom)).rejects.toThrow(/EACCES/);
    await expect(at("list", "/alpha/drafts", custom)).rejects.toThrow(/EACCES/);
    await expect(at("list", "/alpha", roles("reader"))).resolves.toBeUndefined();
    await expect(at("read", "/alpha/readme.md", [])).rejects.toThrow(/EACCES/);
    await expect(at("read", "/alpha/readme.md", roles("admin"))).rejects.toThrow(/EACCES/);
  });

  it("takes the user session's own decisions (mode, rules, approvals) only from a bare user capability", async () => {
    const user = authority.mintUser("ann");
    expect(await authority.userOfUserCapability(user)).toBe("ann");
    // An agent session holds an attenuated capability: it can neither switch modes nor approve.
    const agent = attenuateForAgentSession(user, grant);
    await expect(authority.userOfUserCapability(agent)).rejects.toThrow(/EACCES/);
    const elsewhere = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
    await expect(authority.userOfUserCapability(elsewhere.mintUser("ann"))).rejects.toThrow(
      /EACCES/,
    );
  });

  it("authorizes writes and deletes by the roles, like reads", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    const at = (action: "write" | "delete", grants: ReturnType<typeof roles>) =>
      authority.authorize(capability, { action, path: "/alpha/a.md", project: "alpha", grants });
    await expect(at("write", roles("editor"))).resolves.toBeUndefined();
    await expect(at("delete", roles("editor"))).resolves.toBeUndefined();
    await expect(at("write", roles("reader"))).rejects.toThrow(/EACCES/);
    await expect(at("delete", roles("reader"))).rejects.toThrow(/EACCES/);
  });

  it("mints no capability for a user name that is not one path segment", () => {
    for (const user of ["", "..", "../bob", "ann/x"])
      expect(() => authority.mintUser(user)).toThrow(/EINVAL/);
  });

  it("narrows no capability to an agent session whose project is not one path segment", () => {
    // A root such as "/alpha/notes/" or "//" would bind the session to a folder that is no project.
    const user = authority.mintUser("ann");
    for (const project of ["", ".", "..", "alpha/notes", "alpha/", "/alpha", "-x", "a b"])
      expect(() => attenuateForAgentSession(user, { ...grant, project })).toThrow(/EINVAL/);
  });

  it("authorizes many file actions under one capability, verified once, refusing if any is refused", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    const editor = roles("editor");
    const many = (paths: string[], grants = editor) =>
      authority.authorizeMany(capability, {
        project: "alpha",
        grants,
        checks: paths.map((path) => ({ action: "delete" as const, path })),
      });
    await expect(many(["/alpha/a", "/alpha/a/b.md"])).resolves.toBeUndefined();
    // One refused entry refuses them all, and names it.
    await expect(many(["/alpha/a", "/beta/b.md"])).rejects.toThrow(/EACCES.*\/beta\/b\.md/);
    await expect(many(["/alpha/a"], roles("reader"))).rejects.toThrow(/EACCES/);
    const elsewhere = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
    const forged = attenuateForAgentSession(elsewhere.mintUser("ann"), grant);
    await expect(
      authority.authorizeMany(forged, { project: "alpha", grants: editor, checks: [] }),
    ).rejects.toThrow(/EACCES/);
  });

  it("authorizes the 10,000 entries of a folder's removal well within a Durable Object's CPU limit", async () => {
    const capability = attenuateForAgentSession(authority.mintUser("ann"), grant);
    const checks = Array.from({ length: 10_000 }, (_, i) => ({
      action: "delete" as const,
      path: `/alpha/build/d${i % 100}/f${i}.js`,
    }));
    const started = performance.now();
    await authority.authorizeMany(capability, {
      project: "alpha",
      grants: roles("editor"),
      checks,
    });
    // A Durable Object's default CPU limit is 30 s; this bound leaves room for slower machines.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
