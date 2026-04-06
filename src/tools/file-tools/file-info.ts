import type { FilesApi } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

export function createFileInfoTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Get metadata about a file or directory: size, last modified date, " +
      "and type (file or directory). All paths are absolute (start with '/'). " +
      "Use this to check if a file exists, " +
      "inspect file size before reading, or check modification dates.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute virtual path to the file or directory"),
    }),
    execute: async ({ path }) => {
      let normalized: string;
      try {
        normalized = guardPath(path, isExcluded);
      } catch (e) {
        return { error: (e as Error).message };
      }

      const stats = await files.stats(normalized);
      if (!stats) {
        return { error: `Path not found: ${normalized}` };
      }

      return {
        path: normalized,
        kind: stats.kind,
        ...(stats.size !== undefined
          ? { size: stats.size, size_formatted: formatSize(stats.size) }
          : {}),
        ...(stats.lastModified !== undefined
          ? {
              last_modified: new Date(stats.lastModified).toISOString(),
            }
          : {}),
      };
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
