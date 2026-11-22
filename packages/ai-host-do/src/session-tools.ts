// An agent session's tool set (statewalker/statewalker-root#90, built by #129): the harness's own
// tools and the plugin tools the Workspace DO offers it now, each as its restricted-profile
// document. The model is offered exactly this set, as Flue's host tools, and the session's MCP
// endpoint lists and calls exactly the same set. Read tools may run in parallel; the others one at
// a time.
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";
import {
  TOOL_EXTENSION,
  type ToolAction,
  type ToolDefinition,
  toMcpTool,
  toolDefinition,
  toolInput,
} from "@statewalker/ai-definitions";
import { approvalOf, type StoredCall } from "@statewalker/ai-environment";
import type { HostTool } from "@statewalker/ai-flue";
import type { McpMessage, McpResponse } from "@statewalker/ai-sessions";

/** What each of the harness's tools does; its own gate decides its effects. */
const HARNESS_ACTIONS: Readonly<Record<string, ToolAction>> = {
  db_list: "read",
  db_query: "read",
  db_exec: "write",
  db_create: "admin",
  db_drop: "admin",
  agent_start: "write",
};

/** The permission each harness tool's effects are decided by, at its own gate. */
const HARNESS_PERMISSIONS: Readonly<Record<string, string>> = {
  db_list: "db.read",
  db_query: "db.read",
  db_exec: "db.write",
  db_create: "db.admin",
  db_drop: "db.admin",
  agent_start: "agents.use",
};

/** A harness tool as its document: plugin `harness`, named as the model knows it. */
export function harnessDefinition(tool: HostTool): ToolDefinition {
  return toolDefinition({
    plugin: "harness",
    tool: tool.name,
    name: tool.name,
    source: "harness",
    description: tool.description,
    action: HARNESS_ACTIONS[tool.name] ?? "write",
    input: tool.parameters,
    permission: HARNESS_PERMISSIONS[tool.name] ?? "tools.use:harness",
    route: { kind: "harness", entry: tool.name },
  });
}

/** Read tools run in parallel with the rest of their batch; any other tool one call at a time. */
export const executionModeOf = (d: ToolDefinition) =>
  d[TOOL_EXTENSION].action === "read" ? ("parallel" as const) : ("sequential" as const);

/** What a plugin tool's call answers: its output, or why it failed. */
export type ToolCallResult = { output: string; isError: boolean; secrets?: string[] };

/**
 * A plugin tool of one turn, as Flue's host tool: each call goes to the Workspace DO, which checks
 * it against the session's current set; a call the mode asks about ends the turn waiting on the
 * approval of exactly that call.
 */
export function pluginHostTool(
  d: ToolDefinition,
  call: (args: Record<string, unknown>) => Promise<ToolCallResult>,
  approvals: {
    onApproval(request: ApprovalRequest, call: StoredCall): void;
    waitingOn(): ApprovalRequest | undefined;
    wait(request: ApprovalRequest): void;
  },
): HostTool {
  const x = d[TOOL_EXTENSION];
  return {
    name: x.name,
    description: d.info.description,
    parameters: toolInput(d),
    executionMode: executionModeOf(d),
    async execute(args) {
      const waiting = approvals.waitingOn();
      // A turn waiting on an approval runs no further call: it ends at the pending one.
      if (waiting) return { output: `waiting on the user's approval ${waiting.id}`, isError: true };
      try {
        return await call(args);
      } catch (e) {
        const request = approvalOf(e);
        if (!request) return { output: String((e as Error)?.message ?? e), isError: true };
        approvals.wait(request);
        approvals.onApproval(request, {
          method: "tool",
          path: x.name,
          content: new TextEncoder().encode(JSON.stringify(args)),
        });
        return {
          output: `waiting on the user's approval ${request.id}: ${request.reason}`,
          isError: true,
        };
      }
    },
  };
}

/** The MCP protocol version this endpoint speaks first (it accepts the client's). */
const PROTOCOL = "2025-06-18";

/** What the MCP endpoint needs of the session. */
export interface McpSession {
  /** The session's tool set now, as documents. */
  tools(): Promise<ToolDefinition[]>;
  /** Calls one tool of the set. */
  call(d: ToolDefinition, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/**
 * One JSON-RPC message to a session's MCP endpoint (Streamable HTTP, JSON responses): `initialize`,
 * `ping`, `tools/list` and `tools/call`; notifications get no answer. A call to a tool the session
 * is not offered now is refused with -32602, whatever its name, so a forged call never runs.
 */
export async function answerMcp(
  message: McpMessage,
  session: McpSession,
): Promise<McpResponse | null> {
  const id = message.id ?? null;
  const reply = (result: unknown): McpResponse => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, text: string): McpResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  if (message.id === undefined) return null;
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === "string" ? asked : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "statewalker-ai-session", version: "1" },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: (await session.tools()).map(toMcpTool) });
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (typeof name !== "string") return error(-32602, "tools/call names a tool");
      if (!args || typeof args !== "object" || Array.isArray(args))
        return error(-32602, "a tool's arguments are an object");
      const d = (await session.tools()).find((t) => t[TOOL_EXTENSION].name === name);
      if (!d) return error(-32602, `unknown tool: ${name}`);
      try {
        const r = await session.call(d, args as Record<string, unknown>);
        return reply({ content: [{ type: "text", text: r.output }], isError: r.isError });
      } catch (e) {
        const request = approvalOf(e);
        // Re-checked at the call: a tool no longer offered is unknown too.
        if (!request && String((e as Error)?.message).includes("is not offered"))
          return error(-32602, `unknown tool: ${name}`);
        const text = request
          ? `waiting on the user's approval ${request.id}: ${request.reason}`
          : String((e as Error)?.message ?? e);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return error(-32601, `method not found: ${message.method}`);
  }
}

/** A refusal for a tool call that names no offered tool. */
export const notOffered = (name: string) =>
  codedError("EACCES", `the tool '${name}' is not offered to this session`);
