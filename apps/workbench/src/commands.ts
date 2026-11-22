// The workbench's shell: commands typed at the terminal, each one or a few calls of the session
// API (client.ts). Plain text that is no command is a message to the current agent session.
import { ApiError, type Item, type SessionClient, type Turn } from "./client.js";

/** What the shell writes to; xterm satisfies it (main.ts), and so does a test's buffer. */
export interface Output {
  writeln(line: string): void;
}

export interface ShellOptions {
  client: SessionClient;
  out: Output;
  /** The project new sessions start in. */
  project: string;
  /** Asks the person for a value without showing it (a secret's); without it, values are typed inline. */
  askHidden?: (question: string) => Promise<string>;
}

export interface Shell {
  /** Runs one line; `signal` cancels a running turn (Ctrl-C). */
  run(line: string, signal?: AbortSignal): Promise<void>;
  /** The current agent session, once one is started. */
  readonly session: string | undefined;
  readonly project: string;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const HELP = [
  "Anything that is not a command is a message to the current agent session.",
  "  agent <message>             send a message (starts a session if there is none)",
  "  new [<agent>]               start a new agent session in the current project",
  "  sessions                    list your agent sessions",
  "  use <project>               switch project (new sessions start there)",
  "  ls [<path>]                 list your files (/ shows your projects)",
  "  cat <path>                  print a file",
  "  write <path> <text>         write a file",
  "  mode <name>                 default, acceptEdits, plan, auto, bypassPermissions, dontAsk",
  "  approvals                   list approvals waiting for you",
  "  approve <id> | deny <id>    answer an approval",
  "  models                      models you may use in the current project",
  "  provider <api> <baseUrl> <model> [<secret>]",
  "                              your own model provider (api: openai-completions, ...)",
  "  secret set <NAME> <plugin> <host> [<value>]   (asked for, unseen, when left out)",
  "  secret list | secret rm <NAME>",
  "                              your own secrets (a browser page keeps no one else's)",
  "  whoami | help",
];

/** Splits a line into words; "double quotes" keep spaces. */
export function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g))
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : String(m[2]));
  return out;
}

