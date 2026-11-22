// A fake remote MCP server for scenarios where plugins bring one (statewalker/statewalker-root#135):
// Streamable HTTP in the stateless 2026-07-28 revision (no `initialize`, every POST carrying
// `MCP-Protocol-Version` and `Mcp-Method`, `Mcp-Name` on `tools/call`, the version and the client's
// capabilities in `_meta`). It records every request, and answers only one carrying the token it
// holds (`Authorization: Bearer <token>`; 401 otherwise), as JSON or, with `sse`, as a
// request-scoped SSE stream. Its tools:
//   - `lookup` {query}: answers `found: <query>`;
//   - `stamp` {text}: answers `stamped: <text>` (it claims `readOnlyHint`, which is only a hint);
//   - `echo_auth` {}: answers the Authorization header it was sent (a service echoing a key).
// `tools/list` answers one tool per page, so a client must follow `nextCursor`.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface McpServerRequest {
  /** Path and query, as received. */
  url: string;
  headers: Record<string, string>;
  /** The JSON-RPC message, parsed. */
  body: { id?: unknown; method?: string; params?: Record<string, unknown> };
}

export interface FakeMcp {
  /** `http://127.0.0.1:<port>`; the endpoint is any path. */
  url: string;
  requests: McpServerRequest[];
  /** The bearer token it requires; changing it makes later requests fail with 401. */
  token: string;
  /** Answer with an SSE stream instead of a JSON body. */
  sse: boolean;
  /** The `tools/call` requests it received for a tool. */
  calls(tool: string): McpServerRequest[];
  close(): Promise<void>;
}

export const MCP_REVISION = "2026-07-28";

const TOOLS = [
  {
    name: "lookup",
    description: "Looks something up",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "stamp",
    description: "Stamps a text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    // A hint the harness never trusts: the plugin decides a tool's action.
    annotations: { readOnlyHint: true },
  },
  {
    name: "echo_auth",
    description: "Answers the Authorization header it received",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function fakeMcp(token: string): Promise<FakeMcp> {
  const state: FakeMcp = {
    url: "",
    requests: [],
    token,
    sse: false,
    calls: (tool) =>
      state.requests.filter((r) => r.body.method === "tools/call" && r.body.params?.name === tool),
    close: async () => {},
  };
  const server = createServer(async (req, res) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
    let text = "";
    for await (const chunk of req) text += chunk;
    let body: McpServerRequest["body"] = {};
    try {
      body = JSON.parse(text);
    } catch {
      // answered below
    }
    state.requests.push({ url: String(req.url), headers, body });
    const answer = (status: number, message: unknown) => {
      if (state.sse && status === 200) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
      }
    };
    const error = (status: number, code: number, message: string) =>
      answer(status, { jsonrpc: "2.0", id: body.id ?? null, error: { code, message } });
    if (req.method !== "POST") return error(405, -32600, "POST only");
    if (headers.authorization !== `Bearer ${state.token}`) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="fake-mcp"',
      });
      return res.end(JSON.stringify({ error: "invalid_token" }));
    }
    const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
    if (
      headers["mcp-protocol-version"] !== MCP_REVISION ||
      meta["io.modelcontextprotocol/protocolVersion"] !== MCP_REVISION ||
      typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object"
    )
      return error(400, -32600, "unsupported or missing protocol version");
    if (headers["mcp-method"] !== body.method)
      return error(400, -32600, "Mcp-Method does not match the body");
    if (body.method === "tools/list") {
      const at = Number(body.params?.cursor ?? 0) || 0;
      const next = at + 1 < TOOLS.length ? { nextCursor: String(at + 1) } : {};
      return answer(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: TOOLS.slice(at, at + 1), ...next },
      });
    }
    if (body.method === "tools/call") {
      const name = String(body.params?.name);
      if (headers["mcp-name"] !== name) return error(400, -32600, "Mcp-Name does not match");
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      const out =
        name === "lookup"
          ? `found: ${String(args.query)}`
          : name === "stamp"
            ? `stamped: ${String(args.text)}`
            : name === "echo_auth"
              ? `auth: ${headers.authorization}`
              : undefined;
      if (out === undefined) return error(200, -32602, `no tool ${name}`);
      return answer(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: out }], isError: false },
      });
    }
    return error(200, -32601, `no method ${body.method}`);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () => new Promise<void>((ok) => server.close(() => ok()));
  return state;
}
