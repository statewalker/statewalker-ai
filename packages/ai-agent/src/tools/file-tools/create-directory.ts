import type { FilesApi } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

export function createCreateDirectoryTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Create a directory and all parent directories if needed. " +
      "All paths are absolute (start with '/'). " +
      "No-op if the directory already exists.",
    inputSchema: z.object({
      path: z.string().describe("Absolute virtual path for the new directory"),
    }),
    outputSchema: z
      .object({
        path: z.string().optional().describe("Normalized absolute path of the created directory"),
        created: z.boolean().optional().describe("True if the directory was created successfully"),
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

      await files.mkdir(normalized);
      return { path: normalized, created: true };
    },
  });
}
