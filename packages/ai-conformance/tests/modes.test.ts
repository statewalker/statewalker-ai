// Modes and approvals (statewalker/statewalker-root#124, decided in #79, #89 and #96): the user
// session holds the mode; every action of every agent session is decided by the member's roles,
// then by the permission rules of the deployment, the project, the user, the agent session and the
// mode (deny beats ask, ask beats allow), at that moment. "Ask" ends the turn waiting on an
// approval, listed on /v1/me and /v1/approvals; answering it re-checks the stored action against
// the current mode and roles before running exactly that action. Run against the harness's own
// deployment (ai-host-do) on CellB Node in-process, with the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Approval,
  type ApprovalAnswer,
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  seedProfiles,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const DAY_MS = 24 * 60 * 60 * 1000;

// Each test uses its own users, suffixed by transport, so modes switched in one never reach another.
const USERS = [
  ...["ann", "bob", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo", "kit", "lee"],
  ...["mo", "ned", "oz", "pat"],
];
const TRANSPORTS = ["rest", "rpc"];

function fixtures(): Record<string, string> {
  const access: Record<string, string> = {};
  for (const t of TRANSPORTS) for (const u of USERS) access[`${u}-${t}`] = "editor";
  const files: Record<string, string> = {
    "/proj/readme.md": "# proj\n",
    "/proj/notes/existing.md": "existing\n",
    "/proj/plans/old.md": "an old plan\n",
    "/proj/.system/access": JSON.stringify(access),
    // The project's rules (in its system folder, invisible to agents).
    "/proj/.system/permission-rules": JSON.stringify({
      allow: ["files.write:/scratch/**", "files.delete:/tidy-*/**"],
      ask: ["files.write:/scratch/keep/**", "files.delete:/tidy-*/keep/**"],
      deny: ["files.delete:/guarded-*/keep.md"],
    }),
  };
  for (const t of TRANSPORTS) {
    files[`/proj/drafts-${t}/old.md`] = "an old draft\n";
    files[`/proj/guarded-${t}/keep.md`] = "keep me\n";
    files[`/proj/guarded-${t}/other.md`] = "other\n";
    files[`/proj/tidy-${t}/a.md`] = "a\n";
    files[`/proj/tidy-${t}/keep/b.md`] = "b\n";
    files[`/demote-${t}/notes/a.md`] = "a\n";
    files[`/bare-${t}/readme.md`] = "# bare\n";
    files[`/bare-${t}/.system/access`] = JSON.stringify({ [`mo-${t}`]: "editor" });
    files[`/demote-${t}/.system/access`] = JSON.stringify({ [`dan-${t}`]: "editor" });
  }
  return files;
}

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
let shortLived: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    LLM_BASE_URL: model.url,
    DEV_LOGIN: "true",
    ADMIN_KEY,
    // The deployment's rules.
    PERMISSION_RULES: JSON.stringify({ deny: ["files.write:/secret/**"] }),
  });
  await seed(deployment, ADMIN_KEY, fixtures());
  // A user's own rules, in their profile.
  await seedProfiles(
    deployment,
    ADMIN_KEY,
    Object.fromEntries(
      TRANSPORTS.map((t) => [
        `/profiles/lee-${t}/permission-rules`,
        JSON.stringify({ deny: ["files.delete"] }),
      ]),
    ),
  );
  shortLived = await startDeployment(HOST, {
    LLM_BASE_URL: model.url,
    DEV_LOGIN: "true",
    ADMIN_KEY,
    APPROVAL_TTL_MS: "400",
  });
  await seed(shortLived, ADMIN_KEY, fixtures());
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await shortLived?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const write = (path: string, content: string) => call("write", { path, content });
const bash = (command: string) => call("bash", { command });
const read = (path: string) => call("read", { path });
const toolResult = (turn: Turn) => turn.items.find((i) => i.kind === "tool_result");
/** The one approval a turn ended waiting on, as the user's approvals list it. */
const approvalOf = async (client: SessionClient, turn: Turn): Promise<Approval> => {
  expect(turn.status).toBe("waiting");
  expect(turn.stop_reason).toMatchObject({ type: "approval" });
  expect(turn.stop_reason?.approval_ids).toHaveLength(1);
  const id = turn.stop_reason?.approval_ids?.[0];
  const found = (await client.listApprovals()).approvals.find((a) => a.id === id);
  expect(found).toBeDefined();
  return found as Approval;
};
/** Answers an approval and follows the turn that continues the session to its end. */
const answer = async (client: SessionClient, id: string, a: ApprovalAnswer) => {
  const { approval, accepted } = await client.answerApproval(id, a);
  return { approval, turn: await client.waitTurn(accepted) };
};

