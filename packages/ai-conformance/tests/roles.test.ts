// Roles, custom roles and role sources (statewalker/statewalker-root#123, decided in #77): a role
// is a set of `area.action[:target]` permissions with targets relative to the project; custom
// roles compose with `role:`; Datalog in a role only narrows; both role sources (the workspace's
// SQL and each project's access file) work, chained; and a demotion reaches a running session at
// its next action. Run against the harness's own deployment (ai-host-do) on CellB Node
// in-process, with the scripted model, over REST and RPC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  setAccess,
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const CUSTOM_ROLES = {
  reviewer: "role:reader, comments.write",
  "public-reader": ["files.read:/public/**"],
  limited: ["role:reviewer", 'check if target($t), !$t.starts_with("/private");'],
  sneaky: ['grant_any("files", "read");', "grant_any($a, $c) <- operation($a, $c);"],
  odd: ["frobs.read", "files.zap", "*.*.*", "files.read:/public/**"],
  a: ["role:b", "files.read"],
  b: ["role:a"],
};
const PROJECT_FILES = {
  "readme.md": "# the readme\n",
  "public/a.md": "public text\n",
  "private/p.md": "private text\n",
};

// Each transport gets its own projects ("files-rest", "files-rpc"), so demotions in one run
// never reach the other.
function fixtures(t: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const project of [
    `files-${t}`,
    `sql-${t}`,
    `both-${t}`,
    `demote-file-${t}`,
    `demote-sql-${t}`,
  ])
    for (const [path, text] of Object.entries(PROJECT_FILES)) files[`/${project}/${path}`] = text;
  files[`/files-${t}/.system/access`] = JSON.stringify({
    ann: "reader",
    rita: "reviewer",
    pat: "public-reader",
    lim: "limited",
    sly: "sneaky",
    odd: ["odd"],
    cyc: "a",
  });
  files[`/files-${t}/.system/roles`] = JSON.stringify(CUSTOM_ROLES);
  files[`/both-${t}/.system/access`] = JSON.stringify({ ann: "owner" });
  files[`/demote-file-${t}/.system/access`] = JSON.stringify({ dan: "editor" });
  files[`/demote-file-${t}/.system/roles`] = JSON.stringify(CUSTOM_ROLES);
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

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    LLM_BASE_URL: model.url,
    DEV_LOGIN: "true",
    ADMIN_KEY,
    // The workspace's SQL first, then each project's access file.
    ROLE_SOURCES: "sql,file",
  });
  for (const [name] of transports) {
    const t = name.toLowerCase();
    await seed(deployment, ADMIN_KEY, fixtures(t));
    await setAccess(deployment, ADMIN_KEY, {
      project: `sql-${t}`,
      members: { ann: ["reader"], pat: ["public-reader"] },
      roles: { "public-reader": ["files.read:/public/**"] },
    });
    await setAccess(deployment, ADMIN_KEY, { project: `both-${t}`, members: { bob: ["owner"] } });
    await setAccess(deployment, ADMIN_KEY, {
      project: `demote-sql-${t}`,
      members: { dan: ["editor"] },
      roles: { "public-reader": ["files.read:/public/**"] },
    });
  }
  // Workspace admins: carol in the workspace's own access file, dave in its SQL.
  await seed(deployment, ADMIN_KEY, { "/.system/access": JSON.stringify({ carol: "admin" }) });
  await setAccess(deployment, ADMIN_KEY, { workspaceRoles: { dave: ["admin"] } });
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const read = (path: string) => `CALL read ${JSON.stringify({ path })}`;
const toolResult = (turn: Turn) => turn.items.find((i) => i.kind === "tool_result");

