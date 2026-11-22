// Remote MCP servers (statewalker/statewalker-root#135, decided in #73). A plugin's `mcp.json`
// (Agent Plugins' `mcpServers` map, the loader having made Claude Code's `http` into
// `streamable-http`) names the servers its tools come from. Only Streamable HTTP runs: stdio needs a
// subprocess and HTTP+SSE is deprecated, so those answer ENOSYS. The host-side gateway (the
// Workspace DO) lists each server's tools and calls them through the secrets gateway, so:
//
//   - credentials are never in the plugin's files: a header or query value that looks like one must
//     be a secret reference, `${NAME}` (Claude Code's form) or `{{secret:NAME}}`, resolved only by
//     the gateway where the secret's binding names the plugin and the host;
//   - the remote server's `readOnlyHint` is never trusted: a tool reads only where the plugin says
//     so (`x-dev.cellb.harness: {actions: {<tool>: read|write|admin}}`), and writes otherwise;
//   - the tools become tool definitions of the plugin (`<plugin>__<tool>`), offered and re-checked
//     at every call like any other.
//
// The protocol is the stateless 2026-07-28 revision: no `initialize`, every request a POST
// carrying `MCP-Protocol-Version`, `Mcp-Method` (and `Mcp-Name` for `tools/call`), and the version
// and the client's capabilities in `_meta`; the answer is JSON or a request-scoped SSE stream.
import { type FilesApi, tryReadText } from "@statewalker/webrun-files";
import { isPluginName } from "./loader.js";
import {
  closedSchema,
  type JsonSchema,
  OPERATION_ID,
  TOOL_EXTENSION,
  type ToolAction,
  type ToolDefinition,
  toolDefinition,
} from "./tools.js";

/** The MCP revision the gateway speaks. */
export const MCP_REVISION = "2026-07-28";

/** One server of a plugin's `mcp.json`, as the gateway may reach it. */
export interface McpServer {
  plugin: string;
  /** Its key in `mcpServers`. */
  server: string;
  transport: string;
  /** The endpoint (http or https), secret references as placeholders. */
  url?: string;
  /** Headers sent with every request, secret references as placeholders. */
  headers: Record<string, string>;
  /** The tools the plugin says only read (or are admin); every other tool writes. */
  actions: Record<string, ToolAction>;
  /** Why the gateway does not reach it (ENOSYS for a transport that can't run). */
  problem?: string;
}

/** The route of an MCP tool (see ToolRoute). */
export interface McpRoute {
  kind: "mcp";
  url: string;
  /** The tool's name on the server. */
  name: string;
  server?: string;
  headers?: Record<string, string>;
}

const ACTIONS: readonly ToolAction[] = ["read", "write", "admin"];
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Header or parameter names that carry credentials. */
const CREDENTIAL = /auth|token|secret|key|password|passwd|cookie|session|signature|credential/i;
const HAS_PLACEHOLDER = /\{\{secret:[A-Za-z_][A-Za-z0-9_]*\}\}/;

/** `${NAME}` (Claude Code's environment references) as the gateway's `{{secret:NAME}}`. */
const placeholders = (text: string) =>
  text.replace(/\$\{([^{}]*)\}/g, (all, name: string) =>
    SECRET_NAME.test(name) ? `{{secret:${name}}}` : all,
  );

