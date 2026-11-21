// Test-only REST tools, until tool definitions (statewalker/statewalker-root#129) bring REST and
// MCP routes from plugins: the deployment's `REST_TOOLS` var declares them, and each call goes to
// the Workspace DO's gateway, which resolves the `{{secret:NAME}}` placeholders of the declaration
// (never of the model's input) for the declaring plugin and the request's host.
import { codedError } from "@statewalker/ai-access";
import type { GatewayResult, OutgoingRequest } from "@statewalker/ai-environment";
import type { HostTool } from "@statewalker/ai-flue";

interface RestToolDeclaration {
  plugin: string;
  name: string;
  description?: string;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  /** Query parameters the model may fill, each a string. */
  query?: string[];
}

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const PLUGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function declarations(text: string | undefined): RestToolDeclaration[] {
  if (!text?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw codedError("EIO", "REST_TOOLS is not JSON");
  }
  if (!Array.isArray(parsed)) throw codedError("EIO", "REST_TOOLS is a list of tools");
  return parsed.map((d: RestToolDeclaration) => {
    if (!PLUGIN.test(String(d?.plugin)) || !NAME.test(String(d?.name)) || typeof d.url !== "string")
      throw codedError("EIO", "a REST tool has a plugin, a name and a url");
    return d;
  });
}

/** The REST tools a deployment declares, each calling out through `gateway`. */
export function restTools(
  text: string | undefined,
  gateway: (call: { plugin: string; request: OutgoingRequest }) => Promise<GatewayResult>,
): HostTool[] {
  return declarations(text).map((d) => {
    const query = d.query ?? [];
    return {
      name: `${d.plugin}__${d.name}`,
      description: d.description ?? `${d.method ?? "GET"} ${d.name} of ${d.plugin}`,
      parameters: {
        type: "object",
        properties: Object.fromEntries(query.map((q) => [q, { type: "string" }])),
        additionalProperties: false,
      },
      async execute(args) {
        // The model's input is encoded into the query, so a placeholder in it never resolves.
        const params = new URLSearchParams();
        for (const q of query) if (typeof args[q] === "string") params.set(q, args[q]);
        const qs = params.toString();
        const target = qs ? `${d.url}${d.url.includes("?") ? "&" : "?"}${qs}` : d.url;
        const result = await gateway({
          plugin: d.plugin,
          request: { method: d.method ?? "GET", url: target, headers: d.headers ?? {} },
        });
        if (result.error) return { output: result.error, isError: true, secrets: result.secrets };
        const output = `${result.status} ${result.body ?? ""}`;
        return { output, isError: !result.ok, secrets: result.secrets };
      },
    };
  });
}
