import { type FilesApi, readText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

const MAX_FILES_WITH_MATCHES = 50;
const MAX_TOTAL_MATCHES = 200;

interface Match {
  file: string;
  line: number;
  content: string;
}

export function createSearchFilesTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Search for a regex pattern inside file contents. All paths are absolute (start with '/'). " +
      "Searches recursively through text files and returns matching lines with file path and line number. " +
      "Use this when the user wants to find text, code, references, or content within files — " +
      "similar to grep/ripgrep. For finding files by name, use list_files with a pattern.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe(
          "Regular expression pattern to search for in file contents. " +
            "Examples: 'TODO', 'function\\s+handleSubmit', '2020', 'import.*react'.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Absolute path to the directory to search in. Defaults to '/' (root).",
        ),
      include: z
        .string()
        .optional()
        .describe(
          "Glob filter for file names to limit search scope, e.g. '*.ts', '*.{ts,tsx}', '*.md'.",
        ),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("If true, search case-sensitively. Defaults to true."),
    }),
    execute: async ({ pattern, path: searchPath, include, case_sensitive }) => {
      let dir: string;
      try {
        dir = guardPath(searchPath ?? "/", isExcluded);
      } catch (e) {
        return { error: (e as Error).message };
      }
      const caseSensitive = case_sensitive !== false;
      let re: RegExp;
      try {
        re = new RegExp(pattern, caseSensitive ? "" : "i");
      } catch {
        return { error: `Invalid regex pattern: ${pattern}` };
      }

      const includeRe = include ? nameGlobToRegex(include) : undefined;
      const matches: Match[] = [];
      let filesSearched = 0;
      let filesWithMatches = 0;

      for await (const entry of files.list(dir, { recursive: true })) {
        if (entry.kind !== "file") continue;
        if (isExcluded(entry.path)) continue;
        if (includeRe && !includeRe.test(entry.name)) continue;
        if (isBinaryFilename(entry.name)) continue;

        filesSearched++;
        let content: string;
        try {
          content = await readText(files, entry.path);
        } catch {
          continue;
        }
        if (!content) continue;

        const lines = content.split("\n");
        let fileHasMatch = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string;
          if (re.test(line)) {
            if (!fileHasMatch) {
              fileHasMatch = true;
              filesWithMatches++;
            }
            matches.push({
              file: entry.path,
              line: i + 1,
              content: line.length > 200 ? `${line.slice(0, 200)}...` : line,
            });
            if (matches.length >= MAX_TOTAL_MATCHES) break;
          }
        }

        if (matches.length >= MAX_TOTAL_MATCHES) break;
        if (filesWithMatches >= MAX_FILES_WITH_MATCHES) break;
      }

      return {
        pattern,
        search_path: dir,
        files_searched: filesSearched,
        files_with_matches: filesWithMatches,
        matches,
        count: matches.length,
        truncated:
          matches.length >= MAX_TOTAL_MATCHES ||
          filesWithMatches >= MAX_FILES_WITH_MATCHES,
      };
    },
  });
}

/** Simple glob for file name matching (not full path). Supports * and {a,b}. */
function nameGlobToRegex(pattern: string): RegExp {
  let expanded = pattern.replace(
    /\{([^}]+)\}/g,
    (_, group: string) =>
      `(${group
        .split(",")
        .map((s: string) => escapeRegex(s.trim()))
        .join("|")})`,
  );
  expanded = expanded
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${expanded}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function isBinaryFilename(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase());
}
