import { type FilesApi, readText, writeText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

export function createMultiEditTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Perform multiple find-and-replace edits on a single file atomically. " +
      "All paths are absolute (start with '/'). " +
      "Edits are applied sequentially — each edit operates on the result of " +
      "the previous one. If any edit fails validation, none are applied. " +
      "Prefer this over multiple edit_file calls when making several changes " +
      "to the same file.",
    inputSchema: z.object({
      path: z.string().describe("Absolute virtual path to the file"),
      edits: z
        .array(
          z.object({
            old_string: z
              .string()
              .describe("The exact text to find and replace"),
            new_string: z.string().describe("The replacement text"),
            replace_all: z
              .boolean()
              .optional()
              .describe("If true, replace all occurrences. Defaults to false."),
          }),
        )
        .min(1)
        .describe(
          "Array of edit operations applied sequentially. " +
            "Each edit sees the result of all previous edits.",
        ),
    }),
    outputSchema: z
      .object({
        path: z
          .string()
          .optional()
          .describe("Normalized absolute path of the edited file"),
        edits_applied: z
          .number()
          .optional()
          .describe("Number of edit operations applied"),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ path, edits }) => {
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

      let content = await readText(files, normalized);

      // Validate and apply all edits to an in-memory copy
      for (const [i, edit] of edits.entries()) {
        if (edit.old_string === edit.new_string) {
          return {
            error: `Edit ${i + 1}: old_string and new_string are identical — no change.`,
          };
        }

        if (!content.includes(edit.old_string)) {
          return {
            error: `Edit ${i + 1}: old_string not found in file (after previous edits applied).`,
          };
        }

        const occurrences = content.split(edit.old_string).length - 1;
        if (!edit.replace_all && occurrences > 1) {
          return {
            error: `Edit ${i + 1}: old_string has ${occurrences} occurrences. Provide more context or set replace_all to true.`,
          };
        }

        content = edit.replace_all
          ? content.replaceAll(edit.old_string, edit.new_string)
          : content.replace(edit.old_string, edit.new_string);
      }

      // All edits validated — write once
      await writeText(files, normalized, content);
      return { path: normalized, edits_applied: edits.length };
    },
  });
}
