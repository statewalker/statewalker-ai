// The token estimator (ported from ai-agent.core's context/token-estimator.ts): a fast
// characters-per-token heuristic, or an exact tokenizer when the caller has one. Compaction uses it
// to decide when the model context exceeds its budget and how big the tail is.
import type { Item } from "../api.js";

export interface TokenEstimator {
  /** The tokens of a text. */
  text(text: string): number;
  /** The tokens an item takes in the model context (a tool result as given, trimmed or not). */
  item(item: Item): number;
}

export interface TokenEstimatorOptions {
  /** Characters per token (default 4, English-biased). Ignored with `tokenize`. */
  charsPerToken?: number;
  /** An exact tokenizer, called per text fragment. */
  tokenize?: (text: string) => number;
}

const json = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function createTokenEstimator(options: TokenEstimatorOptions = {}): TokenEstimator {
  const perToken = options.charsPerToken && options.charsPerToken > 0 ? options.charsPerToken : 4;
  const text = options.tokenize ?? ((t: string) => Math.ceil(t.length / perToken));
  return {
    text,
    item(item) {
      switch (item.kind) {
        case "message":
          return text(item.text ?? "");
        case "tool_call":
          return text(item.name ?? "") + text(json(item.args));
        case "tool_result":
          return text(item.output ?? "");
        default:
          // Approval items are not part of the model context.
          return 0;
      }
    },
  };
}
