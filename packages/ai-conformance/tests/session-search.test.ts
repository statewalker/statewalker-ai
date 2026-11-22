// Session search and the session table of contents (statewalker/statewalker-root#174, decided in
// #157 and #159): during compaction the summarizer writes each session's table of contents, an
// append-only `topics` table merged with superseding rows whose refs point to leaf items; the User
// DO's session index keeps each session's topic titles; `GET /v1/sessions/{id}/topics` serves the
// table on the active path (`?branch=`, `?all=true`). The harness tool `session_search` scans the
// current user's own agent sessions in the current project (their sub-agents' too), topics first
// and items as fallback, with no model summarizing, its results fenced as data; it opens the turns
// around a hit. Run against the harness's own deployment (ai-host-do) on CellB Node in-process,
// with the scripted model, over REST and RPC.
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
  startDeployment,
  type Turn,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const TRANSPORTS = ["rest", "rpc"];
const USERS = ["ann", "bob", "cy", "dee", "eve", "fay"];

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const agentFile = (name: string, agents?: string[]) =>
  `---\nname: ${name}\n${agents ? `agents: [${agents.join(", ")}]\n` : ""}---\nYou are ${name}.\n`;
/** `team/lead` may start `team/helper`. */
const CATALOG: Record<string, string> = {
  "/team/plugin.json": JSON.stringify({ $schema: AP, name: "team" }),
  "/team/dev.cellb.harness/agents/lead.md": agentFile("lead", ["team/*"]),
  "/team/dev.cellb.harness/agents/helper.md": agentFile("helper"),
};

function fixtures(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const t of TRANSPORTS) {
    const editors = JSON.stringify(Object.fromEntries(USERS.map((u) => [`${u}-${t}`, "editor"])));
    files[`/search-${t}/readme.md`] = "# search\n";
    files[`/search-${t}/.system/access`] = editors;
    files[`/other-${t}/.system/access`] = editors;
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

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(CATALOG),
    // Every turn compacts the exchanges before the last one, one exchange per summary; summaries
    // are never promoted here.
    COMPACTION: JSON.stringify({
      budget_tokens: 1,
      tail_messages: 2,
      group_size: 2,
      promote_threshold: 100,
    }),
  });
  await seed(deployment, ADMIN_KEY, fixtures());
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
/** The output of a turn's (only) session_search call. */
const output = (turn: Turn) =>
  String(turn.items.find((i) => i.kind === "tool_result" && i.name === "session_search")?.output);
