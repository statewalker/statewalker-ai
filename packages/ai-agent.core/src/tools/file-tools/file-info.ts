import { type FilesApi, normalizePath } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";

const fileInfoOutputSchema = z
  .object({
    path: z.string().optional().describe("Normalized absolute path"),
    kind: z.string().optional().describe("Entry type: 'file' or 'directory'"),
    size: z.number().optional().describe("File size in bytes"),
    size_formatted: z
      .string()
      .optional()
      .describe("Human-readable file size (e.g. '1.5 KB', '3.2 MB')"),
    last_modified: z.string().optional().describe("ISO 8601 timestamp of last modification"),
  })
  .passthrough()
  .describe("On error returns { error: string } instead.");

type FileInfoOutput = z.infer<typeof fileInfoOutputSchema>;

export function createFileInfoTool(files: FilesApi) {
  return tool({
    description:
      "Get metadata about a file or directory: size, last modified date, " +
      "and type (file or directory). All paths are absolute (start with '/'). " +
      "Use this to check if a file exists, " +
      "inspect file size before reading, or check modification dates.",
    inputSchema: z.object({
      path: z.string().describe("Absolute virtual path to the file or directory"),
    }),
    outputSchema: fileInfoOutputSchema,
    execute: async ({ path }): Promise<FileInfoOutput> => {
      const normalized = normalizePath(path);

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
