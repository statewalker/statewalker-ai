// Remote MCP servers (statewalker/statewalker-root#135): a plugin's `mcp.json`, read into the
// servers the host-side gateway may reach, the tools a server lists turned into tool definitions of
// the plugin, and the gateway's requests and answers in the 2026-07-28 Streamable HTTP revision.
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_SCHEMA,
  catalogMcpServers,
  MCP_REVISION,
  mcpAnswer,
  mcpCallOutput,
  mcpRequest,
  mcpTools,
  TOOL_EXTENSION,
  toolInput,
} from "../src/index.js";

async function catalogOf(files: Record<string, string>) {
  const catalog = new MemFilesApi();
  for (const [path, text] of Object.entries(files)) await writeText(catalog, path, text);
  return catalog;
}

/** A `${NAME}` reference, as a plugin file writes it. */
const ref = (name: string) => `$${"{"}${name}}`;
const pluginWith = (name: string, servers: Record<string, unknown>) => ({
  [`/${name}/plugin.json`]: JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA, name }),
  [`/${name}/mcp.json`]: JSON.stringify({ mcpServers: servers }),
});

describe("a plugin's MCP servers", () => {
  it("reads Streamable HTTP servers, their environment references as secret placeholders", async () => {
    const catalog = await catalogOf(
      pluginWith("tracker", {
        main: {
          type: "streamable-http",
          url: `https://mcp.example.com/mcp?team=${ref("TEAM_ID")}`,
          headers: { Authorization: `Bearer ${ref("TRACKER_TOKEN")}`, "X-Client": "harness" },
          "x-dev.cellb.harness": { actions: { lookup: "read", wipe: "admin", odd: "nope" } },
        },
      }),
    );
    expect(await catalogMcpServers(catalog)).toEqual([
      {
        plugin: "tracker",
        server: "main",
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp?team={{secret:TEAM_ID}}",
        headers: { Authorization: "Bearer {{secret:TRACKER_TOKEN}}", "X-Client": "harness" },
        actions: { lookup: "read", wipe: "admin" },
      },
    ]);
  });

  it("answers ENOSYS for stdio and SSE servers, and refuses credentials written in the files", async () => {
    const catalog = await catalogOf(
      pluginWith("p", {
        local: { type: "stdio", command: "node" },
        old: { type: "sse", url: "https://mcp.example.com/sse" },
        literal: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer sk-live-123" },
        },
        apikey: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { "X-Api-Key": "abc" },
        },
        userinfo: { type: "streamable-http", url: "https://user:pw@mcp.example.com/mcp" },
        query: { type: "streamable-http", url: "https://mcp.example.com/mcp?api_key=abc" },
        ftp: { type: "streamable-http", url: "ftp://mcp.example.com/mcp" },
      }),
    );
    const servers = await catalogMcpServers(catalog);
    const problem = (name: string) => servers.find((s) => s.server === name)?.problem;
    expect(problem("local")).toMatch(/^ENOSYS/);
    expect(problem("old")).toMatch(/^ENOSYS/);
    for (const name of ["literal", "apikey", "userinfo", "query"])
      expect(problem(name)).toMatch(/secret/);
    expect(problem("ftp")).toMatch(/http/);
    expect(JSON.stringify(servers)).not.toMatch(/sk-live-123|"abc"|pw@/);
  });
});

describe("a remote server's tools", () => {
  const server = {
    plugin: "tracker",
    server: "main",
    transport: "streamable-http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer {{secret:T}}" },
    actions: { lookup: "read" as const },
  };

  it("become closed tool definitions of the plugin, writing unless the plugin says they read", () => {
    const { tools, problems } = mcpTools(server, [
      {
        name: "lookup",
        description: "Looks up",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      {
        name: "Make-Thing.v2",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      { name: "make_thing_v2", inputSchema: { type: "object" } },
      { name: "bad\nname", inputSchema: { type: "object" } },
    ]);
    expect(tools.map((d) => d[TOOL_EXTENSION])).toEqual([
      expect.objectContaining({
        id: "tracker/lookup",
        name: "tracker__lookup",
        source: "mcp",
        action: "read",
        route: {
          kind: "mcp",
          url: server.url,
          name: "lookup",
          server: "main",
          headers: server.headers,
        },
      }),
      expect.objectContaining({
        id: "tracker/make_thing_v2",
        action: "write",
        route: expect.objectContaining({ name: "Make-Thing.v2" }),
      }),
    ]);
    expect(toolInput(tools[0] as (typeof tools)[number])).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    });
    expect(problems).toHaveLength(2);
  });
});

describe("the gateway's requests and answers", () => {
  const route = {
    kind: "mcp" as const,
    url: "https://mcp.example.com/mcp",
    name: "lookup",
    server: "main",
    headers: { Authorization: "Bearer {{secret:T}}", "Mcp-Method": "forged" },
  };

  it("posts stateless 2026-07-28 requests with the standard headers", () => {
    const req = mcpRequest(route, "tools/call", { name: "lookup", arguments: { q: 1 } }, 7);
    expect(req).toMatchObject({
      method: "POST",
      url: route.url,
      headers: {
        Authorization: "Bearer {{secret:T}}",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_REVISION,
        "mcp-method": "tools/call",
        "mcp-name": "lookup",
      },
    });
    expect(Object.keys(req.headers).filter((h) => h.toLowerCase() === "mcp-method")).toHaveLength(
      1,
    );
    expect(JSON.parse(String(req.body))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "lookup",
        arguments: { q: 1 },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_REVISION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
  });

  it("reads JSON and SSE answers, errors and refusals", () => {
    const result = { content: [{ type: "text", text: "hi" }] };
    expect(
      mcpAnswer(
        {
          ok: true,
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, result }),
        },
        3,
      ),
    ).toEqual({ result });
    const sse = [
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}`,
      "",
      "event: message",
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 3, result })}`,
      "",
    ].join("\n");
    expect(
      mcpAnswer({ ok: true, status: 200, contentType: "text/event-stream", body: sse }, 3),
    ).toEqual({ result });
    expect(
      mcpAnswer(
        {
          ok: true,
          status: 200,
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "no" } }),
        },
        3,
      ),
    ).toEqual({ error: "MCP error -32602: no" });
    expect(mcpAnswer({ ok: false, status: 401, body: "nope" }, 3)).toEqual({
      error: "401 nope",
    });
    expect(
      mcpAnswer(
        {
          ok: true,
          status: 200,
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, result: { resultType: "input_required" } }),
        },
        3,
      ).error,
    ).toMatch(/input/);
  });

  it("turns a call's result into the tool's output", () => {
    expect(
      mcpCallOutput({
        content: [
          { type: "text", text: "a" },
          { type: "image", mimeType: "image/png", data: "xx" },
          { type: "text", text: "b" },
        ],
        isError: true,
      }),
    ).toEqual({ output: "a\n[image image/png]\nb", isError: true });
    expect(mcpCallOutput({ content: [], structuredContent: { n: 1 } })).toEqual({
      output: '{"n":1}',
      isError: false,
    });
  });
});
