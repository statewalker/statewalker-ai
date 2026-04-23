import { type FilesApi, readText } from "@statewalker/webrun-files";
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

export function createCountLinesTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Count the number of text lines in a file. All paths are absolute (start with '/'). " +
      "Use this to check file length before reading specific line ranges. " +
      "Binary files (PDF, images, archives, etc.) are rejected.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute virtual path to the file, e.g. '/src/index.ts', '/README.md'."),
    }),
    outputSchema: z
      .object({
        path: z.string().optional().describe("Normalized absolute path of the file"),
        line_count: z.number().optional().describe("Total number of lines in the file"),
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
      const lineCount = content === "" ? 0 : content.split("\n").length;

      return {
        path: normalized,
        line_count: lineCount,
      };
    },
  });
}
