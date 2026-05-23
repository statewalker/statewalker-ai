import { type FilesApi, normalizePath } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";

export function createMoveFileTool(files: FilesApi) {
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
      const normalizedOld = normalizePath(old_path);
      const normalizedNew = normalizePath(new_path);

      const exists = await files.exists(normalizedOld);
      if (!exists) {
        return { error: `Source not found: ${normalizedOld}` };
      }

      const moved = await files.move(normalizedOld, normalizedNew);
      return { old_path: normalizedOld, new_path: normalizedNew, moved };
    },
  });
}
