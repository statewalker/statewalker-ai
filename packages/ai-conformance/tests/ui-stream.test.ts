// The AI SDK UI message stream (statewalker/statewalker-root#140, decided in #71 and #83): a
// projection of the session's event log that `useChat`-style UIs read, with "ask" shown as a tool
// approval request the user answers from the UI, and a resume endpoint that replays from the log
// after a disconnect. Run against the harness's own deployment (ai-host-do) on CellB Node
// in-process, with the scripted model: over REST through the AI SDK's own HTTP chat transport, and
// over RPC through the session API's chat transport; every stream is read by the AI SDK's own
// UI-message reader, which validates each chunk.
import { readUIMessageStream, type UIMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChatTransportLike,
  type Deployment,
  expectUiStream,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  rpcClient,
  type SessionClient,
  seed,
  sseFrames,
  startDeployment,
  type UIMessageChunk,
  uiChunks,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const TRANSPORTS = ["rest", "rpc"];
const USERS = ["ann", "bob", "cy", "dee", "eli", "fay", "gus"];
const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** An agent that starts sub-agents (statewalker/statewalker-ai#88), and the one it starts. */
const CATALOG: Record<string, string> = {
  "/team/plugin.json": JSON.stringify({ $schema: AP, name: "team" }),
  "/team/dev.cellb.harness/agents/helper.md": "---\nname: helper\n---\nYou are helper.\n",
  "/team/dev.cellb.harness/agents/boss.md":
    "---\nname: boss\nagents: [team/helper]\n---\nYou are boss.\n",
};

const FILES = {
  "/proj/readme.md": "# proj\n",
  "/proj/.system/access": JSON.stringify(
    Object.fromEntries(TRANSPORTS.flatMap((t) => USERS.map((u) => [`${u}-${t}`, "editor"]))),
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
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    CATALOG: JSON.stringify(CATALOG),
    SSE_KEEPALIVE_MS: "200",
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await deployment?.close();
  await model?.close();
});

const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`;
const user = (text: string): UIMessage => ({
  id: `m-${crypto.randomUUID()}`,
  role: "user",
  parts: [{ type: "text", text }],
});

/** Reads a UI message stream: its chunks, and the message the AI SDK builds from them. */
async function collect(
  stream: ReadableStream<UIMessageChunk>,
  message?: UIMessage,
): Promise<{ chunks: UIMessageChunk[]; message: UIMessage | undefined }> {
  const [mine, sdk] = stream.tee();
  const chunks: UIMessageChunk[] = [];
  const errors: unknown[] = [];
  const reading = (async () => {
    for await (const chunk of mine as unknown as AsyncIterable<UIMessageChunk>) chunks.push(chunk);
  })();
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({
    stream: sdk as never,
    ...(message ? { message } : {}),
    onError: (e) => errors.push(e),
  }))
    last = m;
  await reading;
  // Every chunk is one the AI SDK accepts, and refers to parts it knows: the only errors it
  // reports are the stream's own error chunks.
  expect(errors.map((e) => String((e as Error)?.message ?? e))).toEqual(
    chunks.filter((c) => c.type === "error").map((c) => c.errorText),
  );
  return { chunks, message: last };
}

const send = (chat: ChatTransportLike, chatId: string, messages: UIMessage[]) =>
  chat.sendMessages({
    trigger: "submit-message",
    chatId,
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });

describe.each(transports)("the AI SDK UI message stream over %s", (name, connect) => {
  const t = name.toLowerCase();
  const as = async (u: string) => connect(deployment, await login(deployment, `${u}-${t}`));
  let holds = 0;
  const hold = () => `ui-${t}-${++holds}`;

  it("streams a turn as a UI message: its text, in one step, ending with finish", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "proj" });
    const chat = ann.chat(s.id);
    const { chunks, message } = await collect(await send(chat, s.id, [user("hello")]));
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    const turn = (await ann.listItems(s.id)).items[0]?.turn;
    expect(chunks[0]).toMatchObject({ type: "start", messageId: turn });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(message).toMatchObject({
      id: turn,
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "OK", state: "done" }],
    });
  });

  it("shows a tool call and its result as a tool part", async () => {
    const bob = await as("bob");
    const s = await bob.startSession({ project: "proj" });
    const { message } = await collect(
      await send(bob.chat(s.id), s.id, [user(call("read", { path: "readme.md" }))]),
    );
    const parts = message?.parts ?? [];
    expect(parts.find((p) => p.type === "dynamic-tool")).toMatchObject({
      type: "dynamic-tool",
      toolName: "read",
      state: "output-available",
      input: { path: "readme.md" },
      output: expect.stringContaining("# proj"),
    });
    expect(parts.at(-1)).toMatchObject({ type: "text", text: expect.stringMatching(/^RESULT:/) });
  });

  it("shows an ask as a tool approval request, and the user's denial from the UI as a denied tool part", async () => {
    const cy = await as("cy");
    const s = await cy.startSession({ project: "proj" });
    const chat = cy.chat(s.id);
    const first = await collect(
      await send(chat, s.id, [user(call("write", { path: "notes/c.md", content: "c\n" }))]),
    );
    const [approval] = (await cy.listApprovals()).approvals.filter((a) => a.session === s.id);
    expect(approval).toBeDefined();
    const tool = first.message?.parts.find((p) => p.type === "dynamic-tool");
    expect(tool).toMatchObject({
      toolName: "write",
      state: "approval-requested",
      input: { path: "notes/c.md" },
      approval: { id: approval?.id },
    });
    expect(first.message?.parts.find((p) => p.type === "data-approval")).toMatchObject({
      data: {
        approval: approval?.id,
        request: { permission: "files.write:/notes/c.md", action: { method: "write" } },
      },
    });
    expect(first.chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
    // The user answers in the UI (the AI SDK's addToolApprovalResponse), and the UI sends it.
    const answered = structuredClone(first.message) as UIMessage;
    const part = answered.parts.find((p) => p.type === "dynamic-tool") as Record<string, unknown>;
    part.state = "approval-responded";
    part.approval = { id: approval?.id, approved: false, reason: "not there" };
    const second = await collect(await send(chat, s.id, [user("x"), answered]), answered);
    expect(second.message?.id).toBe(first.message?.id);
    expect(second.message?.parts.find((p) => p.type === "dynamic-tool")).toMatchObject({
      state: "output-denied",
    });
    expect((await cy.listApprovals()).approvals.find((a) => a.id === approval?.id)).toMatchObject({
      status: "denied",
    });
    const items = (await cy.listItems(s.id)).items;
    expect(
      items.find((i) => i.kind === "tool_result" && i.approval === approval?.id),
    ).toMatchObject({
      output: expect.stringMatching(/not there/),
    });
    // The agent continues with the refusal, in the same assistant message
    // (statewalker/statewalker-root#214).
    expect(items.at(-1)).toMatchObject({ kind: "message", role: "assistant", text: "OK" });
    expect(second.message?.parts.filter((p) => p.type === "text").at(-1)).toMatchObject({
      text: "OK",
    });
    expect(second.chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("runs the approved call once when the user approves from the UI", async () => {
    const dee = await as("dee");
    const s = await dee.startSession({ project: "proj" });
    const chat = dee.chat(s.id);
    const first = await collect(
      await send(chat, s.id, [user(call("write", { path: "notes/d.md", content: "d\n" }))]),
    );
    const answered = structuredClone(first.message) as UIMessage;
    const part = answered.parts.find((p) => p.type === "dynamic-tool") as Record<string, unknown>;
    const approval = (part.approval as { id: string }).id;
    part.state = "approval-responded";
    part.approval = { id: approval, approved: true };
    const second = await collect(await send(chat, s.id, [answered]), answered);
    expect(second.message?.parts.find((p) => p.type === "dynamic-tool")).toMatchObject({
      state: "output-available",
      output: expect.stringContaining("write /proj/notes/d.md: done"),
    });
    // Answered: sending the same answer again is refused.
    await expect(send(chat, s.id, [answered])).rejects.toThrow();
  });

  it("asks a sub-agent's approval on the root session's agent_start call; approving it continues the root with the sub-agent's outcome", async () => {
    const gus = await as("gus");
    await gus.setMode({ mode: "default" });
    const s = await gus.startSession({ project: "proj", agent: "team/boss" });
    const chat = gus.chat(s.id);
    const message = call("write", { path: "notes/g.md", content: "g\n" });
    const first = await collect(
      await send(chat, s.id, [user(call("agent_start", { agent: "team/helper", message }))]),
    );
    const child = (await gus.listSessions()).sessions.find((x) => x.parent === s.id);
    const [approval] = (await gus.listApprovals()).approvals.filter((a) => a.session === child?.id);
    expect(approval).toMatchObject({ root: s.id, status: "pending" });
    const tool = first.message?.parts.find((p) => p.type === "dynamic-tool");
    expect(tool).toMatchObject({
      toolName: "agent_start",
      state: "approval-requested",
      approval: { id: approval?.id },
    });
    const answered = structuredClone(first.message) as UIMessage;
    const part = answered.parts.find((p) => p.type === "dynamic-tool") as Record<string, unknown>;
    part.state = "approval-responded";
    part.approval = { id: approval?.id, approved: true };
    const second = await collect(await send(chat, s.id, [answered]), answered);
    expect(second.message?.parts.find((p) => p.type === "dynamic-tool")).toMatchObject({
      state: "output-available",
      output: expect.stringContaining("write /proj/notes/g.md: done"),
    });
    expect(second.chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("replays a running turn from the log after a disconnect", async () => {
    const eli = await as("eli");
    const s = await eli.startSession({ project: "proj" });
    const chat = eli.chat(s.id);
    const h = hold();
    const stream = await send(chat, s.id, [user(`HOLD ${h}`)]);
    const reader = stream.getReader();
    // Read until the turn started, then go away: the turn keeps running.
    for (;;) {
      const { value } = await reader.read();
      if (value?.type === "start-step") break;
    }
    await reader.cancel();
    await model.held(h);
    const resumed = await chat.reconnectToStream({ chatId: s.id });
    expect(resumed).not.toBeNull();
    model.release(h);
    const { chunks, message } = await collect(resumed as ReadableStream<UIMessageChunk>);
    const turn = (await eli.listItems(s.id)).items[0]?.turn;
    // The whole message again, from the start of its turn.
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    expect(message).toMatchObject({ id: turn, parts: [{ type: "step-start" }, { text: "OK" }] });
    // Nothing runs any more: no stream to resume.
    expect(await chat.reconnectToStream({ chatId: s.id })).toBeNull();
  });

  it("replays an answer turn as part of the message it continues, not the turn before it", async () => {
    const fay = await as("fay");
    const s = await fay.startSession({ project: "proj" });
    const first = await collect(
      await send(fay.chat(s.id), s.id, [
        user(call("write", { path: "notes/f.md", content: "f\n" })),
      ]),
    );
    const [approval] = (await fay.listApprovals()).approvals.filter((a) => a.session === s.id);
    // Another message runs first, so the answer turn waits in the queue behind it.
    const h = hold();
    const running = await fay.postMessage(s.id, { content: `HOLD ${h}` });
    await model.held(h);
    const { accepted } = await fay.answerApproval(String(approval?.id), {
      decision: "deny",
      scope: "once",
    });
    const resumed = await fay.chat(s.id).reconnectToStream({ chatId: s.id });
    model.release(h);
    // The running message alone: the answer is not part of it.
    const now = await collect(resumed as ReadableStream<UIMessageChunk>);
    expect(now.message).toMatchObject({ id: running.turn_id, parts: [{}, { text: "OK" }] });
    await fay.waitTurn(accepted);
    // The answer turn's message: the first turn and its answer, replayed in full from the log.
    const replay = await collect(
      (await fay.replayChat(s.id, { turn: accepted.turn_id })) as ReadableStream<UIMessageChunk>,
    );
    expect(replay.message?.id).toBe(first.message?.id);
    expect(replay.message?.parts.filter((p) => p.type === "dynamic-tool")).toMatchObject([
      { toolName: "write", state: "output-denied", approval: { id: approval?.id } },
    ]);
  });

  it("follows the log after a cursor, without repeating what came before it", async () => {
    const ann = await as("ann");
    const s = await ann.startSession({ project: "proj" });
    const h = hold();
    const accepted = await ann.postMessage(s.id, { content: `HOLD ${h}` });
    await model.held(h);
    // The client saw everything up to now (as Last-Event-ID tells over REST).
    const { offset } = await ann.readEvents(s.id, { since: 0 });
    const resumed = await ann.replayChat(s.id, { since: offset });
    model.release(h);
    const { chunks } = await collect(resumed as ReadableStream<UIMessageChunk>);
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    expect(chunks[0]).not.toHaveProperty("messageId");
    expect(chunks.at(-1)).toMatchObject({
      messageMetadata: { turns: [{ id: accepted.turn_id, status: "completed" }] },
    });
    // After the turn's end, the cursor has nothing more to follow.
    const { offset: end } = await ann.readEvents(s.id, { since: 0 });
    expect(await ann.replayChat(s.id, { since: end })).toBeNull();
  });

  it("ends a failed turn's message with an error, and a cancelled one's with abort", async () => {
    const bob = await as("bob");
    const s = await bob.startSession({ project: "proj" });
    const chat = bob.chat(s.id);
    const failed = await collect(await send(chat, s.id, [user("FAIL")]));
    expect(failed.chunks.slice(-2)).toMatchObject([
      { type: "error", errorText: expect.any(String) },
      { type: "finish", finishReason: "error" },
    ]);
    const h = hold();
    const stream = await send(chat, s.id, [user(`HOLD ${h}`)]);
    await model.held(h);
    const turn = (await bob.listItems(s.id, { order: "desc", limit: 1 })).items[0]?.turn;
    await bob.cancelTurn(String(turn));
    model.release(h);
    const cancelled = await collect(stream);
    expect(cancelled.chunks.at(-1)).toMatchObject({ type: "abort", reason: "cancelled" });
  });

  it("refuses the UI message stream of another user's session, and an approval of another session", async () => {
    const cy = await as("cy");
    const dee = await as("dee");
    const mine = await cy.startSession({ project: "proj" });
    const other = await cy.startSession({ project: "proj" });
    await expect(send(dee.chat(mine.id), mine.id, [user("hi")])).rejects.toThrow();
    await expect(dee.replayChat(mine.id, { since: 0 })).rejects.toThrow();
    // An approval of another of the caller's sessions is not answered through this one.
    const asked = await collect(
      await send(cy.chat(other.id), other.id, [
        user(call("write", { path: "notes/x.md", content: "x\n" })),
      ]),
    );
    const answered = structuredClone(asked.message) as UIMessage;
    const part = answered.parts.find((p) => p.type === "dynamic-tool") as Record<string, unknown>;
    const id = (part.approval as { id: string }).id;
    part.state = "approval-responded";
    part.approval = { id, approved: true };
    await expect(send(cy.chat(mine.id), mine.id, [answered])).rejects.toThrow();
    expect((await cy.listApprovals()).approvals.find((a) => a.id === id)?.status).toBe("pending");
  });
});

describe("the AI SDK UI message stream over REST", () => {
  const open = (path: string, token: string, init: RequestInit = {}) =>
    deployment.fetch(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });

  it("answers with the UI message stream's headers, its events numbered by their log offsets", async () => {
    const token = await login(deployment, "eli-rest");
    const s = await restClient(deployment, token).startSession({ project: "proj" });
    const res = await open(`/v1/sessions/${s.id}/chat`, token, {
      method: "POST",
      body: JSON.stringify({ id: s.id, trigger: "submit-message", messages: [user("hello")] }),
    });
    expect(res.status).toBe(200);
    expectUiStream(res);
    const frames = [];
    for await (const f of sseFrames(res.body as ReadableStream<Uint8Array>)) frames.push(f);
    expect(frames.at(-1)).toMatchObject({ data: "[DONE]" });
    const numbered = frames.filter((f) => f.id !== undefined).map((f) => Number(f.id));
    expect(numbered.length).toBeGreaterThan(0);
    expect([...numbered].sort((a, b) => a - b)).toEqual(numbered);
    // Last-Event-ID resumes after the last frame seen: only the end of the turn is left.
    const last = numbered.at(-1) as number;
    const before = numbered.filter((n) => n < last).at(-1) as number;
    const again = await deployment.fetch(`/v1/sessions/${s.id}/chat/${s.id}/stream`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": String(before) },
    });
    expect(again.status).toBe(200);
    const rest = [];
    for await (const c of uiChunks(again.body as ReadableStream<Uint8Array>)) rest.push(c.type);
    expect(rest).toEqual(["start", "finish-step", "finish"]);
  });

  it("numbers only the last frame of each log event, so a resume after a cut mid-event resends all of it", async () => {
    const token = await login(deployment, "ann-rest");
    const s = await restClient(deployment, token).startSession({ project: "proj" });
    const res = await open(`/v1/sessions/${s.id}/chat`, token, {
      method: "POST",
      body: JSON.stringify({ messages: [user("hello")] }),
    });
    const frames = [];
    for await (const f of sseFrames(res.body as ReadableStream<Uint8Array>)) frames.push(f);
    const types = frames.map((f) =>
      f.data && f.data !== "[DONE]" ? JSON.parse(f.data).type : f.data,
    );
    // The text item is one event: its start and delta carry no id, its end carries the event's.
    const start = types.indexOf("text-start");
    expect(frames[start]?.id).toBeUndefined();
    expect(frames[start + 1]?.id).toBeUndefined();
    expect(frames[start + 2]?.id).toBeDefined();
    // The connection dropped right after text-start: the client's Last-Event-ID is the last id it saw.
    const seen = frames
      .slice(0, start + 1)
      .filter((f) => f.id !== undefined)
      .at(-1)?.id;
    const again = await deployment.fetch(`/v1/sessions/${s.id}/chat/stream`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": String(seen) },
    });
    const rest = [];
    for await (const c of uiChunks(again.body as ReadableStream<Uint8Array>)) rest.push(c.type);
    expect(rest).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
  });

  it("ends an open UI message stream with an error once its token expires", async () => {
    const token = await login(deployment, "fay-rest", { ttlMs: 1500 });
    const client = restClient(deployment, token);
    const s = await client.startSession({ project: "proj" });
    const h = `ui-expiry-${crypto.randomUUID()}`;
    const res = await open(`/v1/sessions/${s.id}/chat`, token, {
      method: "POST",
      body: JSON.stringify({ messages: [user(`HOLD ${h}`)] }),
    });
    const chunks = [];
    for await (const c of uiChunks(res.body as ReadableStream<Uint8Array>)) chunks.push(c);
    model.release(h);
    expect(chunks.at(-1)).toMatchObject({
      type: "error",
      errorText: expect.stringMatching(/EAUTH|expired/i),
    });
  });
});