/** The servers of one plugin's `mcp.json` document. */
export function mcpServersOf(plugin: string, doc: unknown): McpServer[] {
  const servers = (doc as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  const out: McpServer[] = [];
  for (const [server, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;
    const transport =
      typeof s.type === "string"
        ? s.type === "http"
          ? "streamable-http"
          : s.type
        : typeof s.command === "string"
          ? "stdio"
          : "streamable-http";
    const ext = s[TOOL_EXTENSION] as { actions?: unknown } | undefined;
    const actions: Record<string, ToolAction> = {};
    if (ext?.actions && typeof ext.actions === "object")
      for (const [tool, a] of Object.entries(ext.actions as Record<string, unknown>))
        if (ACTIONS.includes(a as ToolAction)) actions[tool] = a as ToolAction;
    const entry: McpServer = { plugin, server, transport, headers: {}, actions };
    const refuse = (problem: string) => out.push({ ...entry, problem });
    if (transport !== "streamable-http") {
      refuse(`ENOSYS: ${transport} MCP servers do not run here; only Streamable HTTP does`);
      continue;
    }
    const url = typeof s.url === "string" ? placeholders(s.url) : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      refuse("EINVAL: its url is not an http or https URL");
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      refuse("EINVAL: its url is not an http or https URL");
      continue;
    }
    const literal = (name: string, value: string) =>
      CREDENTIAL.test(name) && value !== "" && !HAS_PLACEHOLDER.test(value);
    if (parsed.username || parsed.password) {
      refuse("EINVAL: credentials in its url; name a secret instead");
      continue;
    }
    // A query parameter that looks like a credential must be a secret reference.
    const query = (url.split("#")[0]?.split("?")[1] ?? "").split("&").filter(Boolean);
    const leaks = query.some((pair) => {
      const [k = "", v = ""] = pair.split("=");
      let key = k;
      try {
        key = decodeURIComponent(k);
      } catch {
        // as written
      }
      return literal(key, v);
    });
    if (leaks) {
      refuse("EINVAL: a credential in its url; name a secret instead");
      continue;
    }
    const headers: Record<string, string> = {};
    let bad = "";
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers))
      for (const [name, v] of Object.entries(s.headers as Record<string, unknown>)) {
        const value = placeholders(String(v));
        if (literal(name, value) || /[\r\n]/.test(name + value)) bad ||= name;
        else headers[name] = value;
      }
    if (bad) {
      refuse(`EINVAL: the header '${bad}' holds a credential; name a secret instead`);
      continue;
    }
    out.push({ ...entry, url, headers });
  }
  return out;
}

/** Every MCP server of a catalog's plugins (or of the plugins named), in plugin and key order. */
export async function catalogMcpServers(
  catalog: FilesApi,
  plugins?: readonly string[],
): Promise<McpServer[]> {
  const names: string[] = [];
  if (plugins) names.push(...plugins.filter(isPluginName));
  else if ((await catalog.stats("/"))?.kind === "directory")
    for await (const e of catalog.list("/"))
      if (e.kind === "directory" && isPluginName(e.name)) names.push(e.name);
  const out: McpServer[] = [];
  for (const plugin of names.sort()) {
    const text = await tryReadText(catalog, `/${plugin}/mcp.json`);
    if (text === undefined) continue;
    try {
      out.push(...mcpServersOf(plugin, JSON.parse(text)));
    } catch {
      // The loader wrote it; an unreadable one gives no servers.
    }
  }
  return out;
}

const MAX_TOOLS = 256;
const MAX_SCHEMA = 64 * 1024;
const MAX_DESCRIPTION = 2048;
/** A remote name the `Mcp-Name` header can carry as is. */
const REMOTE_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;

/** A remote tool's name as an operationId of the profile: snake_case, at most 48. */
function toolIdOf(name: string): string | undefined {
  const id = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^[^a-z]+/, "")
    .slice(0, 48)
    .replace(/_+$/, "");
  return OPERATION_ID.test(id) ? id : undefined;
}

/**
 * The tools a server listed, as tool definitions of its plugin (source `mcp`): input schemas
 * closed, the remote name kept in the route, an action only the plugin gives. Tools whose names
 * can't be carried or collide, or whose schemas are too large, are left out with a problem.
 */
