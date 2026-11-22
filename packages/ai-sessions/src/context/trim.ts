// Tool-result trimming (ported from ai-agent.core's context/tool-elision.ts): how a long tool
// result is shortened in the model context and in the summarizer's input. Projection only: the
// item itself is never changed.

/**
 * - `keep`: the output as it is;
 * - `head-tail`: a prefix and a suffix, the middle replaced by `…trimmed N chars…`;
 * - `placeholder`: one line saying what was trimmed and how to get it again.
 */
export type TrimStrategy =
  | { kind: "keep" }
  | { kind: "head-tail"; headChars: number; tailChars: number }
  | { kind: "placeholder" };

export interface TrimPolicy {
  /** Outputs shorter than this are kept whole. */
  minChars: number;
  /** For tools with no entry of their own. */
  strategy: TrimStrategy;
  /** Per tool name. */
  tools: Record<string, TrimStrategy>;
}

export interface TrimOptions {
  minChars?: number;
  strategy?: TrimStrategy;
  tools?: Record<string, TrimStrategy>;
}

export function createTrimPolicy(options: TrimOptions = {}): TrimPolicy {
  return {
    minChars: options.minChars ?? 2000,
    strategy: options.strategy ?? { kind: "head-tail", headChars: 200, tailChars: 200 },
    tools: { ...(options.tools ?? {}) },
  };
}

/** A tool result's output as the model context shows it. */
export function trimToolResult(
  output: string,
  tool: string | undefined,
  args: unknown,
  policy: TrimPolicy,
): string {
  if (output.length < policy.minChars) return output;
  const strategy = (tool !== undefined && policy.tools[tool]) || policy.strategy;
  switch (strategy.kind) {
    case "keep":
      return output;
    case "placeholder": {
      const keys =
        args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
      return `[result trimmed: ${output.length} chars; call ${tool ?? "the tool"}${keys.length ? ` with args {${keys.join(", ")}}` : ""} again to see it]`;
    }
    case "head-tail": {
      const { headChars, tailChars } = strategy;
      if (output.length <= headChars + tailChars) return output;
      const middle = output.length - headChars - tailChars;
      return `${output.slice(0, headChars)}\n…trimmed ${middle} chars…\n${output.slice(output.length - tailChars)}`;
    }
  }
}
