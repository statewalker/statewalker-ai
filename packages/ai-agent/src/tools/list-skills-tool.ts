import { tool } from "ai";
import { z } from "zod";
import type { SkillsModel } from "../state/skills-model.js";

export function createListSkillsTool(skills: SkillsModel) {
  return tool({
    description:
      "List all available skills with their names and descriptions. " +
      "Use this to discover what skills are available before activating them.",
    inputSchema: z.object({}),
    execute: async () => {
      return {
        skills: skills.available,
        count: skills.size,
      };
    },
  });
}
