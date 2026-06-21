import type { ProviderV3 } from "@ai-sdk/provider";
import { generateText, tool } from "ai";
import { z } from "zod";
import type { SkillsModel } from "../state/skills-model.js";

/**
 * Parse a model's free-text response into a list of selected skill
 * names. Accepts several shapes — local models routinely produce a
 * bare JSON array `["a", "b"]` even when prompted for an object,
 * so we tolerate both:
 *
 *   - `{"selected": ["a", "b"]}`  — strict schema match
 *   - `["a", "b"]`                — bare array, common from
 *                                   non-grammar-constrained models
 *   - mixed / wrapped text containing the array — extract first
 *     `[...]` block via a permissive regex
 *
 * Returns an empty array when no parse strategy succeeds. The caller
 * is responsible for filtering the names against `skills.available`.
 */
function parseSelectedSkills(text: string): string[] {
  const trimmed = text.trim();
  // Strategy 1 / 2: try to JSON.parse the whole response.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
    if (parsed && typeof parsed === "object" && "selected" in parsed) {
      const selected = (parsed as { selected: unknown }).selected;
      if (Array.isArray(selected)) {
        return selected.filter((v): v is string => typeof v === "string");
      }
    }
  } catch {
    // Fall through to the regex strategy.
  }
  // Strategy 3: extract the first JSON array fragment from the text.
  // Matches `["x", "y"]` even when the model wraps it in prose.
  const match = trimmed.match(/\[\s*(?:"[^"]*"\s*,?\s*)*\]/);
  if (match) {
    try {
      const parsed: unknown = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

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
      prompt: z.string().describe("Human-readable description of the problem to resolve"),
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

      // Use plain `generateText` rather than `Output.object` because
      // local models without grammar-constrained generation (most of
      // transformers.js, smaller WebLLM models) routinely produce a
      // bare JSON array instead of the wrapping object the schema
      // expects, which makes the AI SDK throw NoObjectGeneratedError.
      // Parse the text ourselves and accept both shapes.
      const result = await generateText({
        model: provider.languageModel(model),
        system:
          "You are a skill selector. Given a problem description and a list of available skills, " +
          "respond with a JSON array of skill names that are most relevant — for example: " +
          '`["skill-a", "skill-b"]`. Use only names from the provided list. ' +
          "Respond with `[]` if no skills are relevant. " +
          "Do not include any prose, explanation, or other fields.",
        prompt: `Problem: ${prompt}\n\nAvailable skills:\n${available.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`,
      });

      const candidates = parseSelectedSkills(result.text);
      // Filter against the actual available list — a stray
      // hallucinated name would otherwise blow up `skills.select`.
      const availableNames = new Set(available.map((s) => s.name));
      const selected = candidates.filter((name) => availableNames.has(name));
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
