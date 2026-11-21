// Tenancy (statewalker/statewalker-root#127, decision #78): the workspace's revocation list, which
// refuses a revoked capability and everything narrowed from it at its next use; unattended agent
// sessions, whose capability says so and whose "ask" becomes a deny; service accounts' names and
// API keys.
import { Biscuit } from "@statewalker/webrun-biscuit";
import { describe, expect, it } from "vitest";
import {
  attenuateForAgentSession,
  hashApiKey,
  isServiceAccount,
  newApiKey,
  resolveRoles,
  serviceAccountUser,
  settleAsk,
  TokenIssuer,
  WorkspaceAuthority,
} from "../src/index.js";

const grant = { session: "as-1", project: "alpha", agent: "reviewer", mode: "default" };
const roles = (...held: string[]) => resolveRoles(held, {}).grants;

/** An authority with a revocation list held in memory, as the Workspace DO holds it in SQLite. */
function revocable() {
  const list = new Set<string>();
  const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate(), {
    isRevoked: (ids) => ids.some((id) => list.has(id)),
  });
  return { authority, revoke: (id: string) => list.add(id) };
}

const read = (authority: WorkspaceAuthority, capability: string) =>
  authority.authorize(capability, {
    action: "read",
    path: "/alpha/readme.md",
    project: "alpha",
    grants: roles("reader"),
  });

describe("revocation list", () => {
  it("refuses a revoked agent session's capability at its next use, and nothing else", async () => {
    const { authority, revoke } = revocable();
    const user = authority.mintUser("ann");
    const one = attenuateForAgentSession(user, grant);
    const two = attenuateForAgentSession(user, { ...grant, session: "as-2" });
    await expect(read(authority, one)).resolves.toBeUndefined();
    revoke(await authority.revocationOf(user, one));
    await expect(read(authority, one)).rejects.toThrow(/EACCES/);
    await expect(authority.agentSessionOf(one)).rejects.toThrow(/EACCES/);
    await expect(read(authority, two)).resolves.toBeUndefined();
    await expect(authority.userOfUserCapability(user)).resolves.toBe("ann");
  });

  it("revoking a session stops every capability narrowed from it", async () => {
    const { authority, revoke } = revocable();
    const user = authority.mintUser("ann");
    const session = attenuateForAgentSession(user, grant);
    // A delegation from the session (a sub-agent's) is one more block on the session's capability.
    const child = Biscuit.fromBase64(session)
      .attenuate('check if resource($p), $p.starts_with("/alpha/");')
      .toBase64();
    await expect(read(authority, child)).resolves.toBeUndefined();
    revoke(await authority.revocationOf(user, session));
    await expect(read(authority, child)).rejects.toThrow(/EACCES/);
  });

  it("revoking one delegated capability leaves the session that delegated it", async () => {
    const { authority, revoke } = revocable();
    const user = authority.mintUser("ann");
    const session = attenuateForAgentSession(user, grant);
    const child = Biscuit.fromBase64(session).attenuate("check if true;").toBase64();
    revoke(await authority.revocationOf(user, child));
    await expect(read(authority, child)).rejects.toThrow(/EACCES/);
    await expect(read(authority, session)).resolves.toBeUndefined();
  });

  it("revoking the user capability stops every agent session narrowed from it", async () => {
    const { authority, revoke } = revocable();
    const user = authority.mintUser("ann");
    const sessions = [grant, { ...grant, session: "as-2" }].map((g) =>
      attenuateForAgentSession(user, g),
    );
    revoke(await authority.revocationOf(user, user));
    for (const s of sessions) await expect(read(authority, s)).rejects.toThrow(/EACCES/);
    await expect(authority.userOfUserCapability(user)).rejects.toThrow(/EACCES/);
    // A new user session's capability is a new token, not on the list.
    await expect(
      read(authority, attenuateForAgentSession(authority.mintUser("ann"), grant)),
    ).resolves.toBeUndefined();
  });

  it("names for revocation only a capability narrowed from the caller's own user capability", async () => {
    const { authority } = revocable();
    const ann = authority.mintUser("ann");
    const bob = authority.mintUser("bob");
    const bobs = attenuateForAgentSession(bob, grant);
    // Even another user capability of the same user is not this one's to revoke.
    const annAgain = authority.mintUser("ann");
    for (const target of [bobs, bob, attenuateForAgentSession(annAgain, grant)])
      await expect(authority.revocationOf(ann, target)).rejects.toThrow(/EACCES/);
    // Only a bare user capability revokes: an agent session cannot revoke its siblings.
    const own = attenuateForAgentSession(ann, grant);
    const sibling = attenuateForAgentSession(ann, { ...grant, session: "as-2" });
    await expect(authority.revocationOf(own, sibling)).rejects.toThrow(/EACCES/);
    const elsewhere = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
    await expect(
      authority.revocationOf(ann, attenuateForAgentSession(elsewhere.mintUser("ann"), grant)),
    ).rejects.toThrow(/EACCES/);
  });
});

