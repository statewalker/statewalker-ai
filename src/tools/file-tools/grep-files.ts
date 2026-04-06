import { type FilesApi, readText } from "@statewalker/webrun-files";
import { tool } from "ai";
import { z } from "zod";
import { guardPath, type PathFilter } from "./path-utils.js";

const DEFAULT_HEAD_LIMIT = 250;
const MAX_LINE_LENGTH = 300;

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

/** Simple glob for file name matching. Supports *, ?, and {a,b}. */
function nameGlobToRegex(pattern: string): RegExp {
  let expanded = pattern.replace(
    /\{([^}]+)\}/g,
    (_, group: string) =>
      `(${group
        .split(",")
        .map((s: string) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})`,
  );
  expanded = expanded
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${expanded}$`);
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_LENGTH
    ? `${line.slice(0, MAX_LINE_LENGTH)}...`
    : line;
}

export function createGrepTool(files: FilesApi, isExcluded: PathFilter) {
  return tool({
    description:
      "Search file contents using regex, inspired by ripgrep. All paths are absolute (start with '/'). " +
      "Supports three output modes: 'content' (matching lines with optional context), " +
      "'files_with_matches' (just file paths), and 'count' (match counts per file). " +
      "Use this for powerful, flexible text search across the project. " +
      "For finding files by name, use list_files instead.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe(
          "Regular expression pattern to search for. " +
            "Examples: 'TODO', 'function\\s+\\w+', 'import.*react'.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Absolute path to the file or directory to search in. " +
            "Defaults to '/' (project root).",
        ),
      glob: z
        .string()
        .optional()
        .describe(
          "Glob pattern to filter files, e.g. '*.ts', '*.{ts,tsx}'. " +
            "Matches against file names.",
        ),
      output_mode: z
        .enum(["content", "files_with_matches", "count"])
        .optional()
        .describe(
          "Output format. " +
            "'content': matching lines with context (default). " +
            "'files_with_matches': only file paths. " +
            "'count': match counts per file.",
        ),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("If false, search case-insensitively. Defaults to true."),
      context: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Number of lines to show before AND after each match. " +
            "Only used in 'content' mode.",
        ),
      before_context: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Number of lines to show before each match. " +
            "Only used in 'content' mode. Overridden by 'context' if both set.",
        ),
      after_context: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Number of lines to show after each match. " +
            "Only used in 'content' mode. Overridden by 'context' if both set.",
        ),
      multiline: z
        .boolean()
        .optional()
        .describe(
          "Enable multiline mode where '.' matches newlines and patterns can span lines. " +
            "Defaults to false.",
        ),
      head_limit: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Limit output to first N entries. " +
            "Defaults to 250. Pass 0 for unlimited.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Skip first N entries before applying head_limit."),
    }),
    execute: async ({
      pattern,
      path: searchPath,
      glob: globPattern,
      output_mode,
      case_sensitive,
      context: ctxLines,
      before_context,
      after_context,
      multiline,
      head_limit,
      offset,
    }) => {
      let dir: string;
      try {
        dir = guardPath(searchPath ?? "/", isExcluded);
      } catch (e) {
        return { error: (e as Error).message };
      }

      const caseSensitive = case_sensitive !== false;
      const mode = output_mode ?? "content";
      const limit =
        head_limit === 0
          ? Number.POSITIVE_INFINITY
          : (head_limit ?? DEFAULT_HEAD_LIMIT);
      const skip = offset ?? 0;
      const beforeCtx = ctxLines ?? before_context ?? 0;
      const afterCtx = ctxLines ?? after_context ?? 0;

      let flags = caseSensitive ? "" : "i";
      if (multiline) flags += "sm";
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags);
      } catch {
        return { error: `Invalid regex pattern: ${pattern}` };
      }

      const globRe = globPattern ? nameGlobToRegex(globPattern) : undefined;

      // Determine if searching a single file
      const stat = await files.stats(dir);
      if (!stat) {
        return { error: `Path not found: ${dir}` };
      }
      const isSingleFile = stat.kind === "file";

      const fileEntries: { path: string; name: string }[] = [];
      if (isSingleFile) {
        const name = dir.split("/").pop() ?? dir;
        fileEntries.push({ path: dir, name });
      } else {
        for await (const entry of files.list(dir, { recursive: true })) {
          if (entry.kind !== "file") continue;
          if (isExcluded(entry.path)) continue;
          if (globRe && !globRe.test(entry.name)) continue;
          if (isBinaryFilename(entry.name)) continue;
          fileEntries.push({ path: entry.path, name: entry.name });
        }
      }

      if (mode === "files_with_matches") {
        return searchFilesWithMatches(files, fileEntries, re, dir, skip, limit);
      }
      if (mode === "count") {
        return searchCount(files, fileEntries, re, dir, skip, limit);
      }
      return searchContent(
        files,
        fileEntries,
        re,
        dir,
        skip,
        limit,
        beforeCtx,
        afterCtx,
      );
    },
  });
}

async function searchFilesWithMatches(
  files: FilesApi,
  entries: { path: string; name: string }[],
  re: RegExp,
  searchPath: string,
  skip: number,
  limit: number,
) {
  const matchedFiles: string[] = [];
  let emitted = 0;
  let skipped = 0;

  for (const entry of entries) {
    let content: string;
    try {
      content = await readText(files, entry.path);
    } catch {
      continue;
    }
    if (!content || !re.test(content)) continue;

    if (skipped < skip) {
      skipped++;
      continue;
    }
    matchedFiles.push(entry.path);
    emitted++;
    if (emitted >= limit) break;
  }

  return {
    search_path: searchPath,
    files: matchedFiles,
    count: matchedFiles.length,
    truncated: emitted >= limit,
  };
}

async function searchCount(
  files: FilesApi,
  entries: { path: string; name: string }[],
  re: RegExp,
  searchPath: string,
  skip: number,
  limit: number,
) {
  const counts: { file: string; count: number }[] = [];
  let emitted = 0;
  let skipped = 0;
  let totalMatches = 0;

  for (const entry of entries) {
    let content: string;
    try {
      content = await readText(files, entry.path);
    } catch {
      continue;
    }
    if (!content) continue;

    // Use a global version of the regex to count all matches per line
    const gre = new RegExp(re.source, `${re.flags.replace("g", "")}g`);
    let fileCount = 0;
    for (const line of content.split("\n")) {
      const lineMatches = line.match(gre);
      if (lineMatches) fileCount += lineMatches.length;
    }
    if (fileCount === 0) continue;

    if (skipped < skip) {
      skipped++;
      continue;
    }
    counts.push({ file: entry.path, count: fileCount });
    totalMatches += fileCount;
    emitted++;
    if (emitted >= limit) break;
  }

  return {
    search_path: searchPath,
    counts,
    files_with_matches: counts.length,
    total_matches: totalMatches,
    truncated: emitted >= limit,
  };
}

interface ContentMatch {
  file: string;
  line: number;
  content: string;
  context_before?: string[];
  context_after?: string[];
}

async function searchContent(
  files: FilesApi,
  entries: { path: string; name: string }[],
  re: RegExp,
  searchPath: string,
  skip: number,
  limit: number,
  beforeCtx: number,
  afterCtx: number,
) {
  const matches: ContentMatch[] = [];
  let emitted = 0;
  let skipped = 0;

  for (const entry of entries) {
    let content: string;
    try {
      content = await readText(files, entry.path);
    } catch {
      continue;
    }
    if (!content) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!re.test(line)) continue;

      if (skipped < skip) {
        skipped++;
        continue;
      }

      const match: ContentMatch = {
        file: entry.path,
        line: i + 1,
        content: truncateLine(line),
      };

      if (beforeCtx > 0) {
        const start = Math.max(0, i - beforeCtx);
        match.context_before = lines.slice(start, i).map(truncateLine);
      }
      if (afterCtx > 0) {
        const end = Math.min(lines.length, i + 1 + afterCtx);
        match.context_after = lines.slice(i + 1, end).map(truncateLine);
      }

      matches.push(match);
      emitted++;
      if (emitted >= limit) break;
    }
    if (emitted >= limit) break;
  }

  return {
    search_path: searchPath,
    matches,
    count: matches.length,
    truncated: emitted >= limit,
  };
}
