import { tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "../config/types.js";
import type { AgentBuilder } from "./agent-builder.js";

export class SubAgentTool {
  readonly toolDescription: string;
  readonly factory: (parent: AgentContext) => AgentBuilder;
  readonly parentContext: AgentContext;

  constructor(
    name: string,
    factory: (parent: AgentContext) => AgentBuilder,
    parentContext: AgentContext,
  ) {
    this.toolDescription = `Delegate a subtask to the "${name}" sub-agent. The sub-agent runs independently with its own context and returns a text result.`;
    this.factory = factory;
    this.parentContext = parentContext;
  }

  asTool() {
    const { toolDescription, factory, parentContext } = this;
    return tool({
      description: toolDescription,
      inputSchema: z.object({
        task: z.string().describe("The task to delegate to the sub-agent"),
      }),
      execute: async ({ task }) => {
        const childBuilder = factory(parentContext);
        const child = await childBuilder.build();

        child.inbox.push({ role: "user", text: task });
        let result = "";
        const ac = new AbortController();
        try {
          for await (const event of child.run(ac.signal)) {
            if (event.type === "text-delta") {
              result += event.text;
            }
          }
        } catch {
          // Sub-agent may exhaust steps — return what we have
        }
        return result || "(sub-agent produced no output)";
      },
    });
  }
}
