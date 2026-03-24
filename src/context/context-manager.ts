/**
 * Context window management — token estimation, tiered compaction, execution limits.
 *
 * Ported from yoagent's context.rs, adapted for TypeScript.
 * Provides the same 3-level compaction strategy:
 *   Level 1: Truncate tool outputs (keep head + tail)
 *   Level 2: Summarize old turns (replace details with one-liner)
 *   Level 3: Drop middle messages (keep first + recent)
 */
import type { AgentMessage, Usage } from "../events/agent-events.js";
import { nowMs } from "../events/agent-events.js";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function messageTokens(msg: AgentMessage): number {
  const content =
    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return estimateTokens(content) + 4;
}

export function totalTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + messageTokens(msg), 0);
}

// ---------------------------------------------------------------------------
// Context tracking (real usage + estimates)
// ---------------------------------------------------------------------------

export class ContextTracker {
  private lastUsageTokens: number | null = null;
  private lastUsageIndex: number | null = null;

  recordUsage(usage: Usage, messageIndex: number): void {
    const total =
      usage.input +
      usage.output +
      (usage.cacheRead ?? 0) +
      (usage.cacheWrite ?? 0);
    if (total > 0) {
      this.lastUsageTokens = total;
      this.lastUsageIndex = messageIndex;
    }
  }

  estimateContextTokens(messages: AgentMessage[]): number {
    if (
      this.lastUsageTokens !== null &&
      this.lastUsageIndex !== null &&
      this.lastUsageIndex < messages.length
    ) {
      const trailing = messages
        .slice(this.lastUsageIndex + 1)
        .reduce((sum, msg) => sum + messageTokens(msg), 0);
      return this.lastUsageTokens + trailing;
    }
    return totalTokens(messages);
  }

  reset(): void {
    this.lastUsageTokens = null;
    this.lastUsageIndex = null;
  }
}

// ---------------------------------------------------------------------------
// Context configuration
// ---------------------------------------------------------------------------

export interface ContextConfig {
  maxContextTokens: number;
  systemPromptTokens: number;
  keepRecent: number;
  keepFirst: number;
  toolOutputMaxLines: number;
}

export const defaultContextConfig: ContextConfig = {
  maxContextTokens: 100_000,
  systemPromptTokens: 4_000,
  keepRecent: 10,
  keepFirst: 2,
  toolOutputMaxLines: 50,
};

// ---------------------------------------------------------------------------
// Compaction strategy
// ---------------------------------------------------------------------------

export interface CompactionStrategy {
  compact(messages: AgentMessage[], config: ContextConfig): AgentMessage[];
}

/** Default 3-level compaction. */
export function compactMessages(
  messages: AgentMessage[],
  config: ContextConfig,
): AgentMessage[] {
  const budget = config.maxContextTokens - config.systemPromptTokens;

  if (totalTokens(messages) <= budget) return messages;

  // Level 1: Truncate tool outputs
  let compacted = truncateToolOutputs(messages, config.toolOutputMaxLines);
  if (totalTokens(compacted) <= budget) return compacted;

  // Level 2: Summarize old turns
  compacted = summarizeOldTurns(compacted, config.keepRecent);
  if (totalTokens(compacted) <= budget) return compacted;

  // Level 3: Drop middle messages
  return dropMiddle(compacted, config, budget);
}

// ---------------------------------------------------------------------------
// Level 1: Truncate long tool outputs
// ---------------------------------------------------------------------------

function truncateToolOutputs(
  messages: AgentMessage[],
  maxLines: number,
): AgentMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool-result" || typeof msg.content !== "string") {
      return msg;
    }
    return { ...msg, content: truncateHeadTail(msg.content, maxLines) };
  });
}

function truncateHeadTail(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;

  const head = Math.floor(maxLines / 2);
  const tail = maxLines - head;
  const omitted = lines.length - head - tail;

  return [
    ...lines.slice(0, head),
    `\n[... ${omitted} lines truncated ...]\n`,
    ...lines.slice(-tail),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Level 2: Summarize old assistant turns
// ---------------------------------------------------------------------------

function summarizeOldTurns(
  messages: AgentMessage[],
  keepRecent: number,
): AgentMessage[] {
  if (messages.length <= keepRecent) return messages;

  const boundary = messages.length - keepRecent;
  const result: AgentMessage[] = [];
  let i = 0;

  while (i < boundary) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : "";
      const summary =
        text.length > 200
          ? "[Assistant response]"
          : text || "[Assistant response]";
      result.push({
        role: "user",
        content: `[Summary] ${summary}`,
        timestamp: nowMs(),
      });
      // Skip following tool results
      i++;
      while (i < boundary && messages[i]?.role === "tool-result") {
        i++;
      }
      continue;
    }
    if (msg.role === "tool-result") {
      i++;
      continue;
    }
    result.push(msg);
    i++;
  }

  result.push(...messages.slice(boundary));
  return result;
}

// ---------------------------------------------------------------------------
// Level 3: Drop middle messages
// ---------------------------------------------------------------------------

function dropMiddle(
  messages: AgentMessage[],
  config: ContextConfig,
  budget: number,
): AgentMessage[] {
  const len = messages.length;
  const firstEnd = Math.min(config.keepFirst, len);
  const recentStart = Math.max(0, len - config.keepRecent);

  if (firstEnd >= recentStart) {
    return keepWithinBudget(messages, budget);
  }

  const removed = recentStart - firstEnd;
  const marker: AgentMessage = {
    role: "user",
    content: `[Context compacted: ${removed} messages removed to fit context window]`,
    timestamp: nowMs(),
  };

  const result = [
    ...messages.slice(0, firstEnd),
    marker,
    ...messages.slice(recentStart),
  ];

  if (totalTokens(result) > budget) {
    return keepWithinBudget(result, budget);
  }
  return result;
}

function keepWithinBudget(
  messages: AgentMessage[],
  budget: number,
): AgentMessage[] {
  const result: AgentMessage[] = [];
  let remaining = budget;

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = messageTokens(messages[i]!);
    if (tokens > remaining) break;
    remaining -= tokens;
    result.unshift(messages[i]!);
  }

  if (result.length < messages.length) {
    const removed = messages.length - result.length;
    result.unshift({
      role: "user",
      content: `[Context compacted: ${removed} messages removed]`,
      timestamp: nowMs(),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Execution limits
// ---------------------------------------------------------------------------

export interface ExecutionLimits {
  maxTurns: number;
  maxTotalTokens: number;
  maxDurationMs: number;
}

export const defaultExecutionLimits: ExecutionLimits = {
  maxTurns: 50,
  maxTotalTokens: 1_000_000,
  maxDurationMs: 600_000,
};

export class ExecutionTracker {
  turns = 0;
  tokensUsed = 0;
  private startedAt = Date.now();

  constructor(public limits: ExecutionLimits) {}

  recordTurn(tokens: number): void {
    this.turns++;
    this.tokensUsed += tokens;
  }

  checkLimits(): string | null {
    if (this.turns >= this.limits.maxTurns) {
      return `Max turns reached (${this.turns}/${this.limits.maxTurns})`;
    }
    if (this.tokensUsed >= this.limits.maxTotalTokens) {
      return `Max tokens reached (${this.tokensUsed}/${this.limits.maxTotalTokens})`;
    }
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.limits.maxDurationMs) {
      return `Max duration reached (${Math.floor(elapsed / 1000)}s/${Math.floor(this.limits.maxDurationMs / 1000)}s)`;
    }
    return null;
  }
}
