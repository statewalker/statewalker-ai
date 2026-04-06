import { type FilesApi, readText, writeText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

export function createEditFileTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Perform an exact string replacement in a file. All paths are absolute (start with '/'). " +
      "The old_string must match exactly (including whitespace and indentation). " +
      "Use replace_all to replace every occurrence.",
    inputSchema: z.object({
      path: z.string().describe("Absolute virtual path to the file"),
      old_string: z.string().describe("The exact text to find and replace"),
      new_string: z.string().describe("The replacement text"),
      replace_all: z
        .boolean()
        .optional()
        .describe(
          "If true, replace all occurrences. Defaults to false (replace first only).",
        ),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      let normalized: string;
      try {
        normalized = guardPath(path, isExcluded);
      } catch (e) {
        return { error: (e as Error).message };
      }

      const exists = await files.exists(normalized);
      if (!exists) {
        return { error: `File not found: ${normalized}` };
      }

      if (old_string === new_string) {
        return {
          error: "old_string and new_string are identical — no change.",
        };
      }

      const content = await readText(files, normalized);
      if (!content.includes(old_string)) {
        return { error: "old_string not found in file" };
      }

      const occurrences = content.split(old_string).length - 1;
      if (!replace_all && occurrences > 1) {
        return {
          error: `old_string has ${occurrences} occurrences. Provide more context to make it unique, or set replace_all to true.`,
        };
      }

      const updated = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string);

      await writeText(files, normalized, updated);
      return {
        path: normalized,
        replacements: replace_all ? occurrences : 1,
      };
    },
  });
}
