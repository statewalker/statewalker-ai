/**
 * Per-tool elision strategy controlling how the hierarchical selector
 * projects large `tool_response` bodies into the outgoing ModelMessage
 * stream (and the summariser input).
 *
 * - `never-elide`    — pass the raw content through unchanged.
 * - `head-tail`      — keep a configurable prefix and suffix; replace the
 *                      middle with `…elided N chars…`.
 * - `placeholder-only` — replace the entire content with a single-line
 *                      marker `[result elided — N chars, call {tool} with
 *                      args {keys}]`.
 *
 * Elision is applied at *projection* time only. The underlying
 * `tool_response` tree nodes are never mutated.
 */
export type ElisionStrategy =
  | { kind: "never-elide" }
  | { kind: "head-tail"; headChars: number; tailChars: number }
  | { kind: "placeholder-only" };

export interface ToolElisionPolicy {
  /** Minimum content length below which elision is bypassed. */
  minElideChars: number;
  /** Applied when a tool name has no registry entry. */
  defaultStrategy: ElisionStrategy;
  /** Explicit per-tool overrides. */
  perTool: Map<string, ElisionStrategy>;
  /** Regex; when a tool name matches, strategy falls back to `never-elide`. */
  neverElidePattern?: RegExp;
}

export interface DefaultElisionOptions {
  minElideChars?: number;
  defaultStrategy?: ElisionStrategy;
  perTool?: Record<string, ElisionStrategy>;
  neverElidePattern?: RegExp;
  /** Names forced to `never-elide` (merged with built-in stateful tools). */
  neverElideTools?: string[];
}

const DEFAULT_HEAD_CHARS = 200;
const DEFAULT_TAIL_CHARS = 200;
const DEFAULT_MIN_ELIDE_CHARS = 2000;
const DEFAULT_NEVER_ELIDE_TOOLS = ["list_tools", "list_skills", "use_skills"];

export function createDefaultElisionPolicy(
  options: DefaultElisionOptions = {},
): ToolElisionPolicy {
  const perTool = new Map<string, ElisionStrategy>();
  const neverElideTools = new Set([
    ...DEFAULT_NEVER_ELIDE_TOOLS,
    ...(options.neverElideTools ?? []),
  ]);
  for (const name of neverElideTools) {
    perTool.set(name, { kind: "never-elide" });
  }
  if (options.perTool) {
    for (const [name, strat] of Object.entries(options.perTool)) {
      perTool.set(name, strat);
    }
  }
  return {
    minElideChars: options.minElideChars ?? DEFAULT_MIN_ELIDE_CHARS,
    defaultStrategy:
      options.defaultStrategy ??
      ({
        kind: "head-tail",
        headChars: DEFAULT_HEAD_CHARS,
        tailChars: DEFAULT_TAIL_CHARS,
      } as ElisionStrategy),
    perTool,
    neverElidePattern: options.neverElidePattern,
  };
}

/**
 * Apply `policy` to a raw tool response body and return the projection
 * string. Pure function; does not touch the tree.
 */
export function elideToolResponse(
  content: string,
  toolName: string,
  args: unknown,
  policy: ToolElisionPolicy,
): string {
  if (content.length < policy.minElideChars) return content;

  // Resolve strategy: explicit per-tool > never-elide pattern > default.
  let strategy = policy.perTool.get(toolName);
  if (!strategy && policy.neverElidePattern?.test(toolName)) {
    strategy = { kind: "never-elide" };
  }
  if (!strategy) strategy = policy.defaultStrategy;

  switch (strategy.kind) {
    case "never-elide":
      return content;
    case "placeholder-only":
      return formatPlaceholder(content.length, toolName, args);
    case "head-tail": {
      const { headChars, tailChars } = strategy;
      if (content.length <= headChars + tailChars) return content;
      const head = content.slice(0, headChars);
      const tail = content.slice(content.length - tailChars);
      const middle = content.length - headChars - tailChars;
      return `${head}\n…elided ${middle} chars…\n${tail}`;
    }
  }
}

function formatPlaceholder(n: number, toolName: string, args: unknown): string {
  const keys = argKeys(args);
  const keysPart = keys.length > 0 ? ` with args {${keys.join(", ")}}` : "";
  return `[result elided — ${n} chars, call ${toolName}${keysPart}]`;
}

function argKeys(args: unknown): string[] {
  if (args === null || args === undefined) return [];
  if (typeof args !== "object") return [];
  return Object.keys(args as Record<string, unknown>);
}
