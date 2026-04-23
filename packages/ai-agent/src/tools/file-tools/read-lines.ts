import { type FilesApi, readText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

const DEFAULT_LIMIT = 2000;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  ".ogg",
  ".flac",
  ".wasm",
  ".pyc",
  ".class",
]);

function isBinaryFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export function createReadLinesTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Read specific lines from a text file. All paths are absolute (start with '/'). " +
      "Returns numbered lines in cat -n format (1-based line numbers). " +
      "Use offset and limit to read a specific range. " +
      "Without parameters, returns up to 2000 lines from the beginning. " +
      "Binary files (PDF, images, archives, etc.) are rejected.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute virtual path to the file, e.g. '/src/index.ts', '/README.md'."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "The line number to start reading from (0-based). " +
            "Defaults to 0 (beginning of file).",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The number of lines to read. " +
            "Defaults to 2000. Only provide if the file is too large to read at once.",
        ),
    }),
    outputSchema: z
      .object({
        path: z.string().optional().describe("Normalized absolute path of the file"),
        total_lines: z.number().optional().describe("Total number of lines in the file"),
        offset: z.number().optional().describe("Actual 0-based line offset where reading started"),
        lines_returned: z.number().optional().describe("Number of lines included in the response"),
        content: z
          .string()
          .optional()
          .describe("Numbered lines in cat -n format (1-based line numbers, tab-separated)"),
        truncated: z
          .boolean()
          .optional()
          .describe("True if there are more lines beyond the returned range"),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ path, offset, limit }) => {
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
      const stats = await files.stats(normalized);
      if (stats?.kind === "directory") {
        return { error: `Path is a directory, not a file: ${normalized}` };
      }

      if (isBinaryFile(normalized)) {
        return {
          error: `Binary file (not readable as text): ${normalized}.`,
        };
      }

      const content = await readText(files, normalized);
      if (content === "") {
        return {
          path: normalized,
          total_lines: 0,
          offset: 0,
          lines_returned: 0,
          content: "",
          truncated: false,
        };
      }

      const allLines = content.split("\n");
      const totalLines = allLines.length;
      const start = Math.min(offset ?? 0, totalLines);
      const count = limit ?? DEFAULT_LIMIT;
      const end = Math.min(start + count, totalLines);
      const selected = allLines.slice(start, end);

      const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`).join("\n");

      return {
        path: normalized,
        total_lines: totalLines,
        offset: start,
        lines_returned: selected.length,
        content: numbered,
        truncated: end < totalLines,
      };
    },
  });
}
