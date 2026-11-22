// The UHP projection (statewalker/statewalker-root#139, decided in #108, amended by #157 and #159):
// UHP clients drive harness agents at UHP class Core plus `input_requests`, pinned to UHP
// `2026-10-19`. Each agent the user may start is a harness named `<project>/<plugin>/<agent>`; a
// UHP session is an agent session and a response is a turn; a task sent to a busy session is
// `409 session_busy`; approvals go out one `input_request` at a time, with scope "once";
// `branch: true` is a fork carrying its first message; `previous_response_id` naming an earlier
// response moves the head. Run against the harness's own deployment (ai-host-do) on CellB Node
// in-process, with the scripted model, as a UHP client sees it: over REST (the deployment's routes
// under `/uhp`), and over RPC (the projection run in the client over the session API's methods).
import { readFileSync } from "node:fs";
import { UHP_SPEC_COMMIT } from "@statewalker/ai-uhp";
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
const USERS = ["ann", "bob", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo", "kim", "lou"];
const VERSION = "2026-10-19";

const AP = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const CATALOG: Record<string, string> = {
  "/team/plugin.json": JSON.stringify({ $schema: AP, name: "team" }),
  "/team/dev.cellb.harness/agents/lead.md":
    "---\nname: lead\ndescription: Leads the team.\n---\nYou are lead.\n",
  "/team/dev.cellb.harness/agents/helper.md": "---\nname: helper\n---\nYou are helper.\n",
};

function fixtures(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const t of TRANSPORTS) {
    const access = Object.fromEntries(USERS.map((u) => [`${u}-${t}`, "editor"]));
    files[`/uhp-${t}/readme.md`] = "# uhp\n";
    files[`/uhp-${t}/.system/access`] = JSON.stringify({ ...access, [`lim-${t}`]: "limited" });
    files[`/uhp-${t}/.system/roles`] = JSON.stringify({
      limited: "files.read, files.list, models.use:scripted/default, agents.use:team/helper",
    });
    files[`/side-${t}/.system/access`] = JSON.stringify({ [`ann-${t}`]: "editor" });
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

/** A file's text as the user's own file view reads it; undefined when there is none. */
async function fileText(token: string, path: string): Promise<string | undefined> {
  const files = restFiles(deployment, token);
  if (!(await files.exists(path))) return undefined;
  const parts: Uint8Array[] = [];
  for await (const chunk of files.read(path)) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

// biome-ignore lint/suspicious/noExplicitAny: UHP bodies are read as JSON.
type Json = any;

/** One SSE stream's events (`data:` JSON), and its comment lines. */
async function sseOf(res: Response): Promise<{ events: Json[]; comments: string[] }> {
  const text = await res.text();
  const events: Json[] = [];
  const comments: string[] = [];
  for (const block of text.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    for (const l of block.split("\n")) if (l.startsWith(":")) comments.push(l);
    if (data) events.push(JSON.parse(data));
  }
  return { events, comments };
}

/** Waits until a response's turn has ended, reading its session's log. */
async function turnEnded(client: SessionClient, response: Json): Promise<void> {
  const session = String(response.metadata.session_id);
  const turn = String(response.id).slice("resp_".length);
  await client.waitTurn({
    turn_id: turn,
    session_id: session,
    offset: 0,
    stream_url: `/v1/sessions/${session}/events`,
  } as never);
}

describe.each(transports)("the UHP projection over %s", (name, connect) => {
  const t = name.toLowerCase();
  const project = `uhp-${t}`;

  /** A UHP client of user `u`: requests to `<base>/v1/...` with the user's token. */
  async function as(u: string) {
    const token = await login(deployment, `${u}-${t}`);
    const client = await connect(deployment, token);
    const { baseURL, fetch, apiKey } = client.uhp();
    const request = (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${baseURL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const json = async (method: string, path: string, body?: unknown) => {
      const res = await request(method, path, body);
      return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
    };
    return {
      token,
      client,
      request,
      json,
      read: (path: string) => fileText(token, path),
      /** The harness id of an agent of the fixture project. */
      async harness(agent = "team/lead", where = project): Promise<string> {
        const { body } = await json("GET", "/v1/harnesses");
        const found = (body.harnesses as Json[]).find((h) => h.name === `${where}/${agent}`);
        if (!found) throw new Error(`no harness ${where}/${agent}`);
        return String(found.id);
      },
    };
  }

  it("serves discovery without a credential: class core plus input_requests, at UHP 2026-10-19, memories and branching not declared", async () => {
    const { request } = await as("ann");
    const res = await request("GET", "/v1/uhp", undefined, { authorization: "" });
    expect(res.status).toBe(200);
    expect(res.headers.get("uhp-version")).toBe(VERSION);
    const d: Json = await res.json();
    expect(d).toMatchObject({
      object: "uhp.discovery",
      protocol: "uhp",
      versions: [VERSION],
      default_version: VERSION,
      conformance_class: "core",
      capabilities: {
        streaming: true,
        sessions: true,
        cancellation: true,
        input_requests: true,
        files_input: false,
        files_output: false,
        session_listing: false,
        harness_management: false,
        session_sharing: false,
        session_branching: false,
        idempotency: false,
        memories: false,
        plugins: false,
        environments: false,
        input_history: false,
        resume: false,
      },
    });
    // The spec commit the projection is pinned at.
    expect(d.implementation.spec_commit).toMatch(/^[0-9a-f]{40}$/);
    // A version it can't serve is refused, never silently substituted; the answer names its own.
    const old = await request("GET", "/v1/uhp", undefined, { "uhp-version": "2026-10-04" });
    expect(old.status).toBe(400);
    expect(old.headers.get("uhp-version")).toBe(VERSION);
    expect(((await old.json()) as Json).error).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_protocol_version",
      detail: { supported: [VERSION] },
    });
  });

  it("lists each agent the user may start as a harness `<project>/<plugin>/<agent>`, and only those", async () => {
    const ann = await as("ann");
    const { status, body, headers } = await ann.json("GET", "/v1/harnesses");
    expect(status).toBe(200);
    expect(headers.get("uhp-version")).toBe(VERSION);
    const names = (body.harnesses as Json[]).map((h) => h.name);
    // Every project ann is a member of, and nothing of the other transport's.
    expect(names).toEqual(
      expect.arrayContaining([
        `${project}/team/helper`,
        `${project}/team/lead`,
        `side-${t}/team/lead`,
      ]),
    );
    expect(names.some((n: string) => n.startsWith(`uhp-${t === "rest" ? "rpc" : "rest"}/`))).toBe(
      false,
    );
    const lead = (body.harnesses as Json[]).find((h) => h.name === `${project}/team/lead`);
    expect(lead).toMatchObject({
      id: expect.stringMatching(/^chrn_/),
      object: "harness",
      base: "statewalker",
      description: "Leads the team.",
      defaultModel: "scripted/default",
    });
    // One harness by id; one the caller can't start is not found (404, never 403).
    expect((await ann.json("GET", `/v1/harnesses/${lead.id}`)).body).toMatchObject({
      id: lead.id,
      name: `${project}/team/lead`,
    });
    const lim = await as("lim");
    const limNames = ((await lim.json("GET", "/v1/harnesses")).body.harnesses as Json[]).map(
      (h) => h.name,
    );
    expect(limNames).toEqual([`${project}/team/helper`]);
    const hidden = await lim.json("GET", `/v1/harnesses/${lead.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "harness_not_found",
    });
    const side = await lim.json("GET", `/v1/harnesses/chrn_side-${t}~team~lead`);
    expect(side.body.error.code).toBe("harness_not_found");
  });

  it("lists the models: each harness's, and the catalogue, with availability computed for the caller", async () => {
    const lim = await as("lim");
    const helper = await lim.harness("team/helper");
    const { body } = await lim.json("GET", `/v1/harnesses/${helper}/models`);
    expect(body).toMatchObject({ harness_id: helper, default: "scripted/default" });
    expect(body.models).toEqual([
      expect.objectContaining({ id: "scripted/default", available: true, default: true }),
      expect.objectContaining({ id: "scripted/other", available: false }),
    ]);
    const catalog = (await lim.json("GET", "/v1/models")).body;
    expect(catalog.backends.scripted).toMatchObject({ default: "scripted/default" });
    expect((catalog.backends.scripted.models as Json[]).map((m) => [m.id, m.available])).toEqual([
      ["scripted/default", true],
      ["scripted/other", false],
    ]);
  });

  it("refuses a request with no credential or a bad one (401), in UHP's error envelope", async () => {
    const { request } = await as("ann");
    const none = await request("GET", "/v1/harnesses", undefined, { authorization: "" });
    expect(none.status).toBe(401);
    expect(((await none.json()) as Json).error).toMatchObject({
      type: "authentication_error",
      code: "missing_credential",
      param: null,
      detail: null,
    });
    if (t === "rest") {
      const bad = await request("GET", "/v1/harnesses", undefined, {
        authorization: "Bearer not-a-token",
      });
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as Json).error.type).toBe("authentication_error");
    }
  });

  let holds = 0;
  const hold = () => `uhp-${t}-${++holds}`;

  it("runs a task as a turn of a new agent session on the harness's agent, and reads it back", async () => {
    const { client, json, harness } = await as("ann");
    const lead = await harness();
    const { status, body: r } = await json("POST", "/v1/responses", {
      input: "hello",
      metadata: { harness_id: lead },
    });
    expect(status).toBe(200);
    expect(r).toMatchObject({
      id: expect.stringMatching(/^resp_/),
      object: "response",
      status: "completed",
      error: null,
      incomplete_details: null,
      previous_response_id: null,
      model: "scripted/default",
      store: true,
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cache_read_tokens: 4 },
      metadata: { session_id: expect.any(String), harness_id: lead },
    });
    expect(r.metadata.ignored_fields).toBeUndefined();
    expect(r.output).toEqual([
      {
        id: expect.any(String),
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      },
    ]);
    // The session is the agent session, the response its turn.
    const session = await client.getSession(r.metadata.session_id);
    expect(session).toMatchObject({ project, agent: "team/lead" });
    expect(await client.getTurn(r.id.slice(5))).toMatchObject({
      session: session.id,
      status: "completed",
    });
    expect((await json("GET", `/v1/responses/${r.id}`)).body).toEqual(r);
    const inputs = (await json("GET", `/v1/responses/${r.id}/input_items`)).body;
    expect(inputs.data).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }),
    ]);
    // Without a harness, the default one runs and is named.
    const plain = (await json("POST", "/v1/responses", { input: "hi" })).body;
    expect(plain.metadata.harness_id).toMatch(/^chrn_/);
    // A response the caller can't see, or that never was: 404 response_not_found.
    const bob = await as("bob");
    expect((await bob.json("GET", `/v1/responses/${r.id}`)).body.error.code).toBe(
      "response_not_found",
    );
    expect((await json("GET", "/v1/responses/resp_nothing")).status).toBe(404);
    // Responses are turns: kept with their session.
    expect((await json("DELETE", `/v1/responses/${r.id}`)).status).toBe(409);
  });

  it("reports the model that ran, and a substitution for a model the caller may not use", async () => {
    const lim = await as("lim");
    const r = (
      await lim.json("POST", "/v1/responses", {
        input: "hi",
        model: "scripted/other",
        metadata: { harness_id: await lim.harness("team/helper") },
      })
    ).body;
    expect(r.model).toBe("scripted/default");
    expect(r.metadata).toMatchObject({
      requested_model: "scripted/other",
      model_fallback: true,
      model_fallback_reason: expect.stringContaining("scripted/other"),
    });
    const ann = await as("ann");
    const other = (
      await ann.json("POST", "/v1/responses", {
        input: "hi",
        model: "scripted/other",
        metadata: { harness_id: await ann.harness() },
      })
    ).body;
    expect(other.model).toBe("scripted/other");
    expect(other.metadata.model_fallback).toBeUndefined();
  });

  it("accepts the reserved fields and every field it does not act on, and names them in metadata.ignored_fields", async () => {
    const { json, harness } = await as("bob");
    const r = (
      await json("POST", "/v1/responses", {
        input: "hi",
        metadata: { harness_id: await harness(), memory: "hmem_x" },
        tools: [{ type: "function", name: "x" }],
        include: ["reasoning.encrypted_content"],
        max_step: 3,
        store: true,
        // Fields of the session API's own: still only ignored.
        content: "not this",
        delivery: "steer",
      })
    ).body;
    expect(r.status).toBe("completed");
    expect([...r.metadata.ignored_fields].sort()).toEqual([
      "content",
      "delivery",
      "include",
      "max_step",
      "metadata.memory",
      "tools",
    ]);
    // Kept with the turn: read back, the response says the same.
    expect(
      [...(await json("GET", `/v1/responses/${r.id}`)).body.metadata.ignored_fields].sort(),
    ).toEqual(["content", "delivery", "include", "max_step", "metadata.memory", "tools"]);
  });

  it("continues the session with previous_response_id, and refuses another harness, a busy session and an unknown response", async () => {
    const { json, harness, client } = await as("cy");
    const lead = await harness();
    const r1 = (
      await json("POST", "/v1/responses", { input: "one", metadata: { harness_id: lead } })
    ).body;
    const r2 = (
      await json("POST", "/v1/responses", {
        input: "two",
        previous_response_id: r1.id,
        metadata: { harness_id: lead },
      })
    ).body;
    expect(r2.metadata.session_id).toBe(r1.metadata.session_id);
    expect(r2.previous_response_id).toBe(r1.id);
    expect((await client.getTurn(r2.id.slice(5))).parent_turn).toBe(r1.id.slice(5));
    const mismatch = await json("POST", "/v1/responses", {
      input: "x",
      previous_response_id: r2.id,
      metadata: { harness_id: await harness("team/helper") },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toMatchObject({
      code: "harness_mismatch",
      param: "metadata.harness_id",
    });
    const unknown = await json("POST", "/v1/responses", {
      input: "x",
      previous_response_id: "resp_nothing",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("response_not_found");
    // A task while one runs: 409 session_busy, whichever response it chains on.
    const h = hold();
    const running = (
      await json("POST", "/v1/responses", {
        input: `HOLD ${h}`,
        previous_response_id: r2.id,
        background: true,
      })
    ).body;
    expect(running.status).toBe("in_progress");
    await model.held(h);
    expect((await json("GET", `/v1/responses/${running.id}`)).body.status).toBe("in_progress");
    for (const previous of [running.id, r2.id, r1.id]) {
      const busy = await json("POST", "/v1/responses", {
        input: "x",
        previous_response_id: previous,
      });
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatchObject({
        type: "invalid_request_error",
        code: "session_busy",
      });
    }
    model.release(h);
    await turnEnded(client, running);
    const done = (
      await json("POST", "/v1/responses", { input: "after", previous_response_id: running.id })
    ).body;
    expect(done.status).toBe("completed");
  });

  it("previous_response_id naming an earlier response moves the head there and continues in the same session", async () => {
    const { json, harness, client, read } = await as("dee");
    await client.setMode({ mode: "bypassPermissions" });
    const lead = await harness();
    const r1 = (
      await json("POST", "/v1/responses", { input: "one", metadata: { harness_id: lead } })
    ).body;
    const r2 = (
      await json("POST", "/v1/responses", {
        input: write("notes/kept.md", "kept\n"),
        previous_response_id: r1.id,
      })
    ).body;
    expect(r2.status).toBe("completed");
    const r3 = (
      await json("POST", "/v1/responses", { input: "again", previous_response_id: r1.id })
    ).body;
    expect(r3.metadata.session_id).toBe(r1.metadata.session_id);
    expect(r3.previous_response_id).toBe(r1.id);
    expect(r3.metadata.branched_from).toBeUndefined();
    const turn = await client.getTurn(r3.id.slice(5));
    expect(turn.parent_turn).toBe(r1.id.slice(5));
    expect(turn.items[0]).toMatchObject({
      kind: "rewind",
      text: expect.stringMatching(/^head moved: chained on an earlier response/),
    });
    // No file is reverted.
    expect(await read(`/${project}/notes/kept.md`)).toBe("kept\n");
  });

  it("branch: true forks the session at that response, carrying the task, and reports branched_from", async () => {
    const { json, harness, client } = await as("eli");
    const lead = await harness();
    const r1 = (
      await json("POST", "/v1/responses", { input: "one", metadata: { harness_id: lead } })
    ).body;
    const r2 = (await json("POST", "/v1/responses", { input: "two", previous_response_id: r1.id }))
      .body;
    const b1 = (
      await json("POST", "/v1/responses", {
        input: "branched",
        previous_response_id: r1.id,
        branch: true,
      })
    ).body;
    expect(b1.status).toBe("completed");
    expect(b1.metadata.session_id).not.toBe(r1.metadata.session_id);
    expect(b1.metadata).toMatchObject({ branched_from: r1.id, harness_id: lead });
    const fork = await client.getSession(b1.metadata.session_id);
    expect(fork).toMatchObject({
      project,
      agent: "team/lead",
      forked_from: { session: r1.metadata.session_id, turn: r1.id.slice(5) },
    });
    // Read back, the same; the session's detail says where it starts (depth 1 on the path).
    expect((await json("GET", `/v1/responses/${b1.id}`)).body.metadata.branched_from).toBe(r1.id);
    expect((await json("GET", `/v1/sessions/${b1.metadata.session_id}`)).body).toMatchObject({
      id: b1.metadata.session_id,
      object: "session",
      harness_id: lead,
      branched_from: { response_id: r1.id, session_id: r1.metadata.session_id, turn: 1 },
    });
    const deeper = (
      await json("POST", "/v1/responses", {
        input: "b2",
        previous_response_id: r2.id,
        branch: true,
      })
    ).body;
    expect(
      (await json("GET", `/v1/sessions/${deeper.metadata.session_id}`)).body.branched_from.turn,
    ).toBe(2);
    // A later response of the fork continues it, with no branched_from.
    const b2 = (await json("POST", "/v1/responses", { input: "more", previous_response_id: b1.id }))
      .body;
    expect(b2.metadata.session_id).toBe(b1.metadata.session_id);
    expect(b2.metadata.branched_from).toBeUndefined();
    // The original is unchanged.
    expect((await client.getSession(r1.metadata.session_id)).forked_from).toBeUndefined();
    // branch is a boolean, and needs a previous response.
    for (const body of [
      { input: "x", branch: true },
      { input: "x", previous_response_id: r1.id, branch: "yes" },
    ]) {
      const refused = await json("POST", "/v1/responses", body);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "invalid_input", param: "branch" });
    }
    // A response still running is no branch point.
    const h = hold();
    const running = (
      await json("POST", "/v1/responses", {
        input: `HOLD ${h}`,
        previous_response_id: b2.id,
        background: true,
      })
    ).body;
    await model.held(h);
    const unavailable = await json("POST", "/v1/responses", {
      input: "x",
      previous_response_id: running.id,
      branch: true,
    });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.code).toBe("branch_unavailable");
    model.release(h);
  });

  it("streams a task as UHP's event sequence: numbered from 0, response.created first, one terminal event with the whole response", async () => {
    const { request, json, harness } = await as("fay");
    const res = await request("POST", "/v1/responses", {
      input: call("read", { path: "readme.md" }),
      metadata: { harness_id: await harness() },
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("uhp-version")).toBe(VERSION);
    const { events } = await sseOf(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(events[0].response.status).toBe("in_progress");
    expect(types).toContain("response.in_progress");
    expect(types).toContain("response.output_text.delta");
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(
      types.filter((x) => x.startsWith("response.") && /completed|failed|incomplete$/.test(x)),
    ).toEqual(["response.completed"]);
    const final = events.at(-1).response;
    expect(final.output.map((o: Json) => o.type)).toEqual([
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(final.output[1]).toMatchObject({
      call_id: final.output[0].call_id,
      output: expect.stringContaining("# uhp"),
    });
    // The stream and the stored response agree.
    expect((await json("GET", `/v1/responses/${final.id}`)).body).toEqual(final);
    // Each item arrives between its added and done events.
    const added = events
      .filter((e) => e.type === "response.output_item.added")
      .map((e) => e.item.id);
    expect(added).toEqual(final.output.map((o: Json) => o.id));
  });

  it("keeps a quiet stream alive, and a background task is followed by reading it back; cancelling it ends it cancelled", async () => {
    const { request, json, harness } = await as("gus");
    const lead = await harness();
    const h = hold();
    // Read as it comes: a stream is pulled by its reader.
    const streamed = request("POST", "/v1/responses", {
      input: `HOLD ${h}`,
      metadata: { harness_id: lead },
      stream: true,
    }).then(sseOf);
    await model.held(h);
    await new Promise((ok) => setTimeout(ok, 700));
    model.release(h);
    const { events, comments } = await streamed;
    // The deployment's keep-alive (200 ms here); the in-process router keeps UHP's 30 s.
    if (t === "rest") expect(comments).toContain(": keep-alive");
    expect(events.at(-1).type).toBe("response.completed");
    // Background: answered at once, in progress; cancelled, it ends cancelled, and a second cancel
    // changes nothing.
    const h2 = hold();
    const bg = (
      await json("POST", "/v1/responses", {
        input: `HOLD ${h2}`,
        metadata: { harness_id: lead },
        background: true,
      })
    ).body;
    expect(bg.status).toBe("in_progress");
    await model.held(h2);
    const cancelled = await json("POST", `/v1/responses/${bg.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    model.release(h2);
    expect((await json("POST", `/v1/responses/${bg.id}/cancel`)).body.status).toBe("cancelled");
    expect((await json("GET", `/v1/responses/${bg.id}`)).body.status).toBe("cancelled");
    // A streamed cancelled task ends with response.failed whose status says cancelled; the
    // session's cancel stops whatever runs in it, and the session stays continuable.
    const h3 = hold();
    const third = request("POST", "/v1/responses", {
      input: `HOLD ${h3}`,
      previous_response_id: bg.id,
      stream: true,
    }).then(sseOf);
    await model.held(h3);
    expect((await json("POST", `/v1/sessions/${bg.metadata.session_id}/cancel`)).status).toBe(200);
    model.release(h3);
    const end = (await third).events.at(-1);
    expect(end.type).toBe("response.failed");
    expect(end.response.status).toBe("cancelled");
    const after = (
      await json("POST", "/v1/responses", { input: "on", previous_response_id: end.response.id })
    ).body;
    expect(after).toMatchObject({
      status: "completed",
      metadata: { session_id: bg.metadata.session_id },
    });
  });

  const answer = (request: string, value: string) => [
    { type: "input_response", input_request_id: request, answer: value },
  ];

  it("ends a turn that asks an approval incomplete, on one input_request; an input_response allowing it runs the call once", async () => {
    const { json, harness, client, read, request } = await as("hal");
    await client.setMode({ mode: "default" });
    const r1 = (
      await json("POST", "/v1/responses", {
        input: write("notes/h.md", "h\n"),
        metadata: { harness_id: await harness() },
      })
    ).body;
    expect(r1).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "input_required" },
    });
    const asked = r1.output.at(-1);
    const [approval] = (await client.listApprovals()).approvals.filter(
      (a) => a.session === r1.metadata.session_id && a.status === "pending",
    );
    expect(asked).toMatchObject({
      id: `inreq_${approval?.id}`,
      type: "input_request",
      kind: "confirm",
      prompt: expect.stringContaining("notes/h.md"),
      options: [
        { id: "allow", label: expect.any(String) },
        { id: "deny", label: expect.any(String) },
      ],
      expires_at: Math.floor(Number(approval?.expires) / 1000),
    });
    // A client rendering only messages shows the question too.
    expect(r1.output.at(-2)).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: asked.prompt }],
    });
    // An answer that fits no option: 422, and the question stays.
    const invalid = await json("POST", "/v1/responses", {
      previous_response_id: r1.id,
      input: answer(asked.id, "maybe"),
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe("input_response_invalid");
    const wrong = await json("POST", "/v1/responses", {
      previous_response_id: r1.id,
      input: answer("inreq_nothing", "allow"),
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("input_not_pending");
    expect(await read(`/${project}/notes/h.md`)).toBeUndefined();
    const r2 = (
      await json("POST", "/v1/responses", {
        previous_response_id: r1.id,
        input: answer(asked.id, "allow"),
      })
    ).body;
    expect(r2).toMatchObject({
      status: "completed",
      previous_response_id: r1.id,
      metadata: { session_id: r1.metadata.session_id },
    });
    expect(r2.output.map((o: Json) => o.type)).toEqual(["function_call_output", "message"]);
    expect(r2.output[0].output).toContain("write /");
    expect(await read(`/${project}/notes/h.md`)).toBe("h\n");
    // Scope "once": the approval is spent, and answered once.
    expect(
      (await client.listApprovals()).approvals.find((a) => a.id === approval?.id)?.status,
    ).toBe("allowed");
    expect((await json("GET", `/v1/responses/${r2.id}/input_items`)).body.data).toEqual([
      expect.objectContaining({
        type: "input_response",
        input_request_id: asked.id,
        answer: "allow",
      }),
    ]);
    for (const previous of [r1.id, r2.id]) {
      const again = await json("POST", "/v1/responses", {
        previous_response_id: previous,
        input: answer(asked.id, "allow"),
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("input_not_pending");
    }
    // Streamed, the question is an output item before response.incomplete.
    const { events } = await sseOf(
      await request("POST", "/v1/responses", {
        input: write("notes/h2.md"),
        previous_response_id: r2.id,
        stream: true,
      }),
    );
    expect(events.at(-1).type).toBe("response.incomplete");
    expect(events.filter((e) => e.type === "response.output_item.done").at(-1).item.type).toBe(
      "input_request",
    );
  });

  it("asks the approvals of one turn one input_request at a time; a deny tells the model and changes nothing", async () => {
    const { json, harness, client, read } = await as("ivy");
    await client.setMode({ mode: "default" });
    const r1 = (
      await json("POST", "/v1/responses", {
        input: `${write("notes/i1.md", "1\n")}\n${write("notes/i2.md", "2\n")}`,
        metadata: { harness_id: await harness() },
      })
    ).body;
    const first = r1.output.filter((o: Json) => o.type === "input_request");
    expect(first).toHaveLength(1);
    const r2 = (
      await json("POST", "/v1/responses", {
        previous_response_id: r1.id,
        input: answer(first[0].id, "allow"),
      })
    ).body;
    expect(r2.status).toBe("incomplete");
    const second = r2.output.filter((o: Json) => o.type === "input_request");
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(first[0].id);
    const r3 = (
      await json("POST", "/v1/responses", {
        previous_response_id: r2.id,
        input: answer(second[0].id, "deny"),
      })
    ).body;
    expect(r3.status).toBe("completed");
    expect(r3.output[0]).toMatchObject({
      type: "function_call_output",
      output: expect.stringContaining("denied"),
    });
    const paths = [first[0].prompt, second[0].prompt].map(
      (p: string) => /notes\/i\d\.md/.exec(p)?.[0],
    );
    expect(await read(`/${project}/${paths[0]}`)).toBeDefined();
    expect(await read(`/${project}/${paths[1]}`)).toBeUndefined();
  });

  it("any other input chained on a pending question passes it over: named in voided_input_requests, and no longer answerable", async () => {
    const { json, harness, client, read } = await as("jo");
    await client.setMode({ mode: "default" });
    const r1 = (
      await json("POST", "/v1/responses", {
        input: write("notes/j.md"),
        metadata: { harness_id: await harness() },
      })
    ).body;
    const asked = r1.output.at(-1);
    const r2 = (
      await json("POST", "/v1/responses", { previous_response_id: r1.id, input: "never mind" })
    ).body;
    expect(r2.status).toBe("completed");
    expect(r2.metadata.voided_input_requests).toEqual([asked.id]);
    expect(
      (await client.listApprovals()).approvals.find((a) => `inreq_${a.id}` === asked.id)?.status,
    ).toBe("cancelled");
    const late = await json("POST", "/v1/responses", {
      previous_response_id: r1.id,
      input: answer(asked.id, "allow"),
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("input_not_pending");
    expect(await read(`/${project}/notes/j.md`)).toBeUndefined();
    // Read back, the passed-over response no longer asks.
    expect((await json("GET", `/v1/responses/${r1.id}`)).body.status).toBe("completed");
  });

  it("refuses a malformed input_response: without a previous response, more than one, or beside branch (400 invalid_input)", async () => {
    const { json, harness } = await as("kim");
    const r1 = (
      await json("POST", "/v1/responses", {
        input: "one",
        metadata: { harness_id: await harness() },
      })
    ).body;
    const one = answer("inreq_x", "allow")[0];
    for (const [body, param] of [
      [{ input: [one] }, "input"],
      [{ input: [one, one], previous_response_id: r1.id }, "input"],
      [{ input: [one], previous_response_id: r1.id, branch: true }, "branch"],
      [{ input: [{ type: "resume" }], previous_response_id: r1.id }, "input"],
    ] as const) {
      const refused = await json("POST", "/v1/responses", body);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "invalid_input", param });
    }
  });
});

it("runs UHP's own conformance suite nightly, installed at the spec commit the projection is pinned to", () => {
  const nightly = readFileSync(
    new URL("../../../.github/workflows/nightly.yml", import.meta.url),
    "utf8",
  );
  expect(nightly).toContain(
    `harnessrouter.git@${UHP_SPEC_COMMIT}#subdirectory=protocol/conformance`,
  );
  expect(nightly).toContain("tests/nightly/uhp-conformance.test.ts");
});
