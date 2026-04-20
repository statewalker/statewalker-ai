import type { ProviderV3 } from "@ai-sdk/provider";
import { generateText, Output, tool } from "ai";
import { z } from "zod";
import type { SkillsModel } from "../state/skills-model.js";

/**
 * Creates a Vercel AI SDK tool that searches and selects skills
 * via an LLM call, then updates the SkillsModel.
 */
export function createUseSkillsTool(options: {
  skills: SkillsModel;
  provider: ProviderV3;
  model: string;
}) {
  return tool({
    description:
      "Search and select skills relevant to a task. " +
      "Accepts a human-readable problem description, calls an LLM to pick " +
      "the most relevant skills from those available, activates them, " +
      "and returns their full content.",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe("Human-readable description of the problem to resolve"),
    }),
    execute: async ({ prompt }) => {
      const { skills, provider, model } = options;
      const available = skills.available;

      if (available.length === 0) {
        return {
          selected: [] as string[],
          content: [] as Array<{ name: string; content: string }>,
        };
      }

      const result = await generateText({
        model: provider.languageModel(model),
        output: Output.object({
          schema: z.object({
            selected: z
              .array(z.string())
              .describe("Names of skills to activate"),
          }),
        }),
        system:
          "You are a skill selector. Given a problem description and a list of available skills, " +
          "select the skills that are most relevant. Return only skill names from the provided list. " +
          "Return an empty array if no skills are relevant.",
        prompt: `Problem: ${prompt}\n\nAvailable skills:\n${available.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`,
      });

      const selected = result.output?.selected ?? [];
      skills.select(selected);

      return {
        selected,
        content: skills.selected.map((s) => ({
          name: s.name,
          content: s.content,
        })),
      };
    },
  });
}
