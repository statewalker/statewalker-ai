// Context shaping for one agent session (ported from ai-agent.core's context/: the compactor, the
// hierarchical selector and the pin policy; statewalker/statewalker-root#83, #131). Two
// append-only tables in the Agent DO's SQLite hold everything:
// - `items`, the session's flat log (written by AgentSessionCore), never changed or moved;
// - `summaries`, the summary tree: each row covers an inclusive range of items (`from_seq` to
//   `to_seq`); a depth-1 row stands for the items themselves, a deeper row for the lower rows
//   whose `parent_id` points at it. Promoting rows inserts the deeper row and sets `parent_id` on
//   its children: the only change ever made to a row.
// The tree-walking code of the original is rewritten as range queries: the session's top level is
// the summaries with no parent plus the items no such summary covers.
//
// The model context of a turn is that top level over the items before the turn: top-level
// summaries, and the uncovered items with long tool results trimmed outside the tail; a summary
// covering a pinned item is opened to its children. The tail (the most recent messages, counted
// by messages or by tokens) is never compacted nor trimmed.
//
// The turn tree (statewalker/statewalker-root#190): items of every branch share the one log, so a
// context and a compaction are scoped to a path of turns (the root-to-head path). Only that path's
// items count, and only summaries whose `through_turn` (the turn of their last item) is on it: a
// summary drawn from a path runs through its last turn, so the turns it drew from are exactly the
// path up to that turn. A summary whose parent is off the path stands at the top itself (it is
// never promoted again: a row's `parent_id` is set once). Each depth-1 summary's call also writes
// the session's table of contents (#174, `topics.ts`): it is given the topics on the path and its
// topics are merged in, through the range's last turn.
import type { Item } from "../api.js";
import { type ItemRow, itemOf } from "../items.js";
import type { SqlLike } from "../sql.js";
import { createTokenEstimator, type TokenEstimator } from "./estimate.js";
import type { Summarizer, Summary, SummarySection } from "./summarizer.js";
import { type Topic, TopicStore } from "./topics.js";
import { createTrimPolicy, type TrimPolicy, trimToolResult } from "./trim.js";

/** How the tail (never compacted) is sized: the last messages, or the last tokens' worth. */
export type TailSize = { messages: number } | { tokens: number };

export interface CompactionOptions {
  /** Compaction starts when the model context would exceed this (default 100 000 tokens). */
  budgetTokens: number;
  /** The tail: by message count (default the last 8 messages) or by tokens. */
  tail: TailSize;
  /** Messages per depth-1 summary (default 6). */
  groupSize: number;
  /** Same-depth top-level summaries in a run before they are promoted to a deeper one (default 4). */
  promoteThreshold: number;
  /** Summaries made at most before a turn starts (default 8); then the context stays over budget. */
  maxPasses: number;
  /** Tools whose latest call (and its result) is pinned: never compacted nor trimmed. */
  pinTools: string[];
  trim: TrimPolicy;
  estimator: TokenEstimator;
}

export const DEFAULT_COMPACTION: Readonly<CompactionOptions> = Object.freeze({
  budgetTokens: 100_000,
  tail: { messages: 8 },
  groupSize: 6,
  promoteThreshold: 4,
  maxPasses: 8,
  pinTools: [],
  trim: createTrimPolicy(),
  estimator: createTokenEstimator(),
});

export function compactionOptions(options: Partial<CompactionOptions> = {}): CompactionOptions {
  const defined = Object.fromEntries(
    Object.entries(options).filter(([, v]) => v !== undefined),
  ) as Partial<CompactionOptions>;
  return { ...DEFAULT_COMPACTION, ...defined };
}

/** One entry of a turn's model context. */
export type ContextEntry =
  | { type: "summary"; summary: Summary }
  | {
      type: "item";
      /** The item, with a trimmed tool result's output shortened. */
      item: Item;
      /** Set when the tool result's output was trimmed. */
      trimmed?: true;
    };

/** A run of items starting at a message: the message and the tool calls and results after it. */
interface Segment {
  type: "segment";
  items: Item[];
  pinned: boolean;
}
type Node = { type: "summary"; summary: Summary } | Segment;

/** What a context or compaction sees: a path's turns, and its top-level summaries. */
interface Scope {
  /** The path's turn ids as a JSON array; null: every item (no tree). */
  turns: string | null;
  /** The ids of the top-level summaries on the path, as a JSON array. */
  top: string;
}

