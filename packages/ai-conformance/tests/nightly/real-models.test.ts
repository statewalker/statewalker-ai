// Nightly (statewalker/statewalker-root#145, decided in #85): real-model smoke tests. A handful of
// end-to-end tasks (read a file, run a tool, edit after an approval, write) on one small model,
// with a capped budget and the provider key from a CI secret. Skipped, saying so, without the key.
//
//   NIGHTLY_LLM_API_KEY    the provider key (the CI secret); without it every task is skipped
//   NIGHTLY_LLM_API        the model API (default anthropic-messages)
//   NIGHTLY_LLM_BASE_URL   the provider's base URL (default https://api.anthropic.com)
//   NIGHTLY_LLM_MODEL      the model's name at the provider (default claude-haiku-5-5)
//   NIGHTLY_LLM_PRICES     its prices per million tokens, "<input>,<output>" (default 0.1,0.5)
//   NIGHTLY_LLM_BUDGET     the cap on the run's spend, in those prices' unit (default 0.5)
//
// The key reaches the model only through the harness's model gateway, as a deployment secret
// bound to the gateway and the provider's host. Each request is capped at 2048 output tokens, the
// spend so far is read from the workspace's budget before every task, and a task over the cap
// fails without calling the model. Run against the harness's own deployment (ai-host-do) on CellB
// Node, over REST.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  login,
  modelUsage,
  restClient,
  restFiles,
  type SessionClient,
  seed,
  startDeployment,
  type Turn,
} from "../../src/index.js";