const short = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function createShell(options: ShellOptions): Shell {
  const { client, out } = options;
  let project = options.project;
  let session: string | undefined;

  const showItem = (item: Item) => {
    if (item.kind === "message" && item.role === "assistant" && item.text)
      for (const line of item.text.split("\n")) out.writeln(line);
    else if (item.kind === "tool_call")
      out.writeln(cyan(`⚙ ${item.name} ${short(JSON.stringify(item.args ?? {}), 200)}`));
    else if (item.kind === "tool_result")
      out.writeln((item.isError ? red : dim)(`→ ${short(String(item.output ?? ""))}`));
    else if (item.kind === "approval")
      out.writeln(
        yellow(`? approval ${item.approval}: approve ${item.approval} | deny ${item.approval}`),
      );
    else if (item.kind === "model_fallback") out.writeln(dim(`(model fallback)`));
  };

  const showEnd = (turn: Turn) => {
    if (turn.status === "completed") return;
    if (turn.status === "waiting")
      out.writeln(
        yellow(`turn waiting for approval: ${(turn.stop_reason?.approval_ids ?? []).join(", ")}`),
      );
    else out.writeln(red(`turn ${turn.status}${turn.error ? `: ${turn.error}` : ""}`));
  };

  async function follow(accepted: Parameters<SessionClient["follow"]>[0], signal?: AbortSignal) {
    const cancel = () => void client.cancelTurn(accepted.turn_id).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      for await (const step of client.follow(accepted)) {
        if ("item" in step) {
          if (step.item.role !== "user") showItem(step.item);
        } else showEnd(step.turn);
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async function start(agent?: string) {
    const s = await client.startSession({ project, ...(agent ? { agent } : {}) });
    session = s.id;
    out.writeln(dim(`session ${s.id} (${s.agent}) in ${s.project}`));
  }

  async function send(message: string, signal?: AbortSignal) {
    if (!message) return out.writeln("usage: agent <message>");
    if (!session) await start();
    await follow(await client.postMessage(String(session), message), signal);
  }

  async function run(line: string, signal?: AbortSignal): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [cmd, ...args] = words(trimmed);
    const rest = trimmed.slice(trimmed.indexOf(String(cmd)) + String(cmd).length).trim();
    try {
      switch (cmd) {
        case "help":
          for (const l of HELP) out.writeln(l);
          return;
        case "whoami": {
          const me = await client.me();
          out.writeln(`${me.user} (mode ${me.mode}), project ${project}`);
          return;
        }
        case "agent":
          return await send(rest, signal);
        case "new":
          return await start(args[0]);
        case "use":
          if (!args[0]) return out.writeln("usage: use <project>");
          project = args[0];
          session = undefined;
          out.writeln(dim(`project ${project}`));
          return;
        case "sessions": {
          const { sessions } = await client.listSessions();
          for (const s of sessions)
            out.writeln(
              `${s.id === session ? "*" : " "} ${s.id} ${s.project} ${s.agent} ${s.status ?? ""}`,
            );
          return;
        }
        case "ls":
          for (const e of await client.list(args[0] ?? `/${project}`))
            out.writeln(e.kind === "directory" ? `${e.name}/` : e.name);
          return;
        case "cat":
          if (!args[0]) return out.writeln("usage: cat <path>");
          for (const l of (await client.read(args[0])).split("\n")) out.writeln(l);
          return;
        case "write": {
          const [path] = args;
          if (!path) return out.writeln("usage: write <path> <text>");
          await client.write(path, args.slice(1).join(" "));
          out.writeln(dim(`wrote ${path}`));
          return;
        }
        case "mode":
          if (!args[0]) return out.writeln("usage: mode <name>");
          await client.setMode(args[0]);
          out.writeln(dim(`mode ${args[0]}`));
          return;
        case "approvals": {
          const { approvals } = await client.listApprovals();
          const pending = approvals.filter((a) => a.status === "pending" || a.status === "blocked");
          if (!pending.length) out.writeln(dim("no approvals waiting"));
          for (const a of pending)
            out.writeln(`${a.id} ${a.permission} ${a.action.method} ${a.action.path}: ${a.reason}`);
          return;
        }
        case "approve":
        case "deny": {
          if (!args[0]) return out.writeln(`usage: ${cmd} <id>`);
          const answer = await client.answerApproval(args[0], cmd === "approve" ? "allow" : "deny");
          if (answer.accepted) await follow(answer.accepted, signal);
          return;
        }
        case "models": {
          const { models } = await client.listModels(project);
          if (!models.length) out.writeln(dim("no model you may use here: try `provider`"));
          for (const m of models)
            out.writeln(`${m.id}${m.alias?.length ? ` (${m.alias.join(", ")})` : ""}`);
          return;
        }
        case "provider": {
          const [api, baseUrl, model, secret] = args;
          if (!api || !baseUrl || !model)
            return out.writeln("usage: provider <api> <baseUrl> <model> [<secret>]");
          const id = `mine/${model}`;
          await client.setModelConfig({
            providers: [{ id: "mine", api, baseUrl, ...(secret ? { secret } : {}) }],
            models: [{ id }],
            default: id,
          });
          out.writeln(dim(`your provider: ${baseUrl}, default model ${id}`));
          if (secret)
            out.writeln(
              dim(`set its key: secret set ${secret} model-gateway ${new URL(baseUrl).hostname}`),
            );
          return;
        }
        case "secret":
          return await secretCommand(args);
        default:
          return await send(trimmed, signal);
      }
    } catch (e) {
      const message =
        e instanceof ApiError ? `${e.status}: ${e.message}` : String((e as Error)?.message ?? e);
      out.writeln(red(message));
    }
  }

  async function secretCommand(args: string[]) {
    const [sub, name, plugin, host, value] = args;
    if (sub === "list") {
      const { secrets } = await client.listSecrets();
      if (!secrets.length) out.writeln(dim("no secrets"));
      for (const s of secrets) out.writeln(`${s.name} ${JSON.stringify(s.bindings)}`);
    } else if (sub === "set" && name && plugin && host && (value || options.askHidden)) {
      const v = value ?? (await options.askHidden?.(`value of ${name}: `)) ?? "";
      if (!v) return out.writeln(dim("no value: nothing set"));
      await client.setSecret(name, v, { plugins: [plugin], hosts: [host] });
      out.writeln(dim(`secret ${name} set for ${plugin} at ${host}`));
    } else if (sub === "rm" && name) {
      await client.deleteSecret(name);
      out.writeln(dim(`secret ${name} removed`));
    } else
      out.writeln(
        "usage: secret set <NAME> <plugin> <host> [<value>] | secret list | secret rm <NAME>",
      );
  }

  return {
    run,
    get session() {
      return session;
    },
    get project() {
      return project;
    },
  };
}
