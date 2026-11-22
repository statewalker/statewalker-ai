// The scripted model: an OpenAI-compatible chat-completions endpoint (streaming or not) whose
// replies follow commands in the last user message, so scenarios are deterministic and offline.
//   CALL <tool> <json args>   one tool call, then "RESULT: <tool output>"
//   FAIL                      the model refuses the request (HTTP 400): the turn fails
//   HOLD <name>               "OK", once the scenario releases <name> (a turn that stays running)
//   BIG <name>                "OK", reporting 140000 prompt tokens (a context near a large window)
//   anything else             "OK"
// A model name can be made to fail (`fail(name, status)`): its requests answer that HTTP status, so
// scenarios can overload, rate-limit or refuse one model and watch the gateway fall back. Every
// answer reports the same usage (12 prompt tokens, 4 of them cached, 3 completion tokens), and
// GET /v1/models lists the names in `listed` (a provider's discovery endpoint).
// A summarizer request (its system prompt starts "You are summarising") is answered with the JSON
// summary the harness asks for: content "SUMMARY[<each input line without its id> / ...]", and one
// section whose refs are the first id of the input.
// A risk classifier request (its system prompt starts "You are the risk classifier") obeys the
// last `CLASSIFY <answer>` anywhere in what it is shown, as a model open to injection would:
// allow, ask or deny answer that verdict as JSON, `garbage` answers something that is not JSON,
// `slow` answers allow after 3 s; with none it denies.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
  tools: string[];
  /** The request's messages, each as its role and text (a tool call as `CALL <name>`). */
  messages: { role: string; text: string }[];
  /** Whether it was a summarizer request. */
  summary: boolean;
  /** Whether it was a risk classifier request. */
  classifier: boolean;
  lastUserText: string;
  /** The model the request named. */
  model?: string;
  /** The system prompt the request carried. */
  system?: string;
  /** The request's Authorization header: the key the gateway injected. */
  authorization?: string;
}

export interface FakeModel {
  /** The OpenAI-compatible base URL (ends in /v1). */
  url: string;
  requests: ModelRequest[];
  /** Resolves once a `HOLD <name>` request has arrived (it is then held). */
  held(name: string): Promise<void>;
  /** Answers the `HOLD <name>` request (now, or as soon as it arrives). */
  release(name: string): void;
  /** Makes every request naming `model` answer HTTP `status` (until `heal(model)`). */
  fail(model: string, status: number): void;
  heal(model: string): void;
  /** The model names GET /v1/models lists. */
  listed: string[];
  /**
   * The deployment's model configuration (the MODELS var) for this server: one provider,
   * "scripted", and its models (`scripted/default` unless others are given), the first the default.
   */
  deploymentModels(config?: { models?: Record<string, unknown>[]; default?: string }): string;
  close(): Promise<void>;
}

type Part = { text?: string };
type ChatMessage = {
  role: string;
  content?: string | Part[] | null;
  tool_calls?: { function?: { name?: string } }[];
};
const text = (c: ChatMessage["content"]) =>
  typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join("");

async function body(req: IncomingMessage): Promise<string> {
  let b = "";
  for await (const chunk of req) b += chunk;
  return b;
}

interface Hold {
  arrived: Promise<void>;
  arrive(): void;
  released: Promise<void>;
  release(): void;
}

