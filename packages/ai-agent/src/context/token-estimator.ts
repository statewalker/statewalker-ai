import type { ModelMessage } from "ai";

/**
 * Token estimator used by the hierarchical selector and compactor to decide
 * when a projection exceeds the configured budget.
 *
 * The default implementation uses a fast character-per-token heuristic
 * (default `4`; pass `3.8` for Claude-tuned sessions). Callers needing
 * provider-accurate counts may supply a `tokenize` function that returns
 * the exact token count for a given string.
 */
export interface TokenEstimator {
  estimate(input: ModelMessage[] | string): number;
}

export interface TokenEstimatorOptions {
  /** Characters per token; default 4 (English-biased). Ignored if `tokenize` provided. */
  charsPerToken?: number;
  /** Exact tokeniser — called per string fragment; overrides the char-ratio path. */
  tokenize?: (text: string) => number;
}

export function createTokenEstimator(options: TokenEstimatorOptions = {}): TokenEstimator {
  const tokenize = options.tokenize;
  const charsPerToken = options.charsPerToken ?? 4;

  const countText = tokenize
    ? (text: string) => tokenize(text)
    : (text: string) => Math.ceil(text.length / charsPerToken);

  return {
    estimate(input) {
      if (typeof input === "string") return countText(input);
      let total = 0;
      for (const msg of input) {
        total += countMessage(msg, countText);
      }
      return total;
    },
  };
}

function countMessage(msg: ModelMessage, countText: (text: string) => number): number {
  const content = (msg as { content?: unknown }).content;
  if (content === undefined || content === null) return 0;
  if (typeof content === "string") return countText(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    total += countPart(part, countText);
  }
  return total;
}

function countPart(part: unknown, countText: (text: string) => number): number {
  if (part === undefined || part === null) return 0;
  if (typeof part === "string") return countText(part);
  if (typeof part !== "object") return 0;

  const p = part as Record<string, unknown>;
  const type = p.type;

  // Text part → { type: "text", text: "..." }
  if (type === "text" && typeof p.text === "string") {
    return countText(p.text);
  }
  // Tool-call part → { type: "tool-call", toolCallId, toolName, input }
  if (type === "tool-call") {
    return countText(stableJsonString(p.input));
  }
  // Tool-result part → { type: "tool-result", toolCallId, toolName, output }
  if (type === "tool-result") {
    return countText(stableJsonString(p.output));
  }
  // Image / file / reasoning / anything else → best-effort flatten of its string-ish fields.
  let total = 0;
  for (const value of Object.values(p)) {
    if (typeof value === "string") total += countText(value);
  }
  return total;
}

function stableJsonString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
