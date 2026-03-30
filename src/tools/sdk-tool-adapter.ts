/**
 * Adapter: convert Vercel AI SDK tool definitions (ToolSet) into AgentTool[].
 *
 * SDK tools use Zod schemas and are registered on the LLM provider for tool
 * definitions. This adapter wraps them so the agent loop can execute them
 * directly — enabling maxSteps: 1 (the SDK declares tools to the LLM but
 * never executes them; the agent loop handles execution).
 */
import type { AgentTool, ToolContext, ToolOutput } from "./agent-tool.js";

/**
 * A minimal representation of a Vercel AI SDK tool (v6+).
 *
 * In SDK v6, the schema lives on `inputSchema` (a Zod object or
 * `jsonSchema()` wrapper). The legacy `parameters` field is no longer used.
 */
interface SdkToolLike {
  description?: string;
  /** SDK v6: Zod schema or jsonSchema() wrapper */
  inputSchema?: unknown;
  /** Legacy SDK: parameters with .jsonSchema */
  parameters?: { jsonSchema?: unknown };
  execute?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Convert a ToolSet (Record<string, SdkToolLike>) into AgentTool[].
 *
 * Preserves the original `inputSchema` on `sdkInputSchema` so it can be
 * passed back to `tool({ inputSchema })` without losing Zod validation.
 */
export function sdkToolSetToAgentTools(
  toolSet: Record<string, SdkToolLike>,
): AgentTool[] {
  const tools: AgentTool[] = [];

  for (const [name, sdk] of Object.entries(toolSet)) {
    if (!sdk.execute) continue;

    const execute = sdk.execute;

    tools.push({
      name,
      label: name,
      description: sdk.description ?? "",
      parametersSchema: extractJsonSchema(sdk),
      sdkInputSchema: sdk.inputSchema,
      async execute(params: unknown, _ctx: ToolContext): Promise<ToolOutput> {
        try {
          const result = await execute(params);
          const text =
            typeof result === "string" ? result : JSON.stringify(result);
          const isError =
            typeof result === "object" &&
            result !== null &&
            "error" in result &&
            typeof (result as Record<string, unknown>).error === "string";
          return { text, isError };
        } catch (err) {
          return {
            text: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    });
  }

  return tools;
}

function extractJsonSchema(sdk: SdkToolLike): Record<string, unknown> {
  // SDK v6: inputSchema is a Zod object — extract via ~standard protocol
  const input = sdk.inputSchema;
  if (input && typeof input === "object") {
    // Zod v4 ~standard protocol
    const std = (input as Record<string, unknown>)["~standard"];
    if (std && typeof std === "object" && "types" in (std as object)) {
      // Best effort: return a generic object schema.
      // The actual Zod schema is preserved on sdkInputSchema.
      return { type: "object" };
    }
    // jsonSchema() wrapper — has { jsonSchema, validate }
    if ("jsonSchema" in input) {
      const js = (input as { jsonSchema: unknown }).jsonSchema;
      if (js && typeof js === "object") {
        return js as Record<string, unknown>;
      }
    }
  }

  // Legacy SDK: parameters.jsonSchema
  const params = sdk.parameters;
  if (params && typeof params === "object" && "jsonSchema" in params) {
    return (params as { jsonSchema: Record<string, unknown> }).jsonSchema;
  }

  return { type: "object" };
}
