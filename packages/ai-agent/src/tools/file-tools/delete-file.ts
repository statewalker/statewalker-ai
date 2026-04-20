import type { FilesApi } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

export function createDeleteFileTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Delete a file or directory. All paths are absolute (start with '/'). " +
      "If the target is a directory, removes it and all its contents recursively.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute virtual path to the file or directory to delete"),
    }),
    outputSchema: z
      .object({
        path: z
          .string()
          .optional()
          .describe("Normalized absolute path of the deleted entry"),
        removed: z
          .boolean()
          .optional()
          .describe("True if the file or directory was removed"),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ path }) => {
      let normalized: string;
      try {
        normalized = guardPath(path, isExcluded);
      } catch (e) {
        return { error: (e as Error).message };
      }

      const exists = await files.exists(normalized);
      if (!exists) {
        return { error: `Path not found: ${normalized}` };
      }

      const removed = await files.remove(normalized);
      return { path: normalized, removed };
    },
  });
}
