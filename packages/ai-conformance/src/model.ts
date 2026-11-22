// The scripted model: an OpenAI-compatible chat-completions endpoint (streaming or not) whose
// replies follow commands in the last user message, so scenarios are deterministic and offline.
//   CALL <tool> <json args>   one tool call, then "RESULT: <tool output>"
//   FAIL                      the model refuses the request (HTTP 400): the turn fails
//   HOLD <name>               "OK", once the scenario releases <name> (a turn that stays running)
//   anything else             "OK"
// A summarizer request (its system prompt starts "You are summarising") is answered with the JSON
// summary the harness asks for: content "SUMMARY[<each input line without its id> / ...]", and one
// section whose refs are the first id of the input.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
  tools: string[];
  /** The request's messages, each as its role and text (a tool call as `CALL <name>`). */
  messages: { role: string; text: string }[];
  /** Whether it was a summarizer request. */
  summary: boolean;
  lastUserText: string;
  /** The model the request named. */
  model?: string;
  /** The system prompt the request carried. */
  system?: string;
}

export interface FakeModel {
  /** The OpenAI-compatible base URL (ends in /v1). */
  url: string;
  requests: ModelRequest[];
  /** Resolves once a `HOLD <name>` request has arrived (it is then held). */
  held(name: string): Promise<void>;
  /** Answers the `HOLD <name>` request (now, or as soon as it arrives). */
  release(name: string): void;
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
    requests.push({
      tools: (json.tools ?? []).map((t) => String(t.function?.name)),
      messages: messages.map((m) => ({
        role: m.role,
        text:
          text(m.content) ||
          (m.tool_calls ?? []).map((c) => `CALL ${c.function?.name ?? ""}`).join(" "),
      })),
      summary,
      lastUserText,
      model: json.model,
      system: messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => text(m.content))
        .join("\n"),
    });
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
    if (summary) {
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
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
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
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
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
