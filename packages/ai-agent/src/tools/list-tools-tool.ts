import { tool } from "ai";
import { z } from "zod";
import type { ToolRegistry } from "../state/tool-registry.js";

interface ParamInfo {
  name: string;
  type: string;
  description?: string;
}

interface ToolInfo {
  name: string;
  description: string;
  parameters: ParamInfo[];
  result?: ParamInfo[];
}

/** Extract parameter info from a Zod schema's shape. */
function extractParams(schema: unknown): ParamInfo[] {
  const shape = (schema as { shape?: Record<string, unknown> })?.shape;
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => {
    const def = (field as { _def?: { typeName?: string; description?: string } })?._def;
    const param: ParamInfo = {
      name,
      type: def?.typeName?.replace("Zod", "").toLowerCase() ?? "unknown",
    };
    if (def?.description) param.description = def.description;
    return param;
  });
}

export function createListToolsTool(registry: ToolRegistry) {
  return tool({
    description:
      "List all registered tools with their names, descriptions, " +
      "parameter schemas, and result schemas.",
    inputSchema: z.object({}),
    execute: async () => {
      const tools: ToolInfo[] = [];
      for (const [name, t] of registry.entries()) {
        const info: ToolInfo = {
          name,
          description: t.description ?? "",
          parameters: extractParams(t.inputSchema),
        };
        const result = extractParams((t as { outputSchema?: unknown }).outputSchema);
        if (result.length > 0) info.result = result;
        tools.push(info);
      }
      return { tools, count: tools.length };
    },
  });
}