export function mcpTools(
  server: McpServer,
  listed: readonly unknown[],
  taken: ReadonlySet<string> = new Set(),
): { tools: ToolDefinition[]; problems: string[] } {
  const tools: ToolDefinition[] = [];
  const problems: string[] = [];
  const seen = new Set(taken);
  for (const raw of listed.slice(0, MAX_TOOLS)) {
    const t = (raw ?? {}) as { name?: unknown; description?: unknown; inputSchema?: unknown };
    const name = typeof t.name === "string" ? t.name : "";
    const id = REMOTE_NAME.test(name) ? toolIdOf(name) : undefined;
    const where = `${server.plugin}/${server.server}`;
    if (!id) {
      problems.push(`${where}: the tool name '${name.slice(0, 64)}' can't be used; skipped`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${where}: the tool '${name}' is named like another as '${id}'; skipped`);
      continue;
    }
    if (JSON.stringify(t.inputSchema ?? {}).length > MAX_SCHEMA) {
      problems.push(`${where}: the input schema of '${name}' is too large; skipped`);
      continue;
    }
    seen.add(id);
    tools.push(
      toolDefinition({
        plugin: server.plugin,
        tool: id,
        source: "mcp",
        description:
          (typeof t.description === "string" ? t.description : "").slice(0, MAX_DESCRIPTION) ||
          name,
        action: server.actions[name] ?? server.actions[id] ?? "write",
        input: closedSchema(t.inputSchema) as JsonSchema,
        route: {
          kind: "mcp",
          url: String(server.url),
          name,
          server: server.server,
          headers: server.headers,
        },
      }),
    );
  }
  if (listed.length > MAX_TOOLS)
    problems.push(
      `${server.plugin}/${server.server}: more than ${MAX_TOOLS} tools; the rest skipped`,
    );
  return { tools, problems };
}

/** An outgoing request, as the secrets gateway takes it. */
export interface McpOutgoing {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const OWN_HEADERS = /^(content-type|accept|mcp-.*|host|content-length)$/i;

/** One JSON-RPC request to a server, in the stateless revision. */
export function mcpRequest(
  route: Pick<McpRoute, "url" | "headers">,
  method: string,
  params: Record<string, unknown>,
  id: number | string,
): McpOutgoing {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.headers ?? {}))
    if (!OWN_HEADERS.test(k)) headers[k] = v;
  headers["content-type"] = "application/json";
  headers.accept = "application/json, text/event-stream";
  headers["mcp-protocol-version"] = MCP_REVISION;
  headers["mcp-method"] = method;
  if (method === "tools/call" && typeof params.name === "string") headers["mcp-name"] = params.name;
  return {
    method: "POST",
    url: route.url,
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_REVISION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  };
}

const MAX_ERROR = 2000;

/** The messages of an SSE body. */
function sseMessages(body: string): unknown[] {
  const out: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // not a message
    }
  }
  return out;
}

/**
 * A server's answer to request `id`, from what the gateway answered: the result, or an error text
 * (an HTTP failure as `<status> <body>`, a JSON-RPC error, an answer that isn't one, or a request
 * for input the harness does not provide).
 */
export function mcpAnswer(
  answer: { ok: boolean; status?: number; contentType?: string; body?: string },
  id: number | string,
): { result: Record<string, unknown>; error?: undefined } | { error: string; result?: undefined } {
  const body = String(answer.body ?? "");
  if (!answer.ok) return { error: `${answer.status ?? ""} ${body}`.trim().slice(0, MAX_ERROR) };
  let messages: unknown[];
  if (/text\/event-stream/i.test(answer.contentType ?? "")) messages = sseMessages(body);
  else
    try {
      const parsed = JSON.parse(body);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return { error: "EPROTO: the MCP server's answer is not JSON" };
    }
  const reply = messages.find(
    (m) => m && typeof m === "object" && (m as { id?: unknown }).id === id,
  ) as { result?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
  if (!reply) return { error: "EPROTO: the MCP server did not answer the request" };
  if (reply.error)
    return {
      error: `MCP error ${String(reply.error.code)}: ${String(reply.error.message)}`.slice(
        0,
        MAX_ERROR,
      ),
    };
  const result = reply.result;
  if (!result || typeof result !== "object" || Array.isArray(result))
    return { error: "EPROTO: the MCP server's result is not an object" };
  if ((result as { resultType?: unknown }).resultType === "input_required")
    return { error: "ENOSYS: the MCP server asked for input, which the harness does not provide" };
  return { result: result as Record<string, unknown> };
}

/** A `tools/call` result as the tool's output: its text content, other content named. */
export function mcpCallOutput(result: Record<string, unknown>): {
  output: string;
  isError: boolean;
} {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((c) => {
    const item = (c ?? {}) as {
      type?: unknown;
      text?: unknown;
      mimeType?: unknown;
      resource?: { text?: unknown; uri?: unknown };
    };
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "resource" && typeof item.resource?.text === "string")
      return item.resource.text;
    return `[${String(item.type)}${typeof item.mimeType === "string" ? ` ${item.mimeType}` : ""}]`;
  });
  const output =
    parts.length || result.structuredContent === undefined
      ? parts.join("\n")
      : JSON.stringify(result.structuredContent);
  return { output, isError: result.isError === true };
}
