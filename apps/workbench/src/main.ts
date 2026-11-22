// The workbench page: a terminal (xterm) whose shell talks to the harness through the session
// API. The harness runs in this page on CellB (in-page.ts), or, with `?deployment=<url>&token=<t>`,
// is a deployment elsewhere.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type DeploymentFetch, devLogin, sessionClient } from "./client.js";
import { createShell } from "./commands.js";
import { startInPageHarness } from "./in-page.js";

const PROJECT = "home";
/** What a key press adds to a line: its characters from space up (no control characters). */
const printableOf = (data: string) => [...data].filter((c) => c >= " " && c !== "\x7f").join("");
const PROMPT = "\x1b[36m›\x1b[0m ";

function randomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The harness in this page, with a project of the user's own. */
async function inPage(user: string): Promise<{ fetch: DeploymentFetch; token: string }> {
  // The page's own admin key, made for this load: only this page reaches its harness.
  const adminKey = randomKey();
  const fetch = await startInPageHarness({ ADMIN_KEY: adminKey });
  const res = await fetch("/admin/seed", {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      files: { [`/${PROJECT}/.system/access`]: JSON.stringify({ [user]: "owner" }) },
    }),
  });
  if (!res.ok)
    throw new Error(`the harness refused its project: ${res.status} ${await res.text()}`);
  return { fetch, token: await devLogin(fetch, user) };
}

async function main() {
  const host = document.getElementById("term") as HTMLElement;
  const term = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontSize: 13,
    theme: { background: "#1e1e1e" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(host);
  term.writeln("\x1b[36mharness workbench\x1b[0m: starting the harness…");

  const params = new URL(location.href).searchParams;
  const remote = params.get("deployment");
  let fetch: DeploymentFetch;
  let token: string;
  if (remote) {
    fetch = (path, init) => globalThis.fetch(new URL(path, remote), init);
    token = params.get("token") ?? "";
  } else {
    const user = localStorage.getItem("ai-workbench.user") || "me";
    ({ fetch, token } = await inPage(user));
  }
  // A value asked for without echo (a secret's): what is typed goes here until Enter.
  let hidden: { value: string; done(value: string): void } | undefined;
  const askHidden = (question: string) =>
    new Promise<string>((done) => {
      term.write(question);
      hidden = { value: "", done };
    });
  const shell = createShell({
    client: sessionClient(fetch, token),
    project: PROJECT,
    out: term,
    askHidden,
  });
  term.writeln(remote ? `connected to ${remote}` : "the harness runs in this page; type `help`.");
  term.write(PROMPT);

  let line = "";
  let running: AbortController | undefined;
  term.onData(async (data) => {
    if (hidden) {
      const h = hidden;
      if (data === "\r" || data === "\x03") {
        hidden = undefined;
        term.write("\r\n");
        h.done(data === "\r" ? h.value : "");
      } else if (data === "\x7f") h.value = h.value.slice(0, -1);
      else h.value += printableOf(data);
      return;
    }
    if (data === "\x03") {
      running?.abort();
      if (!running) {
        line = "";
        term.write(`^C\r\n${PROMPT}`);
      }
      return;
    }
    if (running) return;
    if (data === "\r") {
      term.write("\r\n");
      const input = line;
      line = "";
      running = new AbortController();
      try {
        await shell.run(input, running.signal);
      } finally {
        running = undefined;
        term.write(PROMPT);
      }
    } else if (data === "\x7f") {
      if (line) {
        line = line.slice(0, -1);
        term.write("\b \b");
      }
    } else if (data >= " " || data.length > 1) {
      const printable = printableOf(data);
      line += printable;
      term.write(printable);
    }
  });
}

main().catch((e) => {
  document.body.textContent = `The workbench could not start: ${String((e as Error)?.message ?? e)}`;
});