describe("unattended agent sessions", () => {
  it("an unattended session's capability says so, and no later block can undo it", async () => {
    const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
    const user = authority.mintUser("svc");
    const attended = attenuateForAgentSession(user, grant);
    expect(await authority.agentSessionOf(attended)).toMatchObject({ unattended: false });
    const unattended = attenuateForAgentSession(user, { ...grant, unattended: true });
    expect(await authority.agentSessionOf(unattended)).toMatchObject({ unattended: true });
    const undone = Biscuit.fromBase64(unattended).attenuate("unattended(false);").toBase64();
    expect(await authority.agentSessionOf(undone)).toMatchObject({ unattended: true });
    // Nor can a later block make an attended session look unattended, or anything else.
    const forged = Biscuit.fromBase64(attended).attenuate("unattended(true);").toBase64();
    expect(await authority.agentSessionOf(forged)).toMatchObject({ unattended: false });
  });

  it("turns an ask into a deny with a reason when unattended, and leaves every other verdict", () => {
    const ask = { verdict: "ask" as const, source: "mode", reason: "default mode asks for writes" };
    expect(settleAsk(ask, { unattended: false })).toEqual(ask);
    const settled = settleAsk(ask, { unattended: true });
    expect(settled.verdict).toBe("deny");
    expect(settled.reason).toMatch(/unattended/);
    expect(settled.reason).toContain(ask.reason);
    for (const verdict of ["allow", "deny"] as const) {
      const d = { verdict, source: "mode", reason: "r" };
      expect(settleAsk(d, { unattended: true })).toEqual(d);
    }
  });
});

describe("service accounts", () => {
  it("names a service account apart from every name an identity provider could sign in", () => {
    const user = serviceAccountUser("acme", "ci");
    expect(isServiceAccount(user)).toBe(true);
    // Its name is a user name like any other: one path segment, accepted by capabilities.
    const authority = WorkspaceAuthority.fromStored(WorkspaceAuthority.generate());
    expect(() => authority.mintUser(user)).not.toThrow();
    for (const human of ["ann", "ann@example.com", "ci", "ci.acme"])
      expect(isServiceAccount(human)).toBe(false);
    for (const bad of ["", "..", "a/b", "-x", "a b"])
      expect(() => serviceAccountUser("acme", bad)).toThrow(/EINVAL/);
  });

  it("the issuer signs no human identity in a service account's form", () => {
    const issuer = new TokenIssuer(TokenIssuer.generateKeys(), { id: "issuer" });
    expect(() => issuer.issue(serviceAccountUser("acme", "ci"), "acme")).toThrow(/EACCES/);
    expect(() =>
      issuer.issueServiceAccount(serviceAccountUser("acme", "ci"), "acme"),
    ).not.toThrow();
    expect(() => issuer.issueServiceAccount("ann", "acme")).toThrow(/EINVAL/);
  });

  it("makes API keys that are unguessable and kept only as a hash", async () => {
    const a = newApiKey();
    const b = newApiKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(await hashApiKey(a)).toBe(await hashApiKey(a));
    expect(await hashApiKey(a)).not.toBe(await hashApiKey(b));
    expect(await hashApiKey(a)).not.toContain(a);
  });
});