/** Item rows on the scope's path (`?` twice: the scope's turns). */
const ON_PATH = "(? IS NULL OR turn IN (SELECT value FROM json_each(?)))";

interface SummaryRow {
  id: string;
  depth: number;
  from_seq: number;
  to_seq: number;
  parent_id: string | null;
  content: string;
  sections: string | null;
  tokens: number;
  through_turn: string;
  created: number;
}

const summaryOf = (row: SummaryRow): Summary => ({
  id: row.id,
  depth: Number(row.depth),
  from_seq: Number(row.from_seq),
  to_seq: Number(row.to_seq),
  ...(row.parent_id ? { parent_id: row.parent_id } : {}),
  content: row.content,
  ...(row.sections ? { sections: JSON.parse(row.sections) as SummarySection[] } : {}),
  tokens: Number(row.tokens),
  through_turn: row.through_turn,
  created: Number(row.created),
});

export class ContextShaper {
  readonly #sql: SqlLike;
  readonly #options: CompactionOptions;
  readonly #topics: TopicStore;

  constructor(options: {
    sql: SqlLike;
    options?: Partial<CompactionOptions>;
    /** The session's table of contents (one over the same storage otherwise). */
    topics?: TopicStore;
  }) {
    this.#sql = options.sql;
    this.#options = compactionOptions(options.options);
    this.#topics = options.topics ?? new TopicStore({ sql: options.sql });
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, depth INTEGER NOT NULL,
        from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, parent_id TEXT, content TEXT NOT NULL,
        sections TEXT, tokens INTEGER NOT NULL, through_turn TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS summaries_parent ON summaries (parent_id, from_seq);`);
  }

  get options(): CompactionOptions {
    return this.#options;
  }

  #rows<T>(query: string, ...args: unknown[]): T[] {
    return this.#sql.exec(query, ...args).toArray() as unknown as T[];
  }

  /** Every summary, oldest range first. */
  summaries(): Summary[] {
    return this.#rows<SummaryRow>("SELECT * FROM summaries ORDER BY from_seq, depth").map(
      summaryOf,
    );
  }

  /**
   * The scope of a context before `before` on `path`: its top-level summaries are the summaries
   * on the path whose parent is not (validity passes down: a summary's children ran through
   * turns on its own path).
   */
  #scope(before: number, path?: readonly string[]): Scope {
    const all = this.#rows<SummaryRow>(
      "SELECT id, parent_id, through_turn FROM summaries WHERE from_seq < ?",
      before,
    );
    const on = path ? new Set(path) : undefined;
    const valid = new Set(all.filter((s) => !on || on.has(s.through_turn)).map((s) => s.id));
    const top = all.filter((s) => valid.has(s.id) && !(s.parent_id && valid.has(s.parent_id)));
    return {
      turns: path ? JSON.stringify(path) : null,
      top: JSON.stringify(top.map((s) => s.id)),
    };
  }

  /** The ids of the items before `before` on the scope's path that are pinned. */
  #pins(before: number, scope: Scope): Set<string> {
    const pins = new Set<string>();
    for (const row of this.#rows<ItemRow>(
      `SELECT * FROM items WHERE seq < ? AND ${ON_PATH} AND json_extract(body, '$.pinned') = 1`,
      before,
      scope.turns,
      scope.turns,
    ))
      pins.add(row.id);
    for (const tool of this.#options.pinTools) {
      const call = this.#rows<ItemRow>(
        `SELECT * FROM items WHERE seq < ? AND ${ON_PATH} AND kind = 'tool_call' AND json_extract(body, '$.name') = ? ORDER BY seq DESC LIMIT 1`,
        before,
        scope.turns,
        scope.turns,
        tool,
      ).map(itemOf)[0];
      if (!call) continue;
      pins.add(call.id);
      if (call.callId)
        for (const row of this.#rows<ItemRow>(
          `SELECT * FROM items WHERE seq > ? AND seq < ? AND ${ON_PATH} AND kind = 'tool_result' AND json_extract(body, '$.callId') = ?`,
          call.seq,
          before,
          scope.turns,
          scope.turns,
          call.callId,
        ))
          pins.add(row.id);
    }
    return pins;
  }

  /** Items and summaries in seq order, as nodes: summaries, and the segments between them. */
  #nodes(summaries: Summary[], items: Item[], pins: ReadonlySet<string>): Node[] {
    const nodes: Node[] = [];
    let segment: Segment | undefined;
    let s = 0;
    for (const item of items) {
      while (s < summaries.length && (summaries[s]?.from_seq ?? 0) < item.seq) {
        nodes.push({ type: "summary", summary: summaries[s++] as Summary });
        segment = undefined;
      }
      if (!segment || item.kind === "message") {
        segment = { type: "segment", items: [], pinned: false };
        nodes.push(segment);
      }
      segment.items.push(item);
      if (pins.has(item.id)) segment.pinned = true;
    }
    while (s < summaries.length)
      nodes.push({ type: "summary", summary: summaries[s++] as Summary });
    return nodes;
  }

  /**
   * The session's top level before `before` on the scope's path: its top-level summaries and the
   * path's items they leave.
   */
  #top(before: number, pins: ReadonlySet<string>, scope: Scope): Node[] {
    const summaries = this.#rows<SummaryRow>(
      "SELECT * FROM summaries WHERE id IN (SELECT value FROM json_each(?)) ORDER BY from_seq",
      scope.top,
    ).map(summaryOf);
    const items = this.#rows<ItemRow>(
      `SELECT * FROM items WHERE seq < ? AND ${ON_PATH} AND NOT EXISTS (SELECT 1 FROM summaries s
        WHERE s.id IN (SELECT value FROM json_each(?)) AND items.seq BETWEEN s.from_seq AND s.to_seq)
        ORDER BY seq`,
      before,
      scope.turns,
      scope.turns,
      scope.top,
    ).map(itemOf);
    return this.#nodes(summaries, items, pins);
  }

  /** The children of a summary: its lower summaries and the path's items they leave. */
  #children(summary: Summary, pins: ReadonlySet<string>, scope: Scope): Node[] {
    const summaries = this.#rows<SummaryRow>(
      "SELECT * FROM summaries WHERE parent_id = ? ORDER BY from_seq",
      summary.id,
    ).map(summaryOf);
    const items = this.#rows<ItemRow>(
      `SELECT * FROM items WHERE seq BETWEEN ? AND ? AND ${ON_PATH} AND NOT EXISTS (SELECT 1 FROM
        summaries c WHERE c.parent_id = ? AND items.seq BETWEEN c.from_seq AND c.to_seq) ORDER BY seq`,
      summary.from_seq,
      summary.to_seq,
      scope.turns,
      scope.turns,
      summary.id,
    ).map(itemOf);
    return this.#nodes(summaries, items, pins);
  }

  /** Where the tail starts among the top-level nodes: it holds only segments. */
  #tailStart(nodes: Node[]): number {
    const tail = this.#options.tail;
    const estimator = this.#options.estimator;
    let start = nodes.length;
    let count = 0;
    let tokens = 0;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i] as Node;
      if (node.type !== "segment") break;
      if ("messages" in tail) {
        if (count >= tail.messages) break;
      } else {
        const t = node.items.reduce((n, item) => n + estimator.item(item), 0);
        if (count > 0 && tokens + t > tail.tokens) break;
        tokens += t;
      }
      count++;
      start = i;
    }
    return start;
  }

  /** An item as the context shows it: a tool result outside the tail, unpinned, is trimmed. */
  #entry(item: Item, trim: boolean, calls: Map<string, Item>): ContextEntry {
    if (item.kind === "tool_call" && item.callId) calls.set(item.callId, item);
    if (!trim || item.kind !== "tool_result" || item.output === undefined)
      return { type: "item", item };
    const call = item.callId ? calls.get(item.callId) : undefined;
    const output = trimToolResult(item.output, item.name, call?.args, this.#options.trim);
    return output === item.output
      ? { type: "item", item }
      : { type: "item", item: { ...item, output }, trimmed: true };
  }

  #covers(summary: Summary, pins: ReadonlySet<string>, pinned: Item[]): boolean {
    return (
      pins.size > 0 && pinned.some((i) => i.seq >= summary.from_seq && i.seq <= summary.to_seq)
    );
  }

  /** The tokens a node takes in the context; a segment's tool results trimmed when `trim`. */
  #tokens(node: Node, trim: boolean, pins: ReadonlySet<string>): number {
    if (node.type === "summary") return node.summary.tokens;
    const calls = new Map<string, Item>();
    let n = 0;
    for (const item of node.items) {
      const entry = this.#entry(item, trim && !pins.has(item.id), calls);
      if (entry.type === "item") n += this.#options.estimator.item(entry.item);
    }
    return n;
  }

  #estimate(nodes: Node[], tailStart: number, trim: boolean, pins: ReadonlySet<string>): number {
    return nodes.reduce((n, node, i) => n + this.#tokens(node, trim && i < tailStart, pins), 0);
  }

  #insert(
    summary: { content: string; sections?: SummarySection[] },
    depth: number,
    from: number,
    to: number,
  ): Summary {
    const id = `su-${crypto.randomUUID()}`;
    const last = this.#rows<{ turn: string }>("SELECT turn FROM items WHERE seq = ?", to)[0];
    this.#sql.exec(
      "INSERT INTO summaries (id, depth, from_seq, to_seq, parent_id, content, sections, tokens, through_turn, created) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
      id,
      depth,
      from,
      to,
      summary.content,
      summary.sections?.length ? JSON.stringify(summary.sections) : null,
      this.#options.estimator.text(summary.content),
      String(last?.turn ?? ""),
      Date.now(),
    );
    return summaryOf(
      this.#rows<SummaryRow>("SELECT * FROM summaries WHERE id = ?", id)[0] as SummaryRow,
    );
  }

  /**
   * Depth 1: the first run of unpinned segments before the tail, up to `groupSize` messages,
   * summarized and recorded as one summary over their item range.
   */
  async #group(
    nodes: Node[],
    tailStart: number,
    summarizer: Summarizer,
    hooks: {
      signal?: AbortSignal;
      path?: readonly string[];
      onTopics?(topics: Topic[]): void;
    },
  ): Promise<Summary | undefined> {
    const signal = hooks.signal;
    const run: Segment[] = [];
    for (let i = 0; i < tailStart && run.length < this.#options.groupSize; i++) {
      const node = nodes[i] as Node;
      if (node.type === "segment" && !node.pinned) {
        run.push(node);
        continue;
      }
      if (run.length) break;
    }
    const items = run.flatMap((segment) => segment.items);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return undefined;
    const current = this.#topics.list({ path: hooks.path });
    const out = await summarizer.summarize({ kind: "items", items, topics: current }, signal);
    signal?.throwIfAborted();
    const summary = this.#insert(out, 1, first.seq, last.seq);
    const written = this.#topics.merge(out.topics, {
      throughTurn: summary.through_turn,
      current,
      items: new Set(items.map((i) => i.id)),
    });
    if (written.length) hooks.onTopics?.(written);
    return summary;
  }

  /**
   * Deeper: the longest run of same-depth top-level summaries, if it holds at least
   * `promoteThreshold`, summarized into one summary a level deeper that becomes their parent.
   */
  async #promote(
    nodes: Node[],
    summarizer: Summarizer,
    signal?: AbortSignal,
  ): Promise<Summary | undefined> {
    let best: Summary[] = [];
    let run: Summary[] = [];
    for (const node of nodes) {
      // A summary with a parent (off the path) stays under it: a row's parent is set once.
      const free = node.type === "summary" && !node.summary.parent_id;
      if (free && run[0]?.depth === node.summary.depth) run.push(node.summary);
      else run = free ? [node.summary] : [];
      if (run.length > best.length) best = [...run];
    }
    const first = best[0];
    const last = best[best.length - 1];
    if (!first || !last || best.length < Math.max(2, this.#options.promoteThreshold))
      return undefined;
    const depth = first.depth + 1;
    const out = await summarizer.summarize({ kind: "summaries", summaries: best, depth }, signal);
    signal?.throwIfAborted();
    const summary = this.#insert(out, depth, first.from_seq, last.to_seq);
    for (const child of best)
      this.#sql.exec("UPDATE summaries SET parent_id = ? WHERE id = ?", summary.id, child.id);
    return summary;
  }

  /**
   * Compacts the session before a turn whose first item is `before`, while its model context is
   * over the budget: first by trimming tool results outside the tail, then by summarizing the
   * oldest messages outside the tail (depth 1), then by promoting runs of same-depth summaries.
   * Each new summary is reported to `onSummary`; a context still over the budget after
   * `maxPasses`, or with nothing left to compact, to `onThrash`.
   */
  async compact(
    before: number,
    summarizer: Summarizer,
    hooks: {
      signal?: AbortSignal;
      onSummary?(summary: Summary): void;
      onThrash?(info: { budget: number; estimated: number }): void;
      /** Told the topics a depth-1 summary's call wrote (statewalker/statewalker-root#174). */
      onTopics?(topics: Topic[]): void;
      /** The path of turns the context is on (statewalker/statewalker-root#190); none: every item. */
      path?: readonly string[];
    } = {},
  ): Promise<Summary[]> {
    const budget = this.#options.budgetTokens;
    let scope = this.#scope(before, hooks.path);
    const pins = this.#pins(before, scope);
    const made: Summary[] = [];
    let nodes = this.#top(before, pins, scope);
    let tailStart = this.#tailStart(nodes);
    if (this.#estimate(nodes, tailStart, false, pins) <= budget) return made;
    for (let pass = 0; ; pass++) {
      const estimated = this.#estimate(nodes, tailStart, true, pins);
      if (estimated <= budget) return made;
      const summary =
        pass < this.#options.maxPasses
          ? ((await this.#group(nodes, tailStart, summarizer, hooks)) ??
            (await this.#promote(nodes, summarizer, hooks.signal)))
          : undefined;
      if (!summary) {
        hooks.onThrash?.({ budget, estimated });
        return made;
      }
      made.push(summary);
      hooks.onSummary?.(summary);
      scope = this.#scope(before, hooks.path);
      nodes = this.#top(before, pins, scope);
      tailStart = this.#tailStart(nodes);
    }
  }

  /**
   * The model context of a turn whose first item is `before`, on the path of turns `path`
   * (statewalker/statewalker-root#190; none: every item).
   */
  context(before: number, path?: readonly string[]): ContextEntry[] {
    const scope = this.#scope(before, path);
    const pins = this.#pins(before, scope);
    const pinned = pins.size
      ? this.#rows<ItemRow>(
          `SELECT * FROM items WHERE id IN (${[...pins].map(() => "?").join(", ")})`,
          ...pins,
        ).map(itemOf)
      : [];
    const nodes = this.#top(before, pins, scope);
    const tailStart = this.#tailStart(nodes);
    const out: ContextEntry[] = [];
    const calls = new Map<string, Item>();
    const walk = (list: Node[], tailFrom: number) => {
      list.forEach((node, i) => {
        if (node.type === "summary") {
          if (this.#covers(node.summary, pins, pinned))
            walk(this.#children(node.summary, pins, scope), Number.POSITIVE_INFINITY);
          else out.push({ type: "summary", summary: node.summary });
          return;
        }
        for (const item of node.items)
          out.push(this.#entry(item, i < tailFrom && !pins.has(item.id), calls));
      });
    };
    walk(nodes, tailStart);
    return out;
  }
}

const POSITIVE: Record<string, keyof CompactionOptions> = {
  budget_tokens: "budgetTokens",
  group_size: "groupSize",
  promote_threshold: "promoteThreshold",
  max_passes: "maxPasses",
};

/**
 * The deployment's compaction settings (its `COMPACTION` var): JSON `{budget_tokens?,
 * tail_messages? | tail_tokens?, group_size?, promote_threshold?, max_passes?, pin_tools?,
 * trim_min_chars?}`. What cannot be read is left out (its default stays) and reported.
 */
export function parseCompaction(text: string | undefined): {
  options: Partial<CompactionOptions>;
  problems: string[];
} {
  const options: Partial<CompactionOptions> = {};
  const problems: string[] = [];
  if (text === undefined || text.trim() === "") return { options, problems };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { options, problems: ["COMPACTION is not a JSON object"] };
  const obj = raw as Record<string, unknown>;
  const positive = (key: string): number | undefined => {
    const v = obj[key];
    if (Number.isInteger(v) && (v as number) > 0) return v as number;
    problems.push(`${key} must be a positive integer`);
    return undefined;
  };
  if ("tail_messages" in obj && "tail_tokens" in obj)
    problems.push("set the tail by tail_messages or tail_tokens, not both");
  else if ("tail_messages" in obj) {
    const n = positive("tail_messages");
    if (n) options.tail = { messages: n };
  } else if ("tail_tokens" in obj) {
    const n = positive("tail_tokens");
    if (n) options.tail = { tokens: n };
  }
  for (const key of Object.keys(obj)) {
    if (key === "tail_messages" || key === "tail_tokens") continue;
    const name = POSITIVE[key];
    if (name) {
      const n = positive(key);
      if (n) (options as Record<string, unknown>)[name] = n;
    } else if (key === "pin_tools") {
      const v = obj[key];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) options.pinTools = v;
      else problems.push("pin_tools must be a list of tool names");
    } else if (key === "trim_min_chars") {
      const n = positive(key);
      if (n) options.trim = createTrimPolicy({ minChars: n });
    } else problems.push(`unknown setting ${key}`);
  }
  return { options, problems };
}
