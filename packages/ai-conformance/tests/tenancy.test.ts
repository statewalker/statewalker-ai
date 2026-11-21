// Tenancy (statewalker/statewalker-root#127, decided in #78): one deployment serves many
// workspaces with no call crossing between them; service accounts are non-human users with roles,
// signing in with an API key; access-token revocation works at three levels (a user everywhere, a
// user in one workspace, one session or delegated capability); and an unattended session turns
// every "ask" into a deny with a reason. Run against the harness's own deployment (ai-host-do) on
// CellB Node in-process, with the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiError,
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  openUserSessionAt,
  renewToken,
  restClient,
  revokeUserEverywhere,
  rpcClient,
  type SessionClient,
  seed,
  sendPastUser,
  serviceAccountToken,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const TRANSPORTS = ["rest", "rpc"];
// Each transport gets its own users ("ann-rest", "ann-rpc"), so the two runs share no sessions or
// revocations.
const forEach = (roles: Record<string, string>) =>
  Object.fromEntries(
    TRANSPORTS.flatMap((t) => Object.entries(roles).map(([user, role]) => [`${user}-${t}`, role])),
  );
const ACCESS = forEach({ ann: "editor", bob: "reader", gus: "reader", ida: "reader" });
const DEFAULT_FILES = {
  "/alpha/readme.md": "# alpha\n",
  "/alpha/.system/access": JSON.stringify(ACCESS),
  "/shared/readme.md": "shared, in the default workspace\n",
  "/shared/.system/access": JSON.stringify(ACCESS),
  "/beta/readme.md": "# beta\n",
  "/beta/.system/access": JSON.stringify(forEach({ ann: "owner" })),
  // The workspace's own access file names its admins.
  "/.system/access": JSON.stringify(forEach({ wes: "admin" })),
};
const OTHER_FILES = {
  "/shared/readme.md": "shared, in the other workspace\n",
  "/shared/.system/access": JSON.stringify(ACCESS),
};

