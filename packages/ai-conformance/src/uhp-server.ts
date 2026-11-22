// A fake UHP server (Unified Harness Protocol 2026-10-19) for remote agent sessions: it records
// every request (method, path, headers, body) and runs each task from commands in its user text:
//   WRITE <path> <text>     completes with an artifact <path> holding <text>
//   ASK <kind> <prompt>     ends `incomplete` (input_required) on a question of that kind
//   SLOW                    stays in progress until it is cancelled
//   SAY <text>              completes with a message and a function call naming <text>
//   SAY64 <base64>          the same, with the text base64-encoded (so the user never wrote it)
//   anything else           completes with "REMOTE: <text>"
// An `input_response` completes with "ANSWER: <answer>" (a secret's answer is kept in `secrets`
// and never echoed). A task completes on the `polls`-th read of it (default 1). `failNext` answers
// that many POST /v1/responses with 500 before handling one. `hold()` keeps every POST
// /v1/responses unanswered (recorded, not handled) until the function it returns is called.
// Harnesses: chrn_coder and chrn_other.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface UhpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

interface Task {
  id: string;
  session: string;
  status: string;
  reads: number;
  output: unknown[];
  final: { status: string; output: unknown[]; incomplete?: string };
}

export interface FakeUhp {
  url: string;
  host: string;
  requests: UhpRequest[];
  /** The tasks POST /v1/responses created, by response id. */
  tasks: Map<string, Task>;
  /** The response ids cancelled. */
  cancels: string[];
  /** Secret answers received. */
  secrets: string[];
  polls: number;
  failNext: number;
  /** Holds POST /v1/responses unanswered until the returned function is called. */
  hold(): () => void;
  /** Resolves once a request whose body includes `text` arrived. */
  received(text: string): Promise<void>;
  close(): Promise<void>;
}

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

