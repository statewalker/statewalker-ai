import type { FilesApi } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

export function createMoveFileTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Move or rename a file or directory. All paths are absolute (start with '/'). " +
      "Creates parent directories of the target path if needed.",
    inputSchema: z.object({
      old_path: z.string().describe("Current absolute virtual path of the file or directory"),
      new_path: z.string().describe("Target absolute virtual path"),
    }),
    outputSchema: z
      .object({
        old_path: z.string().optional().describe("Normalized source path"),
        new_path: z.string().optional().describe("Normalized destination path"),
        moved: z.boolean().optional().describe("True if the move/rename succeeded"),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ old_path, new_path }) => {
      let normalizedOld: string;
      let normalizedNew: string;
      try {
        normalizedOld = guardPath(old_path, isExcluded);
        normalizedNew = guardPath(new_path, isExcluded);
      } catch (e) {
        return { error: (e as Error).message };
      }

      const exists = await files.exists(normalizedOld);
      if (!exists) {
        return { error: `Source not found: ${normalizedOld}` };
      }

      const moved = await files.move(normalizedOld, normalizedNew);
      return { old_path: normalizedOld, new_path: normalizedNew, moved };
    },
  });
}