describe.each(transports)("roles over %s", (name, connect) => {
  const t = name.toLowerCase();
  const as = async (user: string) => connect(deployment, await login(deployment, user));
  /** Starts a session for the user in the project; reading a path returns the tool's result. */
  const session = async (user: string, project: string) => {
    const client = await as(user);
    const s = await client.startSession({ project, agent: "roles" });
    return async (path: string) =>
      toolResult(await client.sendMessage(s.id, { content: read(path) }));
  };
  const allowed = (text: string) => expect.objectContaining({ isError: false, output: text });
  const refused = expect.objectContaining({
    isError: true,
    output: expect.stringMatching(/EACCES/),
  });
  // A project the user is no member of is not there at all (statewalker/statewalker-root#122).
  const absent = expect.objectContaining({
    isError: true,
    output: expect.stringMatching(/ENOENT/),
  });

  it("grants the built-in roles' permissions, and custom roles composed with role:", async () => {
    const project = `files-${t}`;
    expect(await (await session("ann", project))("readme.md")).toEqual(
      allowed(PROJECT_FILES["readme.md"]),
    );
    expect(await (await session("rita", project))("readme.md")).toEqual(
      allowed(PROJECT_FILES["readme.md"]),
    );
  });

  it("narrows a session to a custom role's targets, relative to the project", async () => {
    const project = `files-${t}`;
    const readAs = await session("pat", project);
    expect(await readAs("public/a.md")).toEqual(allowed(PROJECT_FILES["public/a.md"]));
    expect(await readAs(`/${project}/public/a.md`)).toEqual(allowed(PROJECT_FILES["public/a.md"]));
    expect(await readAs("readme.md")).toEqual(refused);
    expect(await readAs(`/${project}/private/p.md`)).toEqual(refused);
    expect(await readAs("public/../readme.md")).toEqual(refused);
  });

  it("lets Datalog in a role only narrow: a check narrows, a fact or rule grants nothing", async () => {
    const project = `files-${t}`;
    const limited = await session("lim", project);
    expect(await limited("readme.md")).toEqual(allowed(PROJECT_FILES["readme.md"]));
    expect(await limited("private/p.md")).toEqual(refused);
    const sneaky = await session("sly", project);
    expect(await sneaky("readme.md")).toEqual(refused);
    expect(await sneaky("public/a.md")).toEqual(refused);
  });

  it("ignores unknown permissions and grants nothing through a cycle of roles", async () => {
    const project = `files-${t}`;
    const odd = await session("odd", project);
    expect(await odd("public/a.md")).toEqual(allowed(PROJECT_FILES["public/a.md"]));
    expect(await odd("readme.md")).toEqual(refused);
    await expect((await as("cyc")).startSession({ project, agent: "roles" })).rejects.toMatchObject(
      {
        status: 403,
      },
    );
  });

  it("answers members and custom roles from the workspace's SQL", async () => {
    const project = `sql-${t}`;
    expect(await (await session("ann", project))("readme.md")).toEqual(
      allowed(PROJECT_FILES["readme.md"]),
    );
    const pat = await session("pat", project);
    expect(await pat("public/a.md")).toEqual(allowed(PROJECT_FILES["public/a.md"]));
    expect(await pat("readme.md")).toEqual(refused);
    await expect((await as("eve")).startSession({ project, agent: "roles" })).rejects.toMatchObject(
      {
        status: 403,
      },
    );
  });

  it("answers a project from the first role source in the chain that knows it", async () => {
    const project = `both-${t}`;
    // The access file names ann, but the workspace's SQL comes first and names only bob.
    await expect((await as("ann")).startSession({ project, agent: "roles" })).rejects.toMatchObject(
      {
        status: 403,
      },
    );
    expect(await (await session("bob", project))("readme.md")).toEqual(
      allowed(PROJECT_FILES["readme.md"]),
    );
  });

  it("a workspace admin is no member of a project and cannot open a session in it", async () => {
    for (const admin of ["carol", "dave"])
      for (const project of [`files-${t}`, `sql-${t}`])
        await expect(
          (await as(admin)).startSession({ project, agent: "roles" }),
        ).rejects.toMatchObject({
          status: 403,
        });
  });

  it("a demotion in the access file reaches a running session at its next action, without rebuilding its tool set", async () => {
    const project = `demote-file-${t}`;
    const dan = await as("dan");
    const s = await dan.startSession({ project, agent: "roles" });
    const before = toolResult(await dan.sendMessage(s.id, { content: read("readme.md") }));
    expect(before).toEqual(allowed(PROJECT_FILES["readme.md"]));
    const toolsBefore = model.requests.at(-2)?.tools;
    expect(toolsBefore).toContain("read");

    await seed(deployment, ADMIN_KEY, {
      [`/${project}/.system/access`]: JSON.stringify({ dan: "public-reader" }),
    });
    const demoted = await dan.sendMessage(s.id, { content: read("readme.md") });
    expect(toolResult(demoted)).toEqual(refused);
    expect(JSON.stringify(demoted)).not.toContain(PROJECT_FILES["readme.md"]);
    // The model is offered the same tools: the call is refused, the tool set stays.
    expect(model.requests.at(-2)?.tools).toEqual(toolsBefore);
    expect(toolResult(await dan.sendMessage(s.id, { content: read("public/a.md") }))).toEqual(
      allowed(PROJECT_FILES["public/a.md"]),
    );

    await seed(deployment, ADMIN_KEY, { [`/${project}/.system/access`]: JSON.stringify({}) });
    expect(toolResult(await dan.sendMessage(s.id, { content: read("public/a.md") }))).toEqual(
      absent,
    );
  });

  it("a demotion or removal in the workspace's SQL reaches a running session at its next action", async () => {
    const project = `demote-sql-${t}`;
    const dan = await as("dan");
    const s = await dan.startSession({ project, agent: "roles" });
    const next = async (path: string) =>
      toolResult(await dan.sendMessage(s.id, { content: read(path) }));
    expect(await next("readme.md")).toEqual(allowed(PROJECT_FILES["readme.md"]));
    await setAccess(deployment, ADMIN_KEY, { project, members: { dan: ["public-reader"] } });
    expect(await next("readme.md")).toEqual(refused);
    expect(await next("public/a.md")).toEqual(allowed(PROJECT_FILES["public/a.md"]));
    await setAccess(deployment, ADMIN_KEY, { project, members: { dan: [] } });
    expect(await next("public/a.md")).toEqual(absent);
  });
});