export async function fakeModel(): Promise<FakeModel> {
  const requests: ModelRequest[] = [];
  const failing = new Map<string, number>();
  const listed: string[] = [];
  const holds = new Map<string, Hold>();
  const hold = (name: string): Hold => {
    let h = holds.get(name);
    if (!h) {
      const d = { arrive: () => {}, release: () => {} };
      const arrived = new Promise<void>((ok) => {
        d.arrive = ok;
      });
      const released = new Promise<void>((ok) => {
        d.release = ok;
      });
      h = { arrived, released, ...d };
      holds.set(name, h);
    }
    return h;
  };
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: listed.map((id) => ({ id, object: "model", owned_by: "scripted" })),
        }),
      );
      return;
    }
    const json = JSON.parse((await body(req)) || "{}") as {
      model?: string;
      stream?: boolean;
      messages?: ChatMessage[];
      tools?: { function?: { name?: string } }[];
    };
    const messages = json.messages ?? [];
    const lastUserText = text(
      [...messages].reverse().find((m) => m.role === "user")?.content,
    ).trim();
    const system = text(messages.find((m) => m.role === "system")?.content);
    const summary = system.startsWith("You are summarising");
    const classifier = system.startsWith("You are the risk classifier");
    requests.push({
      tools: (json.tools ?? []).map((t) => String(t.function?.name)),
      messages: messages.map((m) => ({
        role: m.role,
        text:
          text(m.content) ||
          (m.tool_calls ?? []).map((c) => `CALL ${c.function?.name ?? ""}`).join(" "),
      })),
      summary,
      classifier,
      lastUserText,
      model: json.model,
      system: messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => text(m.content))
        .join("\n"),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    });
    const status = failing.get(String(json.model));
    if (status) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `the scripted model answers ${status}`, code: status },
        }),
      );
      return;
    }
    if (lastUserText === "FAIL" && messages.at(-1)?.role === "user") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "the scripted model refuses", type: "invalid_request_error" },
        }),
      );
      return;
    }
    const held = /^HOLD\s+(\S+)/.exec(lastUserText);
    if (held && messages.at(-1)?.role === "user") {
      const h = hold(String(held[1]));
      h.arrive();
      await h.released;
    }
    const call = /^CALL\s+(\S+)\s*([\s\S]*)$/.exec(lastUserText);
    let message: Record<string, unknown>;
    let finish: string;
    if (classifier) {
      const directive = [...lastUserText.matchAll(/CLASSIFY\s+(\w+)/g)].at(-1)?.[1];
      if (directive === "slow") await new Promise((ok) => setTimeout(ok, 3000));
      const verdict = directive === "slow" ? "allow" : directive;
      message = {
        role: "assistant",
        content:
          directive === "garbage"
            ? "I think it is probably fine"
            : JSON.stringify(
                verdict === "allow" || verdict === "ask" || verdict === "deny"
                  ? { verdict, reason: `the scripted classifier says ${verdict}` }
                  : { verdict: "deny", reason: "the scripted classifier was told nothing" },
              ),
      };
      finish = "stop";
    } else if (summary) {
      const lines = lastUserText.split("\n");
      const first = /^\[([^\]]+)\]/.exec(lines[0] ?? "")?.[1];
      const content = `SUMMARY[${lines
        .filter((l) => l.startsWith("["))
        .map((l) => l.replace(/^\[[^\]]+\]\s*/, ""))
        .join(" / ")}]`;
      message = {
        role: "assistant",
        content: JSON.stringify({
          content,
          sections: first ? [{ title: "Part", body: content, refs: [first] }] : null,
        }),
      };
      finish = "stop";
    } else if (messages.at(-1)?.role === "tool") {
      const results: string[] = [];
      for (let i = messages.length - 1; i >= 0 && messages[i]?.role === "tool"; i--)
        results.unshift(text(messages[i]?.content));
      message = { role: "assistant", content: `RESULT: ${results.join(" | ")}` };
      finish = "stop";
    } else if (call) {
      const id = `call_${requests.length}`;
      const fn = { name: call[1], arguments: call[2] || "{}" };
      message = {
        role: "assistant",
        tool_calls: [{ index: 0, id, type: "function", function: fn }],
      };
      finish = "tool_calls";
    } else {
      message = { role: "assistant", content: "OK" };
      finish = "stop";
    }
    const big = /^BIG\b/.test(lastUserText) && messages.at(-1)?.role === "user";
    const usage = {
      prompt_tokens: big ? 140_000 : 12,
      completion_tokens: 3,
      total_tokens: big ? 140_003 : 15,
      prompt_tokens_details: { cached_tokens: 4 },
    };
    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "c",
          object: "chat.completion",
          model: json.model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        }),
      );
      return;
    }
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: json.model, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk(message, null));
    res.write(chunk({}, finish));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/v1`;
  return {
    url,
    requests,
    listed,
    fail: (model, status) => failing.set(model, status),
    heal: (model) => failing.delete(model),
    deploymentModels: (config = {}) => {
      const models = config.models ?? [{ id: "scripted/default", alias: "default" }];
      return JSON.stringify({
        providers: [{ id: "scripted", api: "openai-completions", baseUrl: url }],
        models,
        default: config.default ?? String(models[0]?.id),
      });
    },
    held: (name) => hold(name).arrived,
    release: (name) => hold(name).release(),
    close: () =>
      new Promise<void>((ok) => {
        for (const h of holds.values()) h.release();
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
