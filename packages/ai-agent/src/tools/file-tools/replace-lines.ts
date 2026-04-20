import { type FilesApi, readText, writeText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

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

export function createReplaceLinesTool(
  files: FilesApi,
  isExcluded: PathFilter,
) {
  return tool({
    description:
      "Replace a range of lines in a text file with new content. " +
      "All paths are absolute (start with '/'). " +
      "Specify the range using offset (0-based line number) and limit (number of lines). " +
      "The replacement text can have a different number of lines than the range being replaced. " +
      "Use limit=0 to insert new lines without removing any. " +
      "Binary files (PDF, images, archives, etc.) are rejected.",
    inputSchema: z.object({
      path: z.string().describe("Absolute virtual path to the file"),
      offset: z
        .number()
        .int()
        .min(0)
        .describe(
          "The line number to start replacing from (0-based). " +
            "Use count_lines or read_lines to determine line numbers.",
        ),
      limit: z
        .number()
        .int()
        .min(0)
        .describe(
          "Number of lines to replace. " +
            "Use 0 to insert without removing any lines.",
        ),
      new_content: z
        .string()
        .describe(
          "Replacement text. Replaces the specified line range. " +
            "Can contain multiple lines (separated by newlines). " +
            "Use an empty string to delete the specified lines.",
        ),
    }),
    outputSchema: z
      .object({
        path: z
          .string()
          .optional()
          .describe("Normalized absolute path of the edited file"),
        lines_removed: z
          .number()
          .optional()
          .describe("Number of original lines removed from the range"),
        lines_inserted: z
          .number()
          .optional()
          .describe("Number of new lines inserted"),
        total_lines: z
          .number()
          .optional()
          .describe("Total line count of the file after replacement"),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ path, offset, limit, new_content }) => {
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
      const lines = content === "" ? [] : content.split("\n");
      const totalLines = lines.length;

      if (offset > totalLines) {
        return {
          error: `Offset ${offset} is beyond end of file (${totalLines} lines).`,
        };
      }

      const clampedLimit = Math.min(limit, totalLines - offset);
      const newLines = new_content === "" ? [] : new_content.split("\n");

      lines.splice(offset, clampedLimit, ...newLines);

      await writeText(files, normalized, lines.join("\n"));

      return {
        path: normalized,
        lines_removed: clampedLimit,
        lines_inserted: newLines.length,
        total_lines: lines.length,
      };
    },
  });
}
