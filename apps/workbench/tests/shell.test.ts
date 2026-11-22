// The workbench's shell against a live deployment of the harness (ai-host-do on CellB, through
// ai-conformance's runner) with the scripted model: everything it shows comes through the session
// API, over the same client the page uses (src/client.ts).
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  seed,
  startDeployment,
} from "@statewalker/ai-conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devLogin, sessionClient } from "../src/client.js";
import { createShell, type Shell, words } from "../src/commands.js";

const HOST = new URL("../../../packages/ai-host-do/", import.meta.url);
const ADMIN_KEY = "workbench-admin-key";
// biome-ignore lint/suspicious/noControlCharactersInRegex: the terminal colours are escape sequences.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  // A browser deployment, as the page runs it: it keeps only its users' own secrets.
  deployment = await startDeployment(HOST, {
    HOSTING: "browser",
    MODELS: model.deploymentModels(),
    DEV_LOGIN: "true",
    ADMIN_KEY,
    USER_PROVIDER_HOSTS: "127.0.0.1",
  });
  await seed(deployment, ADMIN_KEY, {
    "/notes/.system/access": JSON.stringify({ wb: "owner", wb2: "owner" }),
    "/notes/todo.md": "- ship the workbench\n",
  });
}, 120_000);
afterAll(async () => {
  await deployment?.close();
  await model?.close();
});

async function shellFor(
  user: string,
  askHidden?: (question: string) => Promise<string>,
): Promise<{ shell: Shell; lines: string[] }> {
  const fetch = (path: string, init?: RequestInit) => deployment.fetch(path, init);
  const client = sessionClient(fetch, await devLogin(fetch, user));
  const lines: string[] = [];
  const shell = createShell({
    client,
    project: "notes",
    out: { writeln: (l) => lines.push(plain(l)) },
    askHidden,
  });
  return { shell, lines };
}

describe("the workbench shell", () => {
  it("splits a line into words, keeping quoted spaces", () => {
    expect(words(`write a.md "two words" three`)).toEqual(["write", "a.md", "two words", "three"]);
  });

  it("sends plain text to a new agent session and shows the agent's answer", async () => {
    const { shell, lines } = await shellFor("wb");
    await shell.run("hello there");
    expect(shell.session).toBeDefined();
    expect(lines).toContain("OK");
    expect(model.requests.at(-1)?.lastUserText).toBe("hello there");
  });

  it("lists, reads and writes the user's files through the session API", async () => {
    const { shell, lines } = await shellFor("wb");
    await shell.run("ls /");
    expect(lines).toContain("notes/");
    await shell.run("cat /notes/todo.md");
    expect(lines).toContain("- ship the workbench");
    await shell.run('write /notes/idea.md "a new idea"');
    lines.length = 0;
    await shell.run("ls");
    expect(lines).toEqual(expect.arrayContaining(["idea.md", "todo.md"]));
  });

  it("shows the agent's tool calls and their results as they come", async () => {
    const { shell, lines } = await shellFor("wb");
    await shell.run(`agent CALL read {"path":"todo.md"}`);
    expect(lines.some((l) => l.startsWith("⚙ read"))).toBe(true);
    expect(lines.some((l) => l.startsWith("→") && l.includes("ship the workbench"))).toBe(true);
  });

  it("shows an approval a change waits on, and approving it runs the change", async () => {
    const { shell, lines } = await shellFor("wb");
    await shell.run("mode default");
    await shell.run(`agent CALL write {"path":"asked.md","content":"approved"}`);
    const waiting = lines.find((l) => l.startsWith("turn waiting for approval:"));
    expect(waiting).toBeDefined();
    const id = String(waiting?.split(": ")[1]);
    lines.length = 0;
    await shell.run("approvals");
    expect(lines.some((l) => l.startsWith(id))).toBe(true);
    await shell.run(`approve ${id}`);
    lines.length = 0;
    await shell.run("cat /notes/asked.md");
    expect(lines).toContain("approved");
  });

  it("keeps the user's own secrets, never showing a value", async () => {
    const { shell, lines } = await shellFor("wb2");
    await shell.run("secret set MY_KEY model-gateway api.example.com sk-own-1234");
    await shell.run("secret list");
    expect(lines.some((l) => l.startsWith("MY_KEY "))).toBe(true);
    expect(lines.join("\n")).not.toContain("sk-own-1234");
    await shell.run("secret rm MY_KEY");
    lines.length = 0;
    await shell.run("secret list");
    expect(lines).toEqual(["no secrets"]);
  });

  it("asks for a secret's value unseen when the command leaves it out", async () => {
    const asked: string[] = [];
    const { shell, lines } = await shellFor("wb2", async (q) => {
      asked.push(q);
      return "sk-asked-9876";
    });
    await shell.run("secret set ASKED model-gateway api.example.com");
    expect(asked).toEqual(["value of ASKED: "]);
    await shell.run("secret list");
    expect(lines.some((l) => l.startsWith("ASKED "))).toBe(true);
    expect(lines.join("\n")).not.toContain("sk-asked-9876");
    await shell.run("secret rm ASKED");
  });

  it("configures the user's own model provider, then lists it among the usable models", async () => {
    const { shell, lines } = await shellFor("wb2");
    await shell.run(`provider openai-completions ${model.url} own-model`);
    lines.length = 0;
    await shell.run("models");
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^mine\/own-model/)]));
  });

  it("starts a new session on `new` and lists the user's sessions, the current one marked", async () => {
    const { shell, lines } = await shellFor("wb");
    await shell.run("new");
    const id = String(shell.session);
    lines.length = 0;
    await shell.run("sessions");
    expect(lines).toContainEqual(
      expect.stringMatching(new RegExp(`^\\* ${id.replace(/[.]/g, "\\.")} notes `)),
    );
  });

  it("reports a refusal instead of failing", async () => {
    const { shell, lines } = await shellFor("wb");
    await shell.run("use elsewhere");
    await shell.run("hello");
    expect(lines.at(-1)).toMatch(/^403: /);
  });
});
