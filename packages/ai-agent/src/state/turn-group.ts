import { NodeType } from "./node-types.js";
import { TreeNode } from "./tree-node.js";
import type { Turn } from "./turn.js";

/**
 * Structured section attached to a `TurnGroup.props.sections`.
 *
 * A section carries a theme (title), its prose body, and `refs` — node IDs
 * (of descendant `Turn`s for depth-1 groups, or of child `TurnGroup`s for
 * higher-depth groups) from which this section was drawn. `refs` are the
 * primary mechanism used by the hierarchical selector for zoom-in.
 */
export interface SummarySection {
  title: string;
  body: string;
  refs: string[];
}

/**
 * Intermediate node that wraps a contiguous range of older `Turn`s (or
 * lower-depth `TurnGroup`s) and carries a single summary of its direct
 * children.
 *
 * Convention: summary prose lives on `node.content` (human-readable in
 * markdown dumps); structured metadata lives in `node.props`:
 *
 *   - `stamp`         — monotonic compaction-pass id that produced/updated
 *                       this summary.
 *   - `depth`         — 1 for a group whose children are raw `Turn`s, 2 for
 *                       a group whose children are depth-1 groups, etc.
 *   - `sections`      — optional `SummarySection[]` for subject-structured
 *                       summaries.
 *   - `tokensEstimate`— cached size of the rendered summary message.
 *   - `model`         — id of the LanguageModel that produced the summary.
 */
export class TurnGroup extends TreeNode {
  // ── Summary text lives in node.content (readable in markdown dumps) ──

  get summaryText(): string | undefined {
    return this.content;
  }

  set summaryText(value: string | undefined) {
    this.content = value;
    this.touch();
  }

  // ── Structure lives in node.props ───────────────────────────

  get stamp(): string | undefined {
    return this.props.stamp as string | undefined;
  }

  set stamp(value: string | undefined) {
    this.props.stamp = value;
    this.touch();
  }

  get depth(): number {
    return (this.props.depth as number) ?? 1;
  }

  set depth(value: number) {
    this.props.depth = value;
    this.touch();
  }

  get sections(): SummarySection[] | undefined {
    return this.props.sections as SummarySection[] | undefined;
  }

  set sections(value: SummarySection[] | undefined) {
    if (value === undefined) {
      delete this.props.sections;
    } else {
      this.props.sections = value;
    }
    this.touch();
  }

  get tokensEstimate(): number {
    return (this.props.tokensEstimate as number) ?? 0;
  }

  set tokensEstimate(value: number) {
    this.props.tokensEstimate = value;
    this.touch();
  }

  get model(): string | undefined {
    return this.props.model as string | undefined;
  }

  set model(value: string | undefined) {
    if (value === undefined) {
      delete this.props.model;
    } else {
      this.props.model = value;
    }
    this.touch();
  }

  // ── Derived accessors over descendants ──────────────────────

  /**
   * IDs of the first and last raw `Turn` descendants in document order.
   * Returns `undefined` if the group contains no raw turns.
   */
  get coveredRange(): { firstTurnId: string; lastTurnId: string } | undefined {
    const turns = this.descendantTurns();
    const first = turns[0];
    const last = turns[turns.length - 1];
    if (!first || !last) return undefined;
    return { firstTurnId: first.id, lastTurnId: last.id };
  }

  /** Total count of raw `Turn`s anywhere below this group. */
  get childTurnCount(): number {
    return this.descendantTurns().length;
  }

  /**
   * All raw `Turn` descendants in document order, recursing through any
   * nested `TurnGroup` children.
   */
  descendantTurns(): Turn[] {
    const out: Turn[] = [];
    for (const child of this.children) {
      if (child.type === NodeType.turn) {
        out.push(child as Turn);
      } else if (child.type === NodeType.turnGroup) {
        out.push(...(child as TurnGroup).descendantTurns());
      }
    }
    return out;
  }
}