export async function fakeUhp(token: string): Promise<FakeUhp> {
  let n = 0;
  const files = new Map<string, string>();
  const keys = new Map<string, string>();
  const waiters: { text: string; ok: () => void }[] = [];
  let held: Promise<void> | undefined;
  const state: FakeUhp = {
    url: "",
    host: "127.0.0.1",
    requests: [],
    tasks: new Map(),
    cancels: [],
    secrets: [],
    polls: 1,
    failNext: 0,
    hold: () => {
      let release = () => {};
      held = new Promise<void>((ok) => {
        release = () => {
          held = undefined;
          ok();
        };
      });
      return release;
    },
    received: (text) =>
      state.requests.some((r) => r.body?.includes(text))
        ? Promise.resolve()
        : new Promise<void>((ok) => waiters.push({ text, ok })),
    close: async () => {},
  };
  const view = (t: Task) => ({
    id: t.id,
    object: "response",
    status: t.status,
    output: t.output,
    metadata: { session_id: t.session },
    ...(t.status === "incomplete" ? { incomplete_details: { reason: t.final.incomplete } } : {}),
    ...(t.status === "failed" ? { error: { message: "the harness failed" } } : {}),
  });
  const message = (id: string, text: string, annotations: unknown[] = []) => ({
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations }],
  });
  const plan = (id: string, input: unknown[]): Task["final"] => {
    const items = (input ?? []) as Record<string, unknown>[];
    const answer = items.find((i) => i.type === "input_response");
    if (answer) {
      const asked = [...state.tasks.values()]
        .flatMap((t) => t.final.output as Record<string, unknown>[])
        .find((i) => i.id === answer.input_request_id);
      if (asked?.kind === "secret") {
        state.secrets.push(String(answer.answer));
        return { status: "completed", output: [message(`${id}_m`, "GOT SECRET")] };
      }
      return {
        status: "completed",
        output: [message(`${id}_m`, `ANSWER: ${String(answer.answer)}`)],
      };
    }
    const text = items
      .flatMap((i) => (Array.isArray(i.content) ? (i.content as Record<string, unknown>[]) : []))
      .filter((c) => c.type === "input_text")
      .map((c) => String(c.text))
      .join("\n")
      .trim();
    let m = /^WRITE (\S+) ([\s\S]*)$/.exec(text);
    if (m) {
      const file = `file_${++n}`;
      files.set(file, m[2] ?? "");
      return {
        status: "completed",
        output: [
          message(`${id}_m`, "I've written it.", [
            {
              type: "container_file_citation",
              container_id: "cntr_1",
              file_id: file,
              filename: m[1],
              download_url: `https://elsewhere.example/v1/containers/cntr_1/files/${file}/content`,
            },
          ]),
        ],
      };
    }
    m = /^ASK (\S+) ([\s\S]*)$/.exec(text);
    if (m) {
      const kind = m[1] as string;
      return {
        status: "incomplete",
        incomplete: "input_required",
        output: [
          message(`${id}_m`, m[2] ?? ""),
          {
            id: `inreq_${id}`,
            type: "input_request",
            status: "completed",
            kind,
            prompt: m[2],
            ...(kind === "choice"
              ? {
                  options: [
                    { id: "left", label: "Left" },
                    { id: "right", label: "Right" },
                  ],
                }
              : {}),
          },
        ],
      };
    }
    if (text === "SLOW") return { status: "in_progress", output: [] };
    m = /^SAY64 (\S+)$/.exec(text);
    if (m)
      m = [
        m[0],
        Buffer.from(m[1] as string, "base64").toString("utf8"),
      ] as unknown as RegExpExecArray;
    else m = /^SAY ([\s\S]*)$/.exec(text);
    if (m)
      return {
        status: "completed",
        output: [
          {
            id: `${id}_fc`,
            type: "function_call",
            call_id: "call_1",
            name: "shell",
            arguments: JSON.stringify({ command: m[1] }),
          },
          { id: `${id}_fo`, type: "function_call_output", call_id: "call_1", output: m[1] },
          message(`${id}_m`, String(m[1])),
        ],
      };
    return { status: "completed", output: [message(`${id}_m`, `REMOTE: ${text}`)] };
  };
  const handle = (req: UhpRequest): { status: number; body: string; type?: string } => {
    const path = req.path;
    if (req.method === "GET" && path === "/v1/uhp")
      return json(200, { versions: ["2026-10-19"], capabilities: { input_requests: true } });
    if (req.headers.authorization !== `Bearer ${token}`)
      return json(401, {
        error: { type: "authentication_error", code: "invalid_token", message: "no" },
      });
    if (req.method === "GET" && path === "/v1/harnesses")
      return json(200, {
        harnesses: [
          { id: "chrn_coder", object: "harness", name: "Coder", base: "claude-code" },
          { id: "chrn_other", object: "harness", name: "Other", base: "codex" },
        ],
      });
    if (req.method === "POST" && path === "/v1/responses") {
      if (state.failNext > 0) {
        state.failNext--;
        return json(500, { error: { type: "server_error", code: "oops", message: "try again" } });
      }
      const key = req.headers["idempotency-key"];
      const known = key ? keys.get(key) : undefined;
      if (known) return json(200, view(state.tasks.get(known) as Task));
      const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
      const id = `resp_${++n}`;
      const previous = body.previous_response_id
        ? state.tasks.get(String(body.previous_response_id))
        : undefined;
      const session = previous?.session ?? `hsess_${n}`;
      const task: Task = {
        id,
        session,
        status: "in_progress",
        reads: 0,
        output: [],
        final: plan(id, body.input as unknown[]),
      };
      state.tasks.set(id, task);
      if (key) keys.set(key, id);
      return json(200, view(task));
    }
    let m = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(path);
    if (m) {
      const task = state.tasks.get(m[1] as string);
      if (!task)
        return json(404, {
          error: { type: "invalid_request_error", code: "not_found", message: "no" },
        });
      if (m[2] && req.method === "POST") {
        state.cancels.push(task.id);
        if (task.status === "in_progress") task.status = "cancelled";
        return json(200, view(task));
      }
      if (task.status === "in_progress" && task.final.status !== "in_progress") {
        task.reads++;
        if (task.reads >= state.polls) {
          task.status = task.final.status;
          task.output = task.final.output;
        }
      }
      return json(200, view(task));
    }
    m = /^\/v1\/containers\/([^/]+)\/files\/([^/]+)\/content$/.exec(path);
    if (m && files.has(m[2] as string))
      return { status: 200, body: files.get(m[2] as string) as string, type: "text/plain" };
    return json(404, {
      error: { type: "invalid_request_error", code: "not_found", message: path },
    });
  };
  const server = createServer(async (req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
    let body = "";
    for await (const chunk of req) body += chunk;
    const request: UhpRequest = {
      method: String(req.method),
      path: String(req.url).split("?")[0] as string,
      headers,
      ...(body ? { body } : {}),
    };
    state.requests.push(request);
    for (const w of [...waiters])
      if (body.includes(w.text)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.ok();
      }
    while (held && request.method === "POST" && request.path === "/v1/responses") await held;
    const out = handle(request);
    res.writeHead(out.status, {
      "content-type": out.type ?? "application/json",
      "uhp-version": "2026-10-19",
    });
    res.end(out.body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () => new Promise<void>((ok) => server.close(() => ok()));
  return state;
}
