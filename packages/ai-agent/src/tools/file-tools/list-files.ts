import { type FilesApi, normalizePath } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";

const MAX_RESULTS = 200;

/**
 * Convert a glob pattern to a RegExp.
 * Supports: `*` (any non-slash), `**` (any path), `?` (single char).
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      regex += "[^/]*";
      i++;
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch && REGEX_ESCAPE_CHARS.has(ch)) {
      regex += `\\${ch}`;
      i++;
    } else if (ch) {
      regex += ch;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

const REGEX_ESCAPE_CHARS = new Set([".", "[", "]", "+", "^", "$", "{", "}", "(", ")", "|", "\\"]);

export function createListFilesTool(files: FilesApi) {
  return tool({
    description:
      "List files and directories. All paths are absolute (start with '/'). " +
      "Without a pattern returns the contents of the given directory up to max_depth. " +
      "With a pattern performs a recursive glob search (like find). " +
      "Supports glob patterns: `*` (any name segment), `**` (any depth), `?` (single char). " +
      "Examples: `*.ts`, `**/*.test.ts`, `src/**`.",
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe("Absolute path to the directory to list or search in. Defaults to '/' (root)."),
      pattern: z
        .string()
        .optional()
        .describe(
          "Glob pattern to filter results. When provided, searches recursively. " +
            "Examples: '*.ts', '**/*.test.ts', '**/utils/**'.",
        ),
      max_depth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Maximum directory depth to traverse. " +
            "Defaults to 3 when no pattern is given, unlimited when a pattern is given.",
        ),
    }),
    outputSchema: z
      .object({
        path: z.string().optional().describe("Normalized absolute path of the listed directory"),
        entries: z
          .array(
            z.object({
              name: z.string().describe("Entry name (directories end with '/')"),
              path: z.string().describe("Absolute path of the entry"),
              kind: z.string().describe("Entry type: 'file' or 'directory'"),
              size: z.number().optional().describe("File size in bytes (when available)"),
              lastModified: z
                .string()
                .optional()
                .describe("ISO 8601 last modified timestamp (when available)"),
            }),
          )
          .optional()
          .describe("Listed directory entries, sorted directories-first then by name"),
        count: z.number().optional().describe("Number of entries returned"),
        truncated: z.boolean().optional().describe("True if results were capped at 200 entries"),
      })
      .passthrough()
      .describe("On error returns { error: string } instead."),
    execute: async ({ path: searchPath, pattern, max_depth }) => {
      const dir = normalizePath(searchPath ?? "/");

      const exists = await files.exists(dir);
      if (!exists) {
        return { error: `Directory not found: ${dir}` };
      }

      const depthLimit = max_depth ?? (pattern ? undefined : 3);
      const recursive = pattern !== undefined || depthLimit === undefined || depthLimit > 1;
      const re = pattern ? globToRegex(pattern) : undefined;

      const entries: {
        name: string;
        path: string;
        kind: string;
        size?: number;
        lastModified?: string;
      }[] = [];

      for await (const entry of files.list(dir, { recursive })) {
        // Depth check
        if (depthLimit !== undefined) {
          const relative = dir === "/" ? entry.path.slice(1) : entry.path.slice(dir.length + 1);
          const depth = relative.split("/").length;
          if (depth > depthLimit) continue;
        }

        // Pattern matching
        if (re) {
          const relative = dir === "/" ? entry.path.slice(1) : entry.path.slice(dir.length + 1);
          if (!re.test(relative) && !re.test(entry.name)) continue;
        }

        entries.push({
          name: entry.name + (entry.kind === "directory" ? "/" : ""),
          path: entry.path,
          kind: entry.kind,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
          ...(entry.lastModified !== undefined
            ? { lastModified: new Date(entry.lastModified).toISOString() }
            : {}),
        });

        if (entries.length >= MAX_RESULTS) break;
      }

      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return {
        path: dir,
        entries,
        count: entries.length,
        truncated: entries.length >= MAX_RESULTS,
      };
    },
  });
}