describe.each(transports)("modes and approvals over %s", (name, connect) => {
  const t = name.toLowerCase();
  const as = async (user: string, d: Deployment = deployment) =>
    connect(d, await login(d, `${user}-${t}`));
  const contentOf = async (client: SessionClient, session: string, path: string) =>
    toolResult(await client.sendMessage(session, { content: read(path) }))?.output;

  it("ends the turn waiting on an approval when the mode asks, listed on /v1/me and /v1/approvals", async () => {
    const ann = await as("ann");
    expect((await ann.me()).mode).toBe("default");
    const s = await ann.startSession({ project: "proj", agent: "modes" });
    const turn = await ann.sendMessage(s.id, { content: write("notes/a.md", "from ann\n") });
    const approval = await approvalOf(ann, turn);
    expect(approval).toMatchObject({
      session: s.id,
      project: "proj",
      status: "pending",
      action: { method: "write", path: "/proj/notes/a.md" },
      permission: "files.write:/notes/a.md",
    });
    expect(approval.expires - approval.created).toBe(DAY_MS);
    // The turn ends at the pending call: the model is not asked again.
    expect(turn.items.map((i) => i.kind)).toEqual([
      "message",
      "tool_call",
      "tool_result",
      "approval",
    ]);
    expect(turn.items.at(-1)).toMatchObject({ approval: approval.id });
    expect((await ann.me()).approvals?.map((a) => a.id)).toEqual([approval.id]);
    expect((await ann.listApprovals()).approvals).toEqual([approval]);
    // Nothing was written.
    expect(await contentOf(ann, s.id, "notes/a.md")).toMatch(/ENOENT/);
  });

  it("approving runs exactly the stored action, once", async () => {
    const bob = await as("bob");
    const s = await bob.startSession({ project: "proj", agent: "modes" });
    const approval = await approvalOf(
      bob,
      await bob.sendMessage(s.id, { content: write("notes/b.md", "stored\n") }),
    );
    const answered = await answer(bob, approval.id, { decision: "allow", scope: "once" });
    expect(answered.approval).toMatchObject({ id: approval.id, status: "allowed" });
    expect(answered.turn.status).toBe("completed");
    expect(toolResult(answered.turn)).toMatchObject({ isError: false, approval: approval.id });
    expect(await contentOf(bob, s.id, "notes/b.md")).toBe("stored\n");
    expect((await bob.me()).approvals).toEqual([]);
    // Answered once: a second answer is refused, and the same write asks again.
    await expect(
      bob.answerApproval(approval.id, { decision: "allow", scope: "once" }),
    ).rejects.toMatchObject({ status: 400 });
    const again = await approvalOf(
      bob,
      await bob.sendMessage(s.id, { content: write("notes/b.md", "stored\n") }),
    );
    expect(again.id).toBe(approval.id);
    expect(again.status).toBe("pending");
  });

  it("denying returns the user's message to the model and writes nothing", async () => {
    const cy = await as("cy");
    const s = await cy.startSession({ project: "proj", agent: "modes" });
    const approval = await approvalOf(
      cy,
      await cy.sendMessage(s.id, { content: write("notes/c.md", "no\n") }),
    );
    const answered = await answer(cy, approval.id, {
      decision: "deny",
      scope: "once",
      message: "not there, please",
    });
    expect(answered.approval.status).toBe("denied");
    expect(toolResult(answered.turn)).toMatchObject({ isError: true });
    expect(toolResult(answered.turn)?.output).toMatch(/not there, please/);
    expect(await contentOf(cy, s.id, "notes/c.md")).toMatch(/ENOENT/);
  });

  it("a repeated identical action waits on the same approval", async () => {
    const dee = await as("dee");
    const s = await dee.startSession({ project: "proj", agent: "modes" });
    const first = await approvalOf(
      dee,
      await dee.sendMessage(s.id, { content: write("notes/d.md", "x\n") }),
    );
    const second = await approvalOf(
      dee,
      await dee.sendMessage(s.id, { content: write("notes/d.md", "x\n") }),
    );
    expect(second.id).toBe(first.id);
    const other = await approvalOf(
      dee,
      await dee.sendMessage(s.id, { content: write("notes/d.md", "y\n") }),
    );
    expect(other.id).not.toBe(first.id);
    expect((await dee.listApprovals()).approvals.map((a) => a.id).sort()).toEqual(
      [first.id, other.id].sort(),
    );
  });

  it("mkdir -p of an existing folder does not ask", async () => {
    const eli = await as("eli");
    const s = await eli.startSession({ project: "proj", agent: "modes" });
    const turn = await eli.sendMessage(s.id, { content: bash("mkdir -p /proj/notes") });
    expect(turn.status).toBe("completed");
    expect(turn.stop_reason).toMatchObject({ type: "end_turn" });
    const fresh = await eli.sendMessage(s.id, { content: bash("mkdir -p /proj/fresh") });
    expect((await approvalOf(eli, fresh)).action).toMatchObject({
      method: "mkdir",
      path: "/proj/fresh",
    });
  });

  it("a mode switch reaches a running session at its next action", async () => {
    const fay = await as("fay");
    const s = await fay.startSession({ project: "proj", agent: "modes" });
    await approvalOf(fay, await fay.sendMessage(s.id, { content: write("notes/f.md", "1\n") }));

    expect(await fay.setMode({ mode: "acceptEdits" })).toMatchObject({ mode: "acceptEdits" });
    expect((await fay.me()).mode).toBe("acceptEdits");
    const edited = await fay.sendMessage(s.id, { content: write("notes/f.md", "2\n") });
    expect(edited.status).toBe("completed");
    expect(await contentOf(fay, s.id, "notes/f.md")).toBe("2\n");
    // acceptEdits still asks about deletes.
    await approvalOf(fay, await fay.sendMessage(s.id, { content: bash("rm /proj/notes/f.md") }));

    await fay.setMode({ mode: "plan" });
    const planned = await fay.sendMessage(s.id, { content: write("plans/p.md", "plan\n") });
    expect(planned.status).toBe("completed");
    const outside = await approvalOf(
      fay,
      await fay.sendMessage(s.id, { content: write("notes/f.md", "3\n") }),
    );
    expect(outside.reason).toMatch(/plan mode writes only in \/plans.*widen.*switch/);

    await fay.setMode({ mode: "dontAsk" });
    const denied = await fay.sendMessage(s.id, { content: write("notes/f.md", "4\n") });
    expect(denied.status).toBe("completed");
    expect(toolResult(denied)).toMatchObject({ isError: true });
    expect(toolResult(denied)?.output).toMatch(/EACCES/);

    await fay.setMode({ mode: "bypassPermissions" });
    const removed = await fay.sendMessage(s.id, { content: bash("rm /proj/notes/f.md") });
    expect(removed.status).toBe("completed");
    expect(await contentOf(fay, s.id, "notes/f.md")).toMatch(/ENOENT/);

    // auto is default until the risk classifier.
    await fay.setMode({ mode: "auto" });
    await approvalOf(fay, await fay.sendMessage(s.id, { content: write("notes/f.md", "5\n") }));
  });

  it("only the user switches modes, to a mode that exists, for their own sessions", async () => {
    const gus = await as("gus");
    const hal = await as("hal");
    await expect(gus.setMode({ mode: "yolo" })).rejects.toMatchObject({ status: 400 });
    await expect(
      (await connect(deployment, "")).setMode({ mode: "dontAsk" }),
    ).rejects.toMatchObject({ status: 401 });
    await gus.setMode({ mode: "bypassPermissions" });
    const s = await hal.startSession({ project: "proj", agent: "modes" });
    expect((await hal.me()).mode).toBe("default");
    await approvalOf(hal, await hal.sendMessage(s.id, { content: write("notes/h.md", "h\n") }));
  });

  it("approving re-checks the stored action against the current mode", async () => {
    const ivy = await as("ivy");
    const s = await ivy.startSession({ project: "proj", agent: "modes" });
    const approval = await approvalOf(
      ivy,
      await ivy.sendMessage(s.id, { content: write("notes/i.md", "i\n") }),
    );
    await ivy.setMode({ mode: "dontAsk" });
    const answered = await answer(ivy, approval.id, { decision: "allow", scope: "once" });
    expect(toolResult(answered.turn)).toMatchObject({ isError: true });
    expect(toolResult(answered.turn)?.output).toMatch(/EACCES/);
    await ivy.setMode({ mode: "default" });
    expect(await contentOf(ivy, s.id, "notes/i.md")).toMatch(/ENOENT/);
  });

  it("approving re-checks the stored action against the user's current role", async () => {
    const project = `demote-${t}`;
    const dan = await as("dan");
    const s = await dan.startSession({ project, agent: "modes" });
    const approval = await approvalOf(
      dan,
      await dan.sendMessage(s.id, { content: write("notes/a.md", "changed\n") }),
    );
    await seed(deployment, ADMIN_KEY, {
      [`/${project}/.system/access`]: JSON.stringify({ [`dan-${t}`]: "reader" }),
    });
    const answered = await answer(dan, approval.id, { decision: "allow", scope: "once" });
    expect(toolResult(answered.turn)?.output).toMatch(/EACCES/);
    expect(await contentOf(dan, s.id, "notes/a.md")).toBe("a\n");
  });

  it("approving for the session lets the same action on the same target run for the rest of it", async () => {
    const jo = await as("jo");
    const s = await jo.startSession({ project: "proj", agent: "modes" });
    const approval = await approvalOf(
      jo,
      await jo.sendMessage(s.id, { content: write("notes/j.md", "1\n") }),
    );
    await answer(jo, approval.id, { decision: "allow", scope: "session" });
    expect(await contentOf(jo, s.id, "notes/j.md")).toBe("1\n");
    const later = await jo.sendMessage(s.id, { content: write("notes/j.md", "2\n") });
    expect(later.status).toBe("completed");
    expect(await contentOf(jo, s.id, "notes/j.md")).toBe("2\n");
    // Another target, or another session, still asks.
    await approvalOf(jo, await jo.sendMessage(s.id, { content: write("notes/other.md", "x\n") }));
    const s2 = await jo.startSession({ project: "proj", agent: "modes" });
    await approvalOf(jo, await jo.sendMessage(s2.id, { content: write("notes/j.md", "3\n") }));
  });

  it("decides by the rules of the deployment, the project, the user and the mode: deny beats ask, ask beats allow", async () => {
    const kit = await as("kit");
    const s = await kit.startSession({ project: "proj", agent: "modes" });
    // The project allows writes in /scratch, and asks in /scratch/keep (ask beats allow).
    expect((await kit.sendMessage(s.id, { content: write("scratch/a.md", "a\n") })).status).toBe(
      "completed",
    );
    await approvalOf(
      kit,
      await kit.sendMessage(s.id, { content: write("scratch/keep/a.md", "a\n") }),
    );
    // The deployment denies /secret, even where the mode never asks.
    await kit.setMode({ mode: "bypassPermissions" });
    const secret = await kit.sendMessage(s.id, { content: write("secret/a.md", "a\n") });
    expect(toolResult(secret)?.output).toMatch(/EACCES/);
    // bypassPermissions turns the project's ask into an allow.
    expect(
      (await kit.sendMessage(s.id, { content: write("scratch/keep/a.md", "a\n") })).status,
    ).toBe("completed");
    // lee's own rules deny deletes.
    const lee = await as("lee");
    await lee.setMode({ mode: "bypassPermissions" });
    const ls = await lee.startSession({ project: "proj", agent: "modes" });
    const removed = await lee.sendMessage(ls.id, { content: bash("rm /proj/readme.md") });
    expect(removed.status).toBe("completed");
    expect(await contentOf(lee, ls.id, "readme.md")).toBe("# proj\n");
  });

  it("never lets an agent remove its project's folder, even where the mode never asks", async () => {
    const mo = await as("mo");
    await mo.setMode({ mode: "bypassPermissions" });
    // A project with no rules of its own: only the gate's own guard stands in the way.
    const s = await mo.startSession({ project: `bare-${t}`, agent: "modes" });
    const turn = await mo.sendMessage(s.id, { content: bash(`rm -r /bare-${t}`) });
    expect(turn.status).toBe("completed");
    expect(toolResult(turn)?.output).toMatch(/EACCES/);
    expect(await contentOf(mo, s.id, "readme.md")).toBe("# bare\n");
  });

  it("decides a folder's removal by every entry inside it: a denied or asking file inside denies or asks", async () => {
    const ned = await as("ned");
    await ned.setMode({ mode: "bypassPermissions" });
    const s = await ned.startSession({ project: "proj", agent: "modes" });
    const denied = await ned.sendMessage(s.id, { content: bash(`rm -r /proj/guarded-${t}`) });
    expect(toolResult(denied)?.output).toMatch(/EACCES/);
    expect(await contentOf(ned, s.id, `guarded-${t}/keep.md`)).toBe("keep me\n");
    expect(await contentOf(ned, s.id, `guarded-${t}/other.md`)).toBe("other\n");
    await ned.setMode({ mode: "default" });
    const asked = await approvalOf(
      ned,
      await ned.sendMessage(s.id, { content: bash(`rm -r /proj/tidy-${t}`) }),
    );
    expect(asked.action).toMatchObject({ method: "remove", path: `/proj/tidy-${t}` });
    expect(await contentOf(ned, s.id, `tidy-${t}/keep/b.md`)).toBe("b\n");
    await answer(ned, asked.id, { decision: "allow", scope: "once" });
    expect(await contentOf(ned, s.id, `tidy-${t}/keep/b.md`)).toMatch(/ENOENT/);
  });

  it("approving a folder for the session never covers the files later written inside it", async () => {
    const oz = await as("oz");
    const s = await oz.startSession({ project: "proj", agent: "modes" });
    const made = await approvalOf(
      oz,
      await oz.sendMessage(s.id, { content: bash(`mkdir /proj/src-${t}`) }),
    );
    await answer(oz, made.id, { decision: "allow", scope: "session" });
    await approvalOf(
      oz,
      await oz.sendMessage(s.id, { content: write(`src-${t}/run.sh`, "echo hi\n") }),
    );
  });

  it("asks about a move, keyed by source and target, and approving runs exactly that move", async () => {
    const pat = await as("pat");
    const s = await pat.startSession({ project: "proj", agent: "modes" });
    const moved = await approvalOf(
      pat,
      await pat.sendMessage(s.id, {
        content: bash(`mv /proj/drafts-${t}/old.md /proj/drafts-${t}/new.md`),
      }),
    );
    expect(moved.action).toMatchObject({
      method: "move",
      path: `/proj/drafts-${t}/old.md`,
      target: `/proj/drafts-${t}/new.md`,
    });
    const other = await approvalOf(
      pat,
      await pat.sendMessage(s.id, {
        content: bash(`mv /proj/drafts-${t}/old.md /proj/drafts-${t}/x.md`),
      }),
    );
    expect(other.id).not.toBe(moved.id);
    const answered = await answer(pat, moved.id, { decision: "allow", scope: "once" });
    expect(toolResult(answered.turn)).toMatchObject({ isError: false });
    expect(await contentOf(pat, s.id, `drafts-${t}/new.md`)).toBe("an old draft\n");
  });

  it("an approval is answered only by its own user", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "proj", agent: "modes" });
    const approval = await approvalOf(
      ann,
      await ann.sendMessage(s.id, { content: write("notes/mine.md", "m\n") }),
    );
    const bob = await as("bob");
    await expect(
      bob.answerApproval(approval.id, { decision: "allow", scope: "once" }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await bob.listApprovals()).approvals.map((a) => a.id)).not.toContain(approval.id);
    await expect(
      ann.answerApproval(approval.id, { decision: "maybe" as never, scope: "once" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("approvals expire after their time and then count as denied", async () => {
    const ann = await as("ann", shortLived);
    const s = await ann.startSession({ project: "proj", agent: "modes" });
    const approval = await approvalOf(
      ann,
      await ann.sendMessage(s.id, { content: write("notes/late.md", "late\n") }),
    );
    expect(approval.expires - approval.created).toBe(400);
    await new Promise((ok) => setTimeout(ok, 600));
    expect((await ann.me()).approvals).toEqual([]);
    expect((await ann.listApprovals()).approvals).toMatchObject([
      { id: approval.id, status: "expired" },
    ]);
    await expect(
      ann.answerApproval(approval.id, { decision: "allow", scope: "once" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await contentOf(ann, s.id, "notes/late.md")).toMatch(/ENOENT/);
  });
});
