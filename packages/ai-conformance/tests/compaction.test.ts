// Hierarchical compaction (statewalker/statewalker-root#131, decided in #83): a long session keeps
// its context by compacting old items into summaries, while every original item is kept. The
// model is given the session's top-level summaries and the items no summary covers; the tail
// (sized by messages or by tokens) is never compacted. Run against the harness's own deployment
// (ai-host-do) on CellB Node in-process, with the scripted model, over REST and RPC: one
// deployment sizes its tail by messages, the other by tokens.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  type ModelRequest,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const TRANSPORTS = ["rest", "rpc"];

const FILES = {
  "/alpha/readme.md": "# alpha\n",
  "/alpha/.system/access": JSON.stringify(
    Object.fromEntries(TRANSPORTS.map((t) => [`ann-${t}`, "editor"])),
  ),
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
/** Tail of 2 messages, 2 messages per summary, 3 summaries before promotion. */
let byMessages: Deployment;
/** Tail of 2 tokens' worth of messages, one message per summary. */
let byTokens: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  const vars = { LLM_BASE_URL: model.url, DEV_LOGIN: "true", ADMIN_KEY };
  byMessages = await startDeployment(HOST, {
    ...vars,
    COMPACTION: JSON.stringify({
      budget_tokens: 1,
      tail_messages: 2,
      group_size: 2,
      promote_threshold: 3,
    }),
  });
  byTokens = await startDeployment(HOST, {
    ...vars,
    COMPACTION: JSON.stringify({ budget_tokens: 1, tail_tokens: 2, group_size: 1 }),
  });
  await seed(byMessages, ADMIN_KEY, FILES);
  await seed(byTokens, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await byMessages?.close();
  await byTokens?.close();
  await model?.close();
});

/** The agent requests (not the summarizer's) since `from`. */
const agentRequests = (from: number): ModelRequest[] =>
  model.requests.slice(from).filter((r) => !r.summary);

describe.each(transports)("compaction over %s", (name, connect) => {
  const t = name.toLowerCase();
  const as = async (d: Deployment) => connect(d, await login(d, `ann-${t}`));

  it("gives the model the session's summaries in place of its old items, and keeps every item", async () => {
    const ann = await as(byMessages);
    const session = await ann.startSession({ project: "alpha" });
    const words = ["one", "two", "three", "four"].map((w) => `${t}-${w}`);
    let from = 0;
    for (const w of words) {
      from = model.requests.length;
      expect(await ann.sendMessage(session.id, { content: w })).toMatchObject({
        status: "completed",
      });
    }
    // The fourth turn: the first two exchanges are summarized (two messages each), the one before
    // it is the tail.
    const [request] = agentRequests(from);
    const texts = (request?.messages ?? []).filter((m) => m.role !== "system").map((m) => m.text);
    expect(texts).toHaveLength(5);
    expect(texts[0]).toMatch(/^\[Summary of earlier messages\]/);
    expect(texts[0]).toContain(`SUMMARY[User: ${words[0]} / Assistant: OK]`);
    expect(texts[1]).toContain(`SUMMARY[User: ${words[1]} / Assistant: OK]`);
    expect(texts.slice(2)).toEqual([words[2], "OK", words[3]]);
    // Every item is still there.
    const { items } = await ann.listItems(session.id);
    expect(items.map((i) => i.text)).toEqual(words.flatMap((w) => [w, "OK"]));
    // Each summary is in the event log, with its range of items and the sections' refs.
    const { events } = await ann.readEvents(session.id, { since: 0, limit: 1000 });
    const summaries = events.filter((e) => e.type === "summary.created").map((e) => e.data);
    expect(summaries).toMatchObject([
      {
        depth: 1,
        from_seq: items[0]?.seq,
        to_seq: items[1]?.seq,
        through_turn: items[1]?.turn,
        sections: [{ refs: [items[0]?.id] }],
      },
      { depth: 1, from_seq: items[2]?.seq, to_seq: items[3]?.seq, through_turn: items[3]?.turn },
    ]);
  });

  it("promotes summaries into a deeper one as the session grows", async () => {
    const ann = await as(byMessages);
    const session = await ann.startSession({ project: "alpha" });
    for (let i = 1; i <= 5; i++) await ann.sendMessage(session.id, { content: `${t}-m${i}` });
    const { events } = await ann.readEvents(session.id, { since: 0, limit: 1000 });
    const made = events
      .filter((e) => e.type === "summary.created")
      .map((e) => e.data as { id: string; depth: number });
    expect(made.map((s) => s.depth)).toEqual([1, 1, 1, 2]);
    const from = model.requests.length;
    await ann.sendMessage(session.id, { content: `${t}-m6` });
    const texts = (agentRequests(from)[0]?.messages ?? [])
      .filter((m) => m.role !== "system")
      .map((m) => m.text);
    // The deeper summary stands for the three below it; then the next summary and the tail.
    expect(texts[0]).toMatch(/^\[Summary of earlier messages\]/);
    expect(texts[0]).toContain("SUMMARY[depth=1 / depth=1 / depth=1]");
    expect(texts[1]).toContain(`SUMMARY[User: ${t}-m4 / Assistant: OK]`);
    expect(texts.slice(2)).toEqual([`${t}-m5`, "OK", `${t}-m6`]);
  });

  it("sizes the tail by tokens when the deployment says so", async () => {
    const ann = await as(byTokens);
    const session = await ann.startSession({ project: "alpha" });
    let from = 0;
    for (const w of ["aaaa", "bbbb", "cccc"]) {
      from = model.requests.length;
      await ann.sendMessage(session.id, { content: w });
    }
    // At 4 characters a token, 2 tokens hold "bbbb" and "OK" but not "OK" before them: the tail
    // is the newest messages that fit, and each older message is a summary of its own.
    const texts = (agentRequests(from)[0]?.messages ?? [])
      .filter((m) => m.role !== "system")
      .map((m) => m.text);
    expect(texts.slice(2)).toEqual(["bbbb", "OK", "cccc"]);
    expect(texts[0]).toContain("SUMMARY[User: aaaa]");
    expect(texts[1]).toContain("SUMMARY[Assistant: OK]");
  });

  it("summarizes with no tools offered, over the session's own items only", async () => {
    const ann = await as(byMessages);
    const session = await ann.startSession({ project: "alpha" });
    const from = model.requests.length;
    for (const w of ["x1", "x2", "x3"]) await ann.sendMessage(session.id, { content: `${t}-${w}` });
    const summaries = model.requests.slice(from).filter((r) => r.summary);
    expect(summaries).not.toHaveLength(0);
    for (const r of summaries) {
      expect(r.tools).toEqual([]);
      const input = r.messages
        .filter((m) => m.role === "user")
        .map((m) => m.text)
        .join("\n");
      for (const line of input.split("\n"))
        expect(line).toMatch(new RegExp(`^\\[it-[^\\]]+\\] \\w+: (${t}-x\\d|OK)$`));
    }
  });

  it("gives the model the earlier turns' tool calls and results", async () => {
    const ann = await as(byMessages);
    const session = await ann.startSession({ project: "alpha" });
    await ann.sendMessage(session.id, { content: 'CALL read {"path":"/alpha/readme.md"}' });
    const from = model.requests.length;
    expect(await ann.sendMessage(session.id, { content: `${t}-after` })).toMatchObject({
      status: "completed",
    });
    const messages = (agentRequests(from)[0]?.messages ?? []).filter((m) => m.role !== "system");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(messages[1]?.text).toBe("CALL read");
    expect(messages[2]?.text).toContain("# alpha");
  });
});
