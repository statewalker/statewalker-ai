// The OpenAI projection (statewalker/statewalker-root#138, decided in #71, #83 and #159): existing
// OpenAI clients drive harness agents unchanged, pointed at an agent's base URL
// `/v1/projects/<project>/agents/<agent>/`. A Conversation is an agent session and a Response a
// turn; `model` is a real model, honoured within the caller's rights; `previous_response_id`
// naming an earlier response moves the head there and sends (an implicit rewind that reverts no
// file); "ask" is an `mcp_approval_request` answered by an `mcp_approval_response`; Chat
// Completions is stateless, with "ask" a deny with a reason. Run against the harness's own
// deployment (ai-host-do) on CellB Node in-process, with the scripted model, through the official
// OpenAI SDK: over REST (the deployment's routes), and over RPC (the projection run in the client
// over the session API's RPC methods).
import OpenAI, { APIError } from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  restFiles,
  rpcClient,
  type SessionClient,
  seed,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const TRANSPORTS = ["rest", "rpc"];
const USERS = [
  ...["ann", "bob", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo", "kim", "lou"],
  "mia",
];

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const CATALOG: Record<string, string> = {
  "/team/plugin.json": JSON.stringify({ $schema: AP, name: "team" }),
  "/team/dev.cellb.harness/agents/lead.md": "---\nname: lead\n---\nYou are lead.\n",
  // Starts sub-agents (statewalker/statewalker-ai#88).
  "/team/dev.cellb.harness/agents/helper.md": "---\nname: helper\n---\nYou are helper.\n",
  "/team/dev.cellb.harness/agents/boss.md":
    "---\nname: boss\nagents: [team/helper]\n---\nYou are boss.\n",
};

function fixtures(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const t of TRANSPORTS) {
    const access = Object.fromEntries(USERS.map((u) => [`${u}-${t}`, "editor"]));
    files[`/oa-${t}/readme.md`] = "# oa\n";
    files[`/oa-${t}/.system/access`] = JSON.stringify({ ...access, [`lim-${t}`]: "limited" });
    files[`/oa-${t}/.system/roles`] = JSON.stringify({
      limited: "files.read, files.list, models.use:scripted/default",
    });
    files[`/other-${t}/.system/access`] = JSON.stringify(access);
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
    MODELS: model.deploymentModels({
      models: [{ id: "scripted/default", alias: "default" }, { id: "scripted/other" }],
      default: "scripted/default",
    }),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(CATALOG),
    SSE_KEEPALIVE_MS: "200",
  });
  await seed(deployment, ADMIN_KEY, fixtures());
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const write = (path: string, content = "x\n") => call("write", { path, content });
const start = (agent: string, message: string) => call("agent_start", { agent, message });

/** A file's text as the user's own file view reads it; undefined when there is none. */
async function fileText(token: string, path: string): Promise<string | undefined> {
  const files = restFiles(deployment, token);
  if (!(await files.exists(path))) return undefined;
  const parts: Uint8Array[] = [];
  for await (const chunk of files.read(path)) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

/** The status of an OpenAI SDK call that failed. */
async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    if (e instanceof APIError) return e.status;
    throw e;
  }
}