type Connect = (deployment: Deployment, token: string) => Promise<SessionClient>;
const sockets: { close(): void }[] = [];
const transports: [string, Connect][] = [
  ["REST", async (d, token) => restClient(d, token)],
  [
    "RPC",
    async (d, token) => {
      const client = await rpcClient(d, token);
      sockets.push(client);
      return client;
    },
  ],
];

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    LLM_BASE_URL: model.url,
    DEV_LOGIN: "true",
    ADMIN_KEY,
    WORKSPACES: "default,other",
  });
  await seed(deployment, ADMIN_KEY, DEFAULT_FILES);
  await seed(deployment, ADMIN_KEY, OTHER_FILES, "other");
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const read = (path: string) => `CALL read ${JSON.stringify({ path })}`;
const results = (turn: Turn) => turn.items.filter((i) => i.kind === "tool_result");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(transports)("tenancy over %s", (name, connect) => {
  const t = name.toLowerCase();
  const u = (user: string) => `${user}-${t}`;
  const as = async (user: string, workspace?: string) =>
    connect(deployment, await login(deployment, user, { workspace }));

  describe("workspaces", () => {
    it("a token for one workspace is refused by another workspace's DO", async () => {
      const token = await login(deployment, u("ann"));
      await expect(openUserSessionAt(deployment, ADMIN_KEY, "other", token)).rejects.toMatchObject({
        status: 401,
      });
      await expect(openUserSessionAt(deployment, ADMIN_KEY, "default", token)).resolves.toEqual({
        opened: true,
      });
    });

    it("keeps each workspace's projects apart, even under the same name", async () => {
      for (const [workspace, files] of [
        ["default", DEFAULT_FILES],
        ["other", OTHER_FILES],
      ] as const) {
        const ann = await as(u("ann"), workspace);
        const session = await ann.startSession({ project: "shared", agent: "reader" });
        expect(session.workspace).toBe(workspace);
        const turn = await ann.sendMessage(session.id, { content: read("/shared/readme.md") });
        expect(results(turn)).toEqual([
          expect.objectContaining({ isError: false, output: files["/shared/readme.md"] }),
        ]);
      }
      // The other workspace has no "alpha": a project of one workspace is nothing in another.
      const there = await as(u("ann"), "other");
      await expect(there.startSession({ project: "alpha", agent: "x" })).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe("service accounts", () => {
    it("a workspace admin creates a service account; its API key gets access tokens", async () => {
      const wes = await as(u("wes"));
      const created = await wes.createServiceAccount({ name: `ci-${t}` });
      expect(created.user).toBe(`ci-${t}@default.svc`);
      expect(created.key).toMatch(/^swk_/);
      // Listed without its key: the key is shown once.
      const { accounts } = await wes.listServiceAccounts();
      expect(accounts).toContainEqual(
        expect.objectContaining({ name: `ci-${t}`, user: created.user }),
      );
      expect(JSON.stringify(accounts)).not.toContain(created.key);
      // Its access token is for its own workspace, and names it as its user.
      const ci = await connect(deployment, await serviceAccountToken(deployment, created.key));
      expect(await ci.me()).toMatchObject({ user: created.user, workspace: "default" });
      await expect(serviceAccountToken(deployment, `${created.key}x`)).rejects.toMatchObject({
        status: 401,
      });
    });

    it("a service account holds project roles like any user, and nothing more", async () => {
      const wes = await as(u("wes"));
      const { user, key } = await wes.createServiceAccount({ name: `bot-${t}` });
      const ci = await connect(deployment, await serviceAccountToken(deployment, key));
      // A member of no project yet: it sees nothing.
      await expect(ci.startSession({ project: "alpha", agent: "x" })).rejects.toMatchObject({
        status: 403,
      });
      await seed(deployment, ADMIN_KEY, {
        "/alpha/.system/access": JSON.stringify({ ...ACCESS, [user]: "reader" }),
      });
      const session = await ci.startSession({ project: "alpha", agent: "nightly" });
      const turn = await ci.sendMessage(session.id, { content: read("/alpha/readme.md") });
      expect(results(turn)).toEqual([
        expect.objectContaining({ isError: false, output: DEFAULT_FILES["/alpha/readme.md"] }),
      ]);
      // Its reader role lets it read, not write.
      const write = `CALL write ${JSON.stringify({ path: "/alpha/x.md", content: "x" })}`;
      const denied = await ci.sendMessage(session.id, { content: write });
      expect(results(denied)[0]).toMatchObject({ isError: true });
      await expect(ci.startSession({ project: "beta", agent: "x" })).rejects.toMatchObject({
        status: 403,
      });
    });

    it("only a workspace admin manages service accounts", async () => {
      const ann = await as(u("ann"));
      await expect(ann.createServiceAccount({ name: `nope-${t}` })).rejects.toMatchObject({
        status: 403,
      });
      await expect(ann.listServiceAccounts()).rejects.toMatchObject({ status: 403 });
    });

    it("no identity provider signs in as a service account", async () => {
      await expect(login(deployment, `ci-${t}@default.svc`)).rejects.toMatchObject({
        status: 403,
      });
    });

    it("deleting a service account refuses its key and stops renewing its tokens", async () => {
      const wes = await as(u("wes"));
      const { key } = await wes.createServiceAccount({ name: `gone-${t}` });
      const token = await serviceAccountToken(deployment, key);
      await expect(renewToken(deployment, token)).resolves.toMatch(/./);
      await wes.deleteServiceAccount(`gone-${t}`);
      await expect(serviceAccountToken(deployment, key)).rejects.toMatchObject({ status: 401 });
      await expect(renewToken(deployment, token)).rejects.toMatchObject({ status: 401 });
      expect((await wes.listServiceAccounts()).accounts.map((a) => a.name)).not.toContain(
        `gone-${t}`,
      );
    });
  });

  describe("unattended sessions", () => {
    it("starts a session unattended, as its view and the session index show", async () => {
      const bob = await as(u("bob"));
      const session = await bob.startSession({
        project: "alpha",
        agent: "nightly",
        unattended: true,
      });
      expect(session).toMatchObject({ unattended: true, revoked: false });
      const attended = await bob.startSession({ project: "alpha", agent: "daily" });
      expect(attended).toMatchObject({ unattended: false });
      const { sessions } = await bob.listSessions();
      expect(sessions.find((s) => s.id === session.id)).toMatchObject({ unattended: true });
      await expect(
        bob.startSession({ project: "alpha", agent: "x", unattended: "yes" as never }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("revocation", () => {
    it("a user revoked everywhere: the issuer stops renewing, and existing tokens expire soon", async () => {
      const token = await login(deployment, u("gus"), { ttlMs: 1500 });
      const renewed = await renewToken(deployment, token);
      expect(renewed).not.toBe(token);
      const gus = await connect(deployment, token);
      await gus.me();
      await revokeUserEverywhere(deployment, ADMIN_KEY, u("gus"));
      await expect(renewToken(deployment, token)).rejects.toMatchObject({ status: 401 });
      await expect(login(deployment, u("gus"))).rejects.toMatchObject({ status: 401 });
      // The token in hand works until it expires, about an hour in a real deployment.
      await expect(gus.listSessions()).resolves.toBeDefined();
      await sleep(1600);
      await expect(gus.listSessions()).rejects.toMatchObject({ status: 401 });
    });

    it("a user removed from a workspace loses it at their next action, and keeps the others", async () => {
      const ida = await as(u("ida"));
      const session = await ida.startSession({ project: "shared", agent: "reader" });
      const idaOther = await as(u("ida"), "other");
      const there = await idaOther.startSession({ project: "shared", agent: "reader" });
      const { [u("ida")]: _removed, ...rest } = ACCESS;
      await seed(deployment, ADMIN_KEY, {
        "/alpha/.system/access": JSON.stringify(rest),
        "/shared/.system/access": JSON.stringify(rest),
      });
      const turn = await ida.sendMessage(session.id, { content: read("/shared/readme.md") });
      expect(results(turn)).toEqual([expect.objectContaining({ isError: true })]);
      await expect(ida.startSession({ project: "shared", agent: "x" })).rejects.toMatchObject({
        status: 403,
      });
      const kept = await idaOther.sendMessage(there.id, { content: read("/shared/readme.md") });
      expect(results(kept)).toEqual([
        expect.objectContaining({ isError: false, output: OTHER_FILES["/shared/readme.md"] }),
      ]);
    });

    it("revoking an agent session stops it at its next operation, and only it", async () => {
      const bob = await as(u("bob"));
      const doomed = await bob.startSession({ project: "alpha", agent: "doomed" });
      const kept = await bob.startSession({ project: "alpha", agent: "kept" });
      expect(await bob.revokeSession(doomed.id)).toEqual({ revoked: true });
      await expect(
        bob.sendMessage(doomed.id, { content: read("/alpha/readme.md") }),
      ).rejects.toMatchObject({ status: 403 });
      // Past the User DO, the gate itself refuses the revoked capability.
      const past = await sendPastUser(deployment, ADMIN_KEY, doomed.id, read("/alpha/readme.md"));
      expect(results(past)).toEqual([
        expect.objectContaining({ isError: true, output: expect.stringMatching(/EACCES/) }),
      ]);
      const turn = await bob.sendMessage(kept.id, { content: read("/alpha/readme.md") });
      expect(results(turn)).toEqual([expect.objectContaining({ isError: false })]);
      // Another user cannot revoke it.
      const ann = await as(u("ann"));
      await expect(ann.revokeSession(kept.id)).rejects.toMatchObject({ status: 404 });
    });

    it("revoking the user session stops all its agent sessions; the next call opens a new one", async () => {
      const ann = await as(u("ann"));
      const before = await ann.me();
      const sessions = [
        await ann.startSession({ project: "alpha", agent: "one" }),
        await ann.startSession({ project: "beta", agent: "two" }),
      ];
      expect(await ann.revokeUserSession()).toEqual({ revoked: true });
      for (const s of sessions) {
        const past = await sendPastUser(
          deployment,
          ADMIN_KEY,
          s.id,
          read(`/${s.project}/readme.md`),
        );
        expect(results(past)).toEqual([expect.objectContaining({ isError: true })]);
        await expect(
          ann.sendMessage(s.id, { content: read(`/${s.project}/readme.md`) }),
        ).rejects.toMatchObject({ status: 403 });
      }
      const after = await ann.me();
      expect(after.id).not.toBe(before.id);
      const fresh = await ann.startSession({ project: "alpha", agent: "fresh" });
      const turn = await ann.sendMessage(fresh.id, { content: read("/alpha/readme.md") });
      expect(results(turn)).toEqual([expect.objectContaining({ isError: false })]);
      // The user session in another workspace is untouched.
      expect((await (await as(u("ann"), "other")).me()).workspace).toBe("other");
    });
  });
});

it("renews only a valid token, and only for the user and workspace it names", async () => {
  await expect(renewToken(deployment, "not-a-token")).rejects.toBeInstanceOf(ApiError);
  const token = await login(deployment, "renew-me", { workspace: "other" });
  const renewed = await renewToken(deployment, token);
  expect(await restClient(deployment, renewed).me()).toMatchObject({
    user: "renew-me",
    workspace: "other",
  });
  const expired = await login(deployment, "renew-me", { ttlMs: 1 });
  await sleep(5);
  await expect(renewToken(deployment, expired)).rejects.toMatchObject({ status: 401 });
});