const HOST = new URL("../../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";
const env = process.env;
const KEY = env.NIGHTLY_LLM_API_KEY ?? "";
const API = env.NIGHTLY_LLM_API || "anthropic-messages";
const BASE_URL = env.NIGHTLY_LLM_BASE_URL || "https://api.anthropic.com";
const MODEL = env.NIGHTLY_LLM_MODEL || "claude-haiku-5-5";
const [INPUT_PRICE, OUTPUT_PRICE] = (env.NIGHTLY_LLM_PRICES || "0.1,0.5").split(",").map(Number);
const BUDGET = Number(env.NIGHTLY_LLM_BUDGET || "0.5");
const CODE_WORD = `heron-${Math.random().toString(36).slice(2, 8)}`;

if (!KEY)
  console.warn(
    "real-model smoke tests skipped: NIGHTLY_LLM_API_KEY is not set (add it to the repository's Actions secrets)",
  );

let deployment: Deployment;
let client: SessionClient;
let token: string;

/** What the run has spent so far, by the workspace's budget. */
const spent = async () =>
  (await modelUsage(deployment, ADMIN_KEY)).reduce((sum, r) => sum + (r.cost ?? 0), 0);
/** Fails the task, before any model call, once the run's spend reached the cap. */
const withinBudget = async () => {
  const sofar = await spent();
  expect(sofar, `the run spent ${sofar} of its ${BUDGET} budget`).toBeLessThan(BUDGET);
};
const answerOf = (turn: Turn) =>
  turn.items
    .filter((i) => i.kind === "message" && i.role === "assistant")
    .map((i) => i.text ?? "")
    .join("\n");
const toolsOf = (turn: Turn) =>
  turn.items.filter((i) => i.kind === "tool_call").map((i) => String(i.name));

describe.skipIf(!KEY)(`real-model smoke tests on ${API} ${MODEL}`, () => {
  beforeAll(async () => {
    const host = new URL(BASE_URL).hostname;
    deployment = await startDeployment(HOST, {
      DEV_LOGIN: "true",
      ADMIN_KEY,
      NIGHTLY_LLM_API_KEY: KEY,
      DEPLOYMENT_SECRETS: JSON.stringify({
        NIGHTLY_LLM_API_KEY: { plugins: ["model-gateway"], hosts: [host] },
      }),
      MODELS: JSON.stringify({
        providers: [{ id: "nightly", api: API, baseUrl: BASE_URL, secret: "NIGHTLY_LLM_API_KEY" }],
        models: [
          {
            id: `nightly/${MODEL}`,
            alias: "default",
            maxTokens: 2048,
            cost: { input: INPUT_PRICE, output: OUTPUT_PRICE },
          },
        ],
        default: `nightly/${MODEL}`,
      }),
    });
    await seed(deployment, ADMIN_KEY, {
      "/smoke/notes/code.md": `# Notes\n\nThe code word is ${CODE_WORD}.\n`,
      "/smoke/notes/todo.md": "- release: pending\n",
      "/smoke/.system/access": JSON.stringify({ smoker: "editor" }),
    });
    token = await login(deployment, "smoker");
    client = restClient(deployment, token);
  }, 120_000);
  afterAll(async () => {
    if (deployment) console.log(`real-model smoke tests spent ${await spent()} of ${BUDGET}`);
    await deployment?.close();
  });

  it("reads a file with its tools and answers from it", async () => {
    await withinBudget();
    const s = await client.startSession({ project: "smoke" });
    const turn = await client.sendMessage(s.id, {
      content: "Read the file notes/code.md and reply with only the code word written in it.",
    });
    expect(turn.status).toBe("completed");
    expect(toolsOf(turn).length).toBeGreaterThan(0);
    expect(answerOf(turn)).toContain(CODE_WORD);
  });

  it("runs a tool and reports its output", async () => {
    await withinBudget();
    const s = await client.startSession({ project: "smoke" });
    const turn = await client.sendMessage(s.id, {
      content:
        "Use the bash tool to run the command `echo $((6*7))-ok` and reply with exactly what it printed.",
    });
    expect(turn.status).toBe("completed");
    expect(toolsOf(turn)).toContain("bash");
    expect(answerOf(turn)).toContain("42-ok");
  });

  it("asks before an edit, and the approved edit lands", async () => {
    await withinBudget();
    const s = await client.startSession({ project: "smoke" });
    const turn = await client.sendMessage(s.id, {
      content:
        "In the file notes/todo.md, change the word 'pending' to 'done'. Use the edit or write tool; change nothing else.",
    });
    // The default mode asks: the turn ends waiting on the change, and nothing is written yet.
    expect(turn.status).toBe("waiting");
    expect(turn.stop_reason).toMatchObject({ type: "approval" });
    const files = restFiles(deployment, token);
    const text = async (path: string) => {
      let out = "";
      for await (const b of files.read(path)) out += new TextDecoder().decode(b);
      return out;
    };
    expect(await text("/smoke/notes/todo.md")).toBe("- release: pending\n");
    for (const id of turn.stop_reason?.approval_ids ?? []) {
      const { accepted } = await client.answerApproval(id, { decision: "allow", scope: "once" });
      await client.waitTurn(accepted);
    }
    expect(await text("/smoke/notes/todo.md")).toMatch(/release: done/);
  });

  it("writes a new file where it is told to, when the mode allows it", async () => {
    await withinBudget();
    await client.setMode({ mode: "acceptEdits" });
    const s = await client.startSession({ project: "smoke" });
    const turn = await client.sendMessage(s.id, {
      content: "Create the file notes/hello.txt containing exactly the text: hello nightly",
    });
    expect(turn.status).toBe("completed");
    let out = "";
    for await (const b of restFiles(deployment, token).read("/smoke/notes/hello.txt"))
      out += new TextDecoder().decode(b);
    expect(out.trim()).toBe("hello nightly");
  });

  it("charges every request to the workspace's budget, within the cap", async () => {
    const usage = await modelUsage(deployment, ADMIN_KEY);
    expect(usage.length).toBeGreaterThan(0);
    for (const r of usage)
      expect(r).toMatchObject({ provider: "nightly", model: `nightly/${MODEL}` });
    expect(await spent()).toBeLessThan(BUDGET);
  });
});