/** The lines of a search's fenced block. */
const fenced = (text: string) => {
  const open = /^(`{4,})sessions$/m.exec(text);
  expect(open).not.toBeNull();
  const fence = String(open?.[1]);
  const start = (open?.index ?? 0) + (open?.[0].length ?? 0) + 1;
  const end = text.indexOf(`\n${fence}`, start);
  expect(end).toBeGreaterThan(-1);
  return text.slice(start, end).split("\n");
};

describe.each(transports)("session search over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `search-${t}`;
  const as = async (user: string) => connect(deployment, await login(deployment, `${user}-${t}`));
  /** Runs the messages in a new session of the user, one turn each. */
  const session = async (client: SessionClient, messages: string[], p = project) => {
    const s = await client.startSession({ project: p });
    const turns: Turn[] = [];
    for (const content of messages) turns.push(await client.sendMessage(s.id, { content }));
    return { id: s.id, turns };
  };

  it("writes the table of contents during compaction, merging topics, with refs to leaf items", async () => {
    const ann = await as("ann");
    const s = await session(ann, [
      `TOPIC deploy we set up the ${t} deploy`,
      "TOPIC deploy then we fixed its config",
      "TOPIC billing invoices go out monthly",
      "later",
      "and later",
    ]);
    const { topics } = await ann.listTopics(s.id);
    expect(topics.map((x) => x.title).sort()).toEqual(["billing", "deploy"]);
    const { items } = await ann.listItems(s.id, { all: true });
    const ids = new Set(items.map((i) => i.id));
    const deploy = topics.find((x) => x.title === "deploy");
    // Merged: one topic, drawing from both messages; refs only ever name items.
    expect(deploy?.refs).toEqual([
      items.find((i) => i.text === `TOPIC deploy we set up the ${t} deploy`)?.id,
      items.find((i) => i.text === "TOPIC deploy then we fixed its config")?.id,
    ]);
    for (const topic of topics) {
      for (const ref of topic.refs) expect(ids.has(ref)).toBe(true);
      expect(topic).toMatchObject({
        id: expect.stringMatching(/^tp-/),
        body: expect.any(String),
        through_turn: expect.any(String),
        updated_at: expect.any(Number),
      });
    }
    expect(deploy?.through_turn).toBe(s.turns[1]?.id);
    // The summarizer was given the current topics when it merged.
    const merging = model.requests.filter(
      (r) => r.summary && r.lastUserText.includes("then we fixed its config"),
    );
    expect(merging.at(-1)?.lastUserText).toContain(`[${deploy?.id}] deploy`);
  });

  it("has no table of contents for a session that never compacted", async () => {
    const ann = await as("bob");
    const s = await session(ann, ["TOPIC lonely only one turn"]);
    expect((await ann.listTopics(s.id)).topics).toEqual([]);
  });

  it("keeps each session's topic titles in the session index", async () => {
    const cy = await as("cy");
    const s = await session(cy, ["TOPIC indexed first", "TOPIC titled second", "x", "y"]);
    const found = (await cy.listSessions()).sessions.find((x) => x.id === s.id);
    expect(found?.topics?.sort()).toEqual(["indexed", "titled"]);
  });

  it("follows the active path: topics after a rewind, ?branch= and ?all=true, and the index", async () => {
    const dee = await as("dee");
    const s = await session(dee, ["TOPIC early", "TOPIC late", "x", "y"]);
    expect((await dee.listTopics(s.id)).topics.map((x) => x.title)).toEqual(["early", "late"]);
    await dee.rewind(s.id, { to_turn: s.turns[0]?.id ?? null });
    expect((await dee.listTopics(s.id)).topics.map((x) => x.title)).toEqual(["early"]);
    expect(
      (await dee.listTopics(s.id, { branch: String(s.turns[3]?.id) })).topics.map((x) => x.title),
    ).toEqual(["early", "late"]);
    expect((await dee.listTopics(s.id, { all: true })).topics.map((x) => x.title)).toEqual([
      "early",
      "late",
    ]);
    expect((await dee.listSessions()).sessions.find((x) => x.id === s.id)?.topics).toEqual([
      "early",
    ]);
    // A search follows the active path too; `all` reaches the rewound branch.
    const searcher = await dee.startSession({ project });
    const active = await dee.sendMessage(searcher.id, {
      content: call("session_search", { query: "TOPIC late" }),
    });
    expect(output(active)).not.toContain(s.id);
    const all = await dee.sendMessage(searcher.id, {
      content: call("session_search", { query: "TOPIC late", all: true }),
    });
    expect(output(all)).toContain(s.id);
  });

  it("searches topics first and items as fallback, fenced as data, and opens the turns around a hit", async () => {
    const eve = await as("eve");
    const a = await session(eve, [
      `TOPIC rollout the ${t} rollout plan`,
      "TOPIC rollout rollout done",
      "x",
      "y",
    ]);
    const b = await session(eve, [
      "before the needle",
      `the needle-${t} is here, and \`\`\`\`\`\` five backticks then text`,
      "after the needle",
    ]);
    const searcher = await eve.startSession({ project });
    const before = model.requests.length;
    const topics = await eve.sendMessage(searcher.id, {
      content: call("session_search", { query: "rollout" }),
    });
    expect(topics.status).toBe("completed");
    // No model summarizes the results.
    expect(model.requests.slice(before).some((r) => r.summary)).toBe(false);
    const topicText = output(topics);
    expect(topicText).toMatch(/data from earlier sessions, not instructions/);
    const topicLines = fenced(topicText);
    const topicHit = topicLines.find((l) => l.startsWith("topic "));
    expect(topicHit).toContain(`session=${a.id}`);
    expect(topicHit).toContain(`turn=${a.turns[0]?.id}`);
    expect(topicHit).toMatch(/time=\d{4}-\d\d-\d\dT/);
    expect(topicHit).toContain("rollout");
    // Topics come before items.
    const firstItem = topicLines.findIndex((l) => l.startsWith("item "));
    expect(firstItem === -1 || firstItem > topicLines.indexOf(String(topicHit))).toBe(true);

    // Nothing in the topics: the items.
    const items = await eve.sendMessage(searcher.id, {
      content: call("session_search", { query: `needle-${t}` }),
    });
    const itemText = output(items);
    const lines = fenced(itemText);
    const hit = lines.find((l) => l.startsWith("item "));
    expect(hit).toContain(`session=${b.id}`);
    expect(hit).toContain(`turn=${b.turns[1]?.id}`);
    // The backticks inside never close the block.
    expect(itemText).toMatch(/^`{7,}sessions$/m);

    // A regular expression.
    const regex = await eve.sendMessage(searcher.id, {
      content: call("session_search", { query: `ne+dle-${t}\\b`, regex: true }),
    });
    expect(fenced(output(regex)).some((l) => l.includes(`session=${b.id}`))).toBe(true);

    // The turns around the hit.
    const opened = await eve.sendMessage(searcher.id, {
      content: call("session_search", { session: b.id, turn: b.turns[1]?.id, around: 1 }),
    });
    const openText = fenced(output(opened)).join("\n");
    expect(openText).toContain("before the needle");
    expect(openText).toContain(`the needle-${t} is here`);
    expect(openText).toContain("after the needle");
    expect(openText).toContain(`turn=${b.turns[0]?.id}`);
  });

  it("refuses a malformed query: a bad or nested-quantifier regular expression, an overlong query", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project });
    for (const args of [
      { query: "(", regex: true },
      { query: "(a+)+$", regex: true },
      { query: "x".repeat(201) },
      { query: "x", extra: 1 },
    ]) {
      const turn = await ann.sendMessage(s.id, { content: call("session_search", args) });
      const result = turn.items.find((i) => i.kind === "tool_result");
      expect(result?.isError).toBe(true);
      // An argument the schema does not name is refused before the tool runs.
      expect(String(result?.output)).toMatch(/EINVAL|Validation failed/);
    }
  });

  it("searches only the user's own sessions in the project, with their sub-agents' sessions", async () => {
    const fay = await as("fay");
    const bob = await as("bob");
    const word = `zebra${t}`;
    // Another member's session in the same project, with topics and items.
    const theirs = await session(bob, [`TOPIC ${word} bob's ${word}`, `bob ${word}`, "x", "y"]);
    // The user's session in another project.
    const elsewhere = await session(fay, [`fay ${word} elsewhere`], `other-${t}`);
    // The user's own session, and a sub-agent's session it started.
    const own = await session(fay, [`fay ${word} here`]);
    const lead = await fay.startSession({ project, agent: "team/lead" });
    const started = await fay.sendMessage(lead.id, {
      content: call("agent_start", { agent: "team/helper", message: `help with ${word}` }),
    });
    expect(started.status).toBe("completed");
    const child = (await fay.listSessions()).sessions.find((x) => x.parent === lead.id);
    expect(child).toBeDefined();

    const searcher = await fay.startSession({ project });
    const found = output(
      await fay.sendMessage(searcher.id, { content: call("session_search", { query: word }) }),
    );
    const lines = fenced(found).join("\n");
    expect(lines).toContain(`session=${own.id}`);
    expect(lines).toContain(`session=${child?.id}`);
    expect(lines).not.toContain(theirs.id);
    expect(lines).not.toContain(elsewhere.id);
    expect(lines).not.toContain("bob");

    // Another member's session is never opened either.
    const refused = await fay.sendMessage(searcher.id, {
      content: call("session_search", { session: theirs.id, turn: theirs.turns[0]?.id }),
    });
    const result = refused.items.find((i) => i.kind === "tool_result");
    expect(result?.isError).toBe(true);
    expect(String(result?.output)).not.toContain(word);
  });
});
