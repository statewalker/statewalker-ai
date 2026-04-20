import { type FilesApi, readText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

const MAX_CONTENT_CHARS = 50_000;

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

export function createReadFileTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Read the contents of a text file. All paths are absolute (start with '/'). " +
      "Returns plain text content. " +
      "Binary files (PDF, images, archives, etc.) are rejected — use fts_search " +
      "and fts_get_content for indexed binary documents. " +
      "Use ranges (character offsets) to read specific portions of large files. " +
      "Without ranges, returns the first 50 000 characters.",
    inputSchema: z.object({
      path: z
        .string()
        .describe(
          "Absolute virtual path to the file, e.g. '/src/index.ts', '/README.md'.",
        ),
      ranges: z
        .array(
          z.object({
            begin: z
              .number()
              .int()
              .min(0)
              .describe("Start character offset (inclusive)"),
            end: z
              .number()
              .int()
              .min(0)
              .describe("End character offset (exclusive)"),
          }),
        )
        .optional()
        .describe(
          "Character ranges to extract. Each range is { begin, end }. " +
            "When omitted, returns the first 50 000 characters.",
        ),
    }),
    outputSchema: z
      .object({
        path: z
          .string()
          .optional()
          .describe("Normalized absolute path of the file"),
        content_length: z
          .number()
          .optional()
          .describe("Total character count of the file"),
        content: z
          .string()
          .optional()
          .describe("File text content (returned when reading without ranges)"),
        truncated: z
          .boolean()
          .optional()
          .describe("True if content was truncated at 50 000 characters"),
        parts: z
          .array(
            z.object({
              range: z.object({
                begin: z
                  .number()
                  .describe("Actual start character offset (clamped)"),
                end: z
                  .number()
                  .describe("Actual end character offset (clamped)"),
              }),
              text: z.string().describe("Extracted text for this range"),
            }),
          )
          .optional()
          .describe(
            "Extracted character ranges (returned when reading with ranges)",
          ),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ path, ranges }) => {
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
          error:
            `Binary file (not readable as text): ${normalized}. ` +
            "Use fts_search and fts_get_content for indexed binary documents.",
        };
      }

      const content = await readText(files, normalized);
      const contentLength = content.length;

      if (ranges && ranges.length > 0) {
        const parts = ranges.map(({ begin, end }) => {
          const clampedBegin = Math.max(0, Math.min(begin, contentLength));
          const clampedEnd = Math.max(
            clampedBegin,
            Math.min(end, contentLength),
          );
          return {
            range: { begin: clampedBegin, end: clampedEnd },
            text: content.slice(clampedBegin, clampedEnd),
          };
        });
        return { path: normalized, content_length: contentLength, parts };
      }

      const truncated = contentLength > MAX_CONTENT_CHARS;
      return {
        path: normalized,
        content_length: contentLength,
        content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content,
        truncated,
      };
    },
  });
}