describe.each(transports)("the OpenAI projection over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `oa-${t}`;
  let holds = 0;
  const hold = () => `oa-${t}-${++holds}`;

  async function as(u: string, agent = "default", where = project) {
    const token = await login(deployment, `${u}-${t}`);
    const client = await connect(deployment, token);
    const { baseURL, fetch, apiKey } = client.openai(where, agent);
    return {
      client,
      read: (path: string) => fileText(token, path),
      openai: new OpenAI({ apiKey, baseURL, fetch, maxRetries: 0 }),
    };
  }

  it("answers a Response as a turn of a new agent session, the Conversation, on the agent of the base URL", async () => {
    const { client, openai } = await as("ann", "team/lead");
    const r = await openai.responses.create({ model: "scripted/default", input: "hello" });
    expect(r).toMatchObject({ object: "response", status: "completed", model: "scripted/default" });
    expect(r.output_text).toBe("OK");
    expect(r.output).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        content: [expect.objectContaining({ type: "output_text", text: "OK" })],
      }),
    ]);
    const conversation = String(r.conversation?.id);
    const session = await client.getSession(conversation);
    expect(session).toMatchObject({ project, agent: "team/lead" });
    // The response is the turn.
    expect(await client.getTurn(r.id)).toMatchObject({
      session: conversation,
      status: "completed",
    });
    const again = await openai.responses.retrieve(r.id);
    expect(again).toMatchObject({ id: r.id, status: "completed", output_text: "OK" });
    expect(r.usage).toMatchObject({ input_tokens: 12, output_tokens: 3, total_tokens: 15 });
  });

  it("honours `model` only within the caller's rights, and lists the models the caller may use", async () => {
    const ann = await as("ann");
    const other = await ann.openai.responses.create({ model: "scripted/other", input: "hi" });
    expect(other.model).toBe("scripted/other");
    const lim = await as("lim");
    // Not a model the caller may use: ignored, the agent's own runs.
    const ignored = await lim.openai.responses.create({ model: "scripted/other", input: "hi" });
    expect(ignored.model).toBe("scripted/default");
    const unknown = await ann.openai.responses.create({ model: "gpt-4o", input: "hi" });
    expect(unknown.model).toBe("scripted/default");
    const listed = (await ann.openai.models.list()).data.map((m) => m.id).sort();
    expect(listed).toEqual(["scripted/default", "scripted/other"]);
    expect((await lim.openai.models.list()).data.map((m) => m.id)).toEqual(["scripted/default"]);
    expect(await lim.openai.models.retrieve("scripted/default")).toMatchObject({
      id: "scripted/default",
      object: "model",
    });
  });

  it("chains a Response on the latest one in the same Conversation with previous_response_id", async () => {
    const { client, openai } = await as("bob");
    const r1 = await openai.responses.create({ model: "default", input: "one" });
    const r2 = await openai.responses.create({
      model: "default",
      input: "two",
      previous_response_id: r1.id,
    });
    expect(r2.conversation?.id).toBe(r1.conversation?.id);
    expect(r2.previous_response_id).toBe(r1.id);
    expect((await client.getTurn(r2.id)).parent_turn).toBe(r1.id);
    // A Conversation's id chains as well.
    const r3 = await openai.responses.create({
      model: "default",
      input: "three",
      conversation: String(r1.conversation?.id),
    });
    expect((await client.getTurn(r3.id)).parent_turn).toBe(r2.id);
  });

  it("previous_response_id naming an earlier response moves the head there and sends: an implicit rewind, never reverting files", async () => {
    const { client, openai, read } = await as("cy");
    const r1 = await openai.responses.create({ model: "default", input: "one" });
    await client.setMode({ mode: "bypassPermissions" });
    const r2 = await openai.responses.create({
      model: "default",
      input: write("notes/kept.md", "kept\n"),
      previous_response_id: r1.id,
    });
    const r3 = await openai.responses.create({
      model: "default",
      input: "again",
      previous_response_id: r1.id,
    });
    expect(r3.conversation?.id).toBe(r1.conversation?.id);
    const turn = await client.getTurn(r3.id);
    expect(turn.parent_turn).toBe(r1.id);
    expect(turn.items[0]).toMatchObject({
      kind: "rewind",
      text: expect.stringMatching(/^head moved: chained on an earlier response/),
    });
    // The file the set-aside response wrote stays.
    expect(await read(`/${project}/notes/kept.md`)).toBe("kept\n");
    // The Conversation shows the active path only.
    const items = await openai.conversations.items.list(String(r1.conversation?.id), {
      order: "asc",
    });
    const texts = items.data.flatMap((i) =>
      i.type === "message"
        ? i.content.map((c) => ("text" in c ? `${i.role}:${c.text}` : "")).filter(Boolean)
        : [],
    );
    expect(texts).toEqual(["user:one", "assistant:OK", "user:again", "assistant:OK"]);
    expect(items.data.some((i) => i.id === r2.output[0]?.id)).toBe(false);
  });

  it("refuses previous_response_id naming an earlier response while a turn runs (409)", async () => {
    const { client, openai } = await as("dee");
    const r1 = await openai.responses.create({ model: "default", input: "one" });
    const h = hold();
    const running = await openai.responses.create({
      model: "default",
      input: `HOLD ${h}`,
      previous_response_id: r1.id,
      background: true,
    });
    expect(["queued", "in_progress"]).toContain(running.status);
    await model.held(h);
    expect(
      await statusOf(
        openai.responses.create({ model: "default", input: "x", previous_response_id: r1.id }),
      ),
    ).toBe(409);
    model.release(h);
    const session = String(running.conversation?.id);
    await client.waitTurn({
      turn_id: running.id,
      session_id: session,
      offset: 0,
      stream_url: `/v1/sessions/${session}/events?turn=${encodeURIComponent(running.id)}`,
    } as never);
    expect((await openai.responses.retrieve(running.id)).status).toBe("completed");
  });

  it("streams a Response as the OpenAI event sequence, ending with response.completed", async () => {
    const { openai } = await as("eli");
    const stream = await openai.responses.create({
      model: "default",
      input: call("read", { path: "readme.md" }),
      stream: true,
    });
    const events: { type: string; sequence_number: number }[] = [];
    for await (const event of stream) events.push(event);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.in_progress");
    expect(types).toContain("response.output_text.delta");
    expect(types.at(-1)).toBe("response.completed");
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    const completed = events.at(-1) as unknown as { response: OpenAI.Responses.Response };
    expect(completed.response.output.map((o) => o.type)).toEqual(["mcp_call", "message"]);
    expect(completed.response.output[0]).toMatchObject({
      type: "mcp_call",
      name: "read",
      output: expect.stringContaining("# oa"),
    });
    // The SDK's stream helper builds the same final response.
    const helper = openai.responses.stream({ model: "default", input: "hello" });
    const final = await helper.finalResponse();
    expect(final.output_text).toBe("OK");
  });

  it("shows an ask as an mcp_approval_request, and runs the call once when an mcp_approval_response approves it", async () => {
    const { client, openai, read } = await as("fay");
    const r1 = await openai.responses.create({
      model: "default",
      input: write("notes/f.md", "f\n"),
    });
    expect(r1.status).toBe("completed");
    const asked = r1.output.find((o) => o.type === "mcp_approval_request");
    expect(asked).toMatchObject({ type: "mcp_approval_request", name: "write" });
    expect(JSON.parse(String(asked?.arguments))).toMatchObject({ path: "notes/f.md" });
    const [approval] = (await client.listApprovals()).approvals.filter(
      (a) => a.session === r1.conversation?.id,
    );
    expect(asked?.id).toBe(approval?.id);
    // The same request answered twice in one input: refused, nothing answered.
    const twice = {
      type: "mcp_approval_response" as const,
      approval_request_id: String(asked?.id),
    };
    expect(
      await statusOf(
        openai.responses.create({
          model: "default",
          previous_response_id: r1.id,
          input: [
            { ...twice, approve: true },
            { ...twice, approve: false },
          ],
        }),
      ),
    ).toBe(400);
    const r2 = await openai.responses.create({
      model: "default",
      previous_response_id: r1.id,
      input: [
        { type: "mcp_approval_response", approval_request_id: String(asked?.id), approve: true },
      ],
    });
    expect(r2.conversation?.id).toBe(r1.conversation?.id);
    expect(r2.output[0]).toMatchObject({
      type: "mcp_call",
      name: "write",
      approval_request_id: asked?.id,
      output: expect.stringContaining("write /"),
    });
    // The agent's turn goes on with the result (statewalker/statewalker-root#214).
    expect(r2.output_text).toBe("OK");
    expect(await read(`/${project}/notes/f.md`)).toBe("f\n");
    // Answered once: the same answer again is refused.
    expect(
      await statusOf(
        openai.responses.create({
          model: "default",
          previous_response_id: r2.id,
          input: [
            {
              type: "mcp_approval_response",
              approval_request_id: String(asked?.id),
              approve: true,
            },
          ],
        }),
      ),
    ).toBe(400);
  });

  it("asks a sub-agent's approval as the Conversation's mcp_approval_request; approving it continues the Conversation with the sub-agent's outcome", async () => {
    const { client, openai, read } = await as("mia", "team/boss");
    await client.setMode({ mode: "default" });
    const r1 = await openai.responses.create({
      model: "default",
      input: start("team/helper", write("notes/m.md", "m\n")),
    });
    const root = String(r1.conversation?.id);
    const child = (await client.listSessions()).sessions.find((s) => s.parent === root);
    const [approval] = (await client.listApprovals()).approvals.filter(
      (a) => a.session === child?.id,
    );
    const asked = r1.output.find((o) => o.type === "mcp_approval_request");
    expect(asked?.id).toBe(approval?.id);
    const r2 = await openai.responses.create({
      model: "default",
      previous_response_id: r1.id,
      input: [
        { type: "mcp_approval_response", approval_request_id: String(asked?.id), approve: true },
      ],
    });
    expect(r2.conversation?.id).toBe(root);
    expect(r2.output[0]).toMatchObject({
      type: "mcp_call",
      name: "agent_start",
      approval_request_id: asked?.id,
      output: expect.stringContaining("notes/m.md: done"),
    });
    expect(await read(`/${project}/notes/m.md`)).toBe("m\n");
  });

  it("a denying mcp_approval_response gives the model its reason, and changes nothing", async () => {
    const { client, openai, read } = await as("gus");
    const r1 = await openai.responses.create({
      model: "default",
      input: write("notes/g.md", "g\n"),
    });
    const asked = r1.output.find((o) => o.type === "mcp_approval_request");
    const r2 = await openai.responses.create({
      model: "default",
      previous_response_id: r1.id,
      input: [
        {
          type: "mcp_approval_response",
          approval_request_id: String(asked?.id),
          approve: false,
          reason: "not there",
        },
      ],
    });
    expect(r2.output[0]).toMatchObject({
      type: "mcp_call",
      approval_request_id: asked?.id,
      error: expect.stringContaining("not there"),
    });
    expect((await client.listApprovals()).approvals.find((a) => a.id === asked?.id)).toMatchObject({
      status: "denied",
    });
    expect(await read(`/${project}/notes/g.md`)).toBeUndefined();
    // A conversation lists the request and its answer.
    const items = await openai.conversations.items.list(String(r1.conversation?.id), {
      order: "asc",
    });
    expect(items.data.map((i) => i.type)).toEqual([
      "message",
      "mcp_approval_request",
      "mcp_approval_response",
      "mcp_call",
      "message",
    ]);
  });

  it("asks several approvals of one turn together: one answered shows the rest again, all answered continue the turn", async () => {
    const { openai, read } = await as("lou");
    const two = `${write("notes/l1.md", "1\n")}\n${write("notes/l2.md", "2\n")}`;
    const r1 = await openai.responses.create({ model: "default", input: two });
    // The calls run concurrently: their approvals are asked in either order.
    const pathOf = (o: { arguments?: unknown }) => String(JSON.parse(String(o.arguments)).path);
    const asked = r1.output
      .filter((o) => o.type === "mcp_approval_request")
      .sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
    expect(asked.map((a) => JSON.parse(String(a.arguments)).path)).toEqual([
      "notes/l1.md",
      "notes/l2.md",
    ]);
    const answer = (id: string) => ({
      type: "mcp_approval_response" as const,
      approval_request_id: id,
      approve: true,
    });
    // One answered: the other is asked again, nothing else runs yet.
    const r2 = await openai.responses.create({
      model: "default",
      previous_response_id: r1.id,
      input: [answer(String(asked[0]?.id))],
    });
    expect(r2.output.map((o) => [o.type, o.id])).toEqual([
      ["mcp_call", expect.any(String)],
      ["mcp_approval_request", asked[1]?.id],
    ]);
    expect(r2.output_text).toBe("");
    // The last answered: the turn goes on.
    const r3 = await openai.responses.create({
      model: "default",
      previous_response_id: r2.id,
      input: [answer(String(asked[1]?.id))],
    });
    expect(r3.output.map((o) => o.type)).toEqual(["mcp_call", "message"]);
    expect(await read(`/${project}/notes/l2.md`)).toBe("2\n");
    // Both at once: one Response shows both calls and the turn going on.
    const r4 = await openai.responses.create({ model: "default", input: two.replace(/l/g, "m") });
    const both = r4.output.filter((o) => o.type === "mcp_approval_request");
    const r5 = await openai.responses.create({
      model: "default",
      previous_response_id: r4.id,
      input: both.map((a) => answer(a.id)),
    });
    expect(r5.output.map((o) => o.type)).toEqual(["mcp_call", "mcp_call", "message"]);
    // Read again, a Response is its own turn: the last answer's call, and the turn going on.
    expect((await openai.responses.retrieve(r5.id)).output.map((o) => o.id)).toEqual(
      r5.output.slice(1).map((o) => o.id),
    );
  });

  it("serves Conversations: created, read, updated and deleted; items and responses are never deleted", async () => {
    const { client, openai } = await as("hal");
    const c = await openai.conversations.create({ metadata: { topic: "x" } });
    expect(c).toMatchObject({ object: "conversation", metadata: { topic: "x" } });
    expect(await client.getSession(c.id)).toMatchObject({ project, metadata: { topic: "x" } });
    const r = await openai.responses.create({ model: "default", input: "hi", conversation: c.id });
    expect(r.conversation?.id).toBe(c.id);
    expect(await openai.conversations.retrieve(c.id)).toMatchObject({ id: c.id });
    expect(await openai.conversations.update(c.id, { metadata: { topic: "y" } })).toMatchObject({
      metadata: { topic: "y" },
    });
    const items = await openai.conversations.items.list(c.id);
    // Newest first by default, as OpenAI lists them.
    expect(items.data.map((i) => i.type)).toEqual(["message", "message"]);
    expect(items.data[0]).toMatchObject({ role: "assistant" });
    const first = String(items.data[1]?.id);
    expect(await statusOf(openai.conversations.items.list(c.id, { after: "it-nope" }))).toBe(400);
    expect(
      await openai.conversations.items.retrieve(first, { conversation_id: c.id }),
    ).toMatchObject({ id: first, role: "user" });
    expect(
      await statusOf(openai.conversations.items.delete(first, { conversation_id: c.id })),
    ).toBe(405);
    expect(await statusOf(openai.responses.delete(r.id))).toBe(405);
    expect(
      await statusOf(
        openai.conversations.items.create(c.id, {
          items: [{ type: "message", role: "user", content: "added" }],
        }),
      ),
    ).toBe(400);
    expect(
      await statusOf(
        openai.conversations.create({ items: [{ type: "message", role: "user", content: "a" }] }),
      ),
    ).toBe(400);
    const input = await openai.responses.inputItems.list(r.id);
    expect(input.data).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        content: [expect.objectContaining({ text: "hi" })],
      }),
    ]);
    expect(await openai.conversations.delete(c.id)).toMatchObject({ id: c.id, deleted: true });
    expect(await statusOf(openai.conversations.retrieve(c.id))).toBe(404);
  });

  it("refuses another user's Conversation and response, and a Conversation of another agent or project", async () => {
    const ivy = await as("ivy");
    const r = await ivy.openai.responses.create({ model: "default", input: "mine" });
    const conversation = String(r.conversation?.id);
    const jo = await as("jo");
    expect(await statusOf(jo.openai.conversations.retrieve(conversation))).toBe(404);
    expect(await statusOf(jo.openai.responses.retrieve(r.id))).toBe(404);
    expect(
      await statusOf(
        jo.openai.responses.create({ model: "default", input: "x", previous_response_id: r.id }),
      ),
    ).toBe(404);
    expect(
      await statusOf(jo.openai.responses.create({ model: "default", input: "x", conversation })),
    ).toBe(404);
    // The same user, through another agent's or project's base URL.
    const lead = await as("ivy", "team/lead");
    expect(await statusOf(lead.openai.conversations.retrieve(conversation))).toBe(404);
    expect(
      await statusOf(
        lead.openai.responses.create({ model: "default", input: "x", previous_response_id: r.id }),
      ),
    ).toBe(404);
    const elsewhere = await as("ivy", "default", `other-${t}`);
    expect(await statusOf(elsewhere.openai.responses.retrieve(r.id))).toBe(404);
    // An approval of another conversation is not answered here.
    await ivy.client.setMode({ mode: "default" });
    const asking = await ivy.openai.responses.create({
      model: "default",
      input: write("notes/i.md"),
    });
    const asked = asking.output.find((o) => o.type === "mcp_approval_request");
    expect(
      await statusOf(
        ivy.openai.responses.create({
          model: "default",
          previous_response_id: r.id,
          input: [
            {
              type: "mcp_approval_response",
              approval_request_id: String(asked?.id),
              approve: true,
            },
          ],
        }),
      ),
    ).toBe(400);
  });

  it("answers Chat Completions statelessly: a fresh agent session per request, shown the messages it is sent", async () => {
    const { client, openai } = await as("jo");
    const before = (await client.listSessions({ metadata: { openai: "chat.completions" } }))
      .sessions;
    const done = await openai.chat.completions.create({
      model: "default",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "first" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "second" },
      ],
    });
    expect(done).toMatchObject({
      object: "chat.completion",
      model: "scripted/default",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    });
    // What the model was shown (other scenarios' requests may land meanwhile).
    const shown = model.requests
      .filter((r) => !r.summary && !r.classifier && r.lastUserText.includes("earlier answer"))
      .at(-1)?.lastUserText;
    expect(shown).toMatch(/user: first/);
    expect(shown).toMatch(/second$/);
    // Stateless: the session is archived once answered.
    const after = (
      await client.listSessions({ metadata: { openai: "chat.completions" }, status: "archived" })
    ).sessions;
    expect(after.length).toBe(before.length + 1);
    const stream = await openai.chat.completions.create({
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let finish: string | null | undefined;
    let usage: unknown;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      finish = chunk.choices[0]?.finish_reason ?? finish;
      usage = chunk.usage ?? usage;
    }
    expect(text).toBe("OK");
    expect(finish).toBe("stop");
    expect(usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 3 });
  });

  it("turns an ask in Chat Completions into a deny with a reason", async () => {
    const { client, openai, read } = await as("kim");
    await client.setMode({ mode: "default" });
    const done = await openai.chat.completions.create({
      model: "default",
      messages: [{ role: "user", content: write("notes/k.md") }],
    });
    expect(done.choices[0]?.message.content).toMatch(
      /^RESULT: EACCES: .*the session is unattended, so nobody can approve it/,
    );
    expect(await read(`/${project}/notes/k.md`)).toBeUndefined();
    expect((await client.listApprovals()).approvals.filter((a) => a.status === "pending")).toEqual(
      [],
    );
  });
});

describe("OpenAI streams and an expiring token", () => {
  it("ends an open Responses or Chat Completions stream with an error once its token expires", async () => {
    for (const kind of ["responses", "chat"]) {
      const token = await login(deployment, "fay-rest", { ttlMs: 1500 });
      const { baseURL, fetch } = restClient(deployment, token).openai("oa-rest");
      const openai = new OpenAI({ apiKey: token, baseURL, fetch, maxRetries: 0 });
      const h = `oa-expiry-${kind}`;
      const read = async () => {
        if (kind === "responses")
          for await (const _ of await openai.responses.create({
            model: "default",
            input: `HOLD ${h}`,
            stream: true,
          }));
        else
          for await (const _ of await openai.chat.completions.create({
            model: "default",
            messages: [{ role: "user", content: `HOLD ${h}` }],
            stream: true,
          }));
      };
      const failed = await read().then(
        () => undefined,
        (e: unknown) => e,
      );
      model.release(h);
      expect(failed).toBeInstanceOf(APIError);
      expect(String((failed as Error).message)).toMatch(/EAUTH|expired/i);
    }
  });
});
