import { extractTime, SnowflakeId } from "@repo/ids";
import { BaseClass } from "@repo/shared/models";
import type { TreeNode } from "./types.js";

const defaultIdGen = new SnowflakeId();

export interface TreeEntryOptions {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: string;
  idGen?: SnowflakeId;
}

export class TreeEntry extends BaseClass implements TreeNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: string;
  children?: TreeEntry[];
  parent?: TreeEntry;

  private _childCleanups = new Map<TreeEntry, () => void>();
  private _cachedUpdatedAt?: Date;

  constructor(options: TreeEntryOptions = {}) {
    super();
    this.id = options.id ?? (options.idGen ?? defaultIdGen).generate();
    this.type = options.type ?? "node";
    this.props = options.props ?? {};
    if (options.content !== undefined) {
      this.content = options.content;
    }
  }

  get parentId(): string | undefined {
    return this.parent?.id;
  }

  /** Creation time extracted from the Snowflake ID. */
  get createdAt(): Date {
    return new Date(extractTime(this.id));
  }

  /**
   * Last update time. Source of truth is `props.updatedAt` (number ms or ISO string).
   * Falls back to `createdAt` if not set. Cached until changed via `touch()`.
   */
  get updatedAt(): Date {
    if (this._cachedUpdatedAt) return this._cachedUpdatedAt;
    const raw = this.props.updatedAt;
    if (typeof raw === "number") {
      this._cachedUpdatedAt = new Date(raw);
    } else if (typeof raw === "string") {
      this._cachedUpdatedAt = new Date(raw);
    } else {
      return this.createdAt;
    }
    return this._cachedUpdatedAt;
  }

  /**
   * Mark this node as updated: sets `props.updatedAt` to now,
   * clears the cache, and calls `notify()` + `bubbleUp()`.
   */
  touch(): void {
    const now = new Date();
    this.props.updatedAt = now.toISOString();
    this._cachedUpdatedAt = now;
    this.bubbleUp();
  }

  addChild(child: TreeEntry): TreeEntry {
    child.parent = this;
    const unsub = child.onUpdate(() => this.bubbleUp());
    this._childCleanups.set(child, unsub);
    this.children = [...(this.children ?? []), child];
    this.notify();
    return child;
  }

  removeChild(child: TreeEntry): void {
    const unsub = this._childCleanups.get(child);
    if (unsub) {
      unsub();
      this._childCleanups.delete(child);
    }
    child.parent = undefined;
    this.children = (this.children ?? []).filter((c) => c !== child);
    this.notify();
  }

  bubbleUp(): void {
    this.notify();
    this.parent?.bubbleUp();
  }

  visit(
    begin: (node: TreeNode) => undefined | boolean,
    end?: () => void,
  ): void {
    const node: TreeNode = {
      id: this.id,
      type: this.type,
      props: this.props,
    };
    if (this.content !== undefined) {
      node.content = this.content;
    }
    if (this.children && this.children.length > 0) {
      node.children = this.children;
    }

    const result = begin(node);

    if (result !== false && this.children) {
      for (const child of this.children) {
        child.visit(begin, end);
      }
    }

    end?.();
  }
}
