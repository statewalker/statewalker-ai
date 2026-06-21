import { type FilesApi, normalizePath, writeText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";

export function createWriteFileTool(files: FilesApi) {
  return tool({
    description:
      "Write content to a file, creating it and any parent directories if needed. " +
      "All paths are absolute (start with '/'). " +
      "Overwrites the file if it already exists.",
    inputSchema: z.object({
      path: z.string().describe("Absolute virtual path to the file, e.g. '/src/index.ts'"),
      content: z.string().describe("The full content to write to the file"),
    }),
    outputSchema: z
      .object({
        path: z.string().optional().describe("Normalized absolute path of the written file"),
        bytes_written: z
          .number()
          .optional()
          .describe("Number of bytes written (UTF-8 encoded size)"),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ path, content }) => {
      const normalized = normalizePath(path);

      await writeText(files, normalized, content);
      return {
        path: normalized,
        bytes_written: new TextEncoder().encode(content).length,
      };
    },
  });
}
