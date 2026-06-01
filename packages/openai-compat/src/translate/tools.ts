import { jsonSchema, type ToolChoice, type ToolSet, tool } from "ai";
import type { OpenAIToolChoice, OpenAIToolDefinition } from "../openai-types.js";
import { MessageTranslationError } from "./messages.js";

const passthroughSchema = jsonSchema({ type: "object" });

export const translateTools = (defs: OpenAIToolDefinition[] | undefined): ToolSet | undefined => {
  if (!defs || defs.length === 0) return undefined;
  const result: ToolSet = {};
  for (const def of defs) {
    if (def.type !== "function") {
      throw new MessageTranslationError(`Unsupported tool type: ${def.type}`, "tools");
    }
    if (!def.function?.name) {
      throw new MessageTranslationError("Each tool must have a function.name", "tools");
    }
    result[def.function.name] = tool({
      description: def.function.description,
      inputSchema: def.function.parameters
        ? jsonSchema(def.function.parameters as Parameters<typeof jsonSchema>[0])
        : passthroughSchema,
    });
  }
  return result;
};

export const translateToolChoice = (
  tc: OpenAIToolChoice | undefined,
): ToolChoice<ToolSet> | undefined => {
  if (tc === undefined) return undefined;
  if (typeof tc === "string") return tc;
  if (tc.type === "function") {
    return { type: "tool", toolName: tc.function.name };
  }
  throw new MessageTranslationError("Unsupported tool_choice shape", "tool_choice");
};
