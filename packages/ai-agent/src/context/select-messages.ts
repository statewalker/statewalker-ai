import type { ModelMessage } from "ai";
import type { SessionState } from "../state/session-state.js";
import type { ContentSummarizer } from "./content-summarizer.js";

/**
 * Builds a ModelMessage[] prompt from the session tree.
 */
export type SelectionStrategy = (session: SessionState) => Promise<ModelMessage[]>;

// ---------------------------------------------------------------------------
// Default strategy: all turns, newest last
// ---------------------------------------------------------------------------

export async function selectAll(session: SessionState): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  for (const turn of session.turns) {
    result.push(...turn.toModelMessages());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Compaction strategy: summarize older turns, keep recent verbatim.
// Summaries are cached on each Turn node (turn.summary).
// ---------------------------------------------------------------------------

export function selectWithCompaction(options: {
  summarizer: ContentSummarizer;
  maxRecentTurns?: number;
}): SelectionStrategy {
  const maxRecent = options.maxRecentTurns ?? 4;

  return async (session: SessionState) => {
    const turns = session.turns;
    const cutoff = Math.max(0, turns.length - maxRecent);

    const result: ModelMessage[] = [];

    // Summarize older turns (cached on nodes)
    const older = turns.slice(0, cutoff);
    if (older.length > 0) {
      const summaryParts: string[] = [];
      for (const turn of older) {
        if (!turn.summary) {
          const text = turn.toPlainText();
          if (text) {
            turn.summary = await options.summarizer.summarize(text);
          }
        }
        if (turn.summary) summaryParts.push(turn.summary);
      }
      if (summaryParts.length > 0) {
        result.push({
          role: "user",
          content: `[Summary of earlier conversation]\n${summaryParts.join("\n")}`,
        });
      }
    }

    // Recent turns verbatim
    for (const turn of turns.slice(cutoff)) {
      result.push(...turn.toModelMessages());
    }

    return result;
  };
}
