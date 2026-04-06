import { extractTime } from "@repo/ids";
import { BaseClass } from "@repo/shared/models";
import type { NewEntryOptions, NodeFactory, TreeEntry } from "./types.js";

/** Default factory — creates plain TreeNode for any data. */
const defaultFactory: NodeFactory = ((data: TreeEntry | NewEntryOptions) =>
  new TreeNode(data as TreeEntry, defaultFactory)) as NodeFactory;

/**
 * Reactive wrapper over `TreeEntry` data.
 * Caches child wrappers created via the factory.
 *
 * Subclasses (Session, Turn, Message, ToolCall) add typed accessors.
 */
export class TreeNode extends BaseClass {
  readonly data: TreeEntry;
  readonly factory: NodeFactory;
  parent?: TreeNode;

  private _childCleanups = new WeakMap<TreeNode, () => void>();
  private _childCache = new Map<string, TreeNode>();
  private _cachedUpdatedAt?: Date;

  constructor(data: TreeEntry, factory: NodeFactory = defaultFactory) {
    super();
    this.data = data;
    this.factory = factory;
  }

  // ── Data delegates ──────────────────────────────────────────

  get id(): string {
    return this.data.id;
  }

  get props(): Record<string, unknown> {
    return this.data.props;
  }

  get type(): string {
    return (this.data.props.type as string) ?? "message";
  }

  get content(): string | undefined {
    return this.data.content;
  }

  set content(value: string | undefined) {
    this.data.content = value;
  }

  get parentId(): string | undefined {
    return this.parent?.id;
  }

  // ── Timestamps ──────────────────────────────────────────────

  get createdAt(): Date {
    return new Date(extractTime(this.id));
  }

  get updatedAt(): Date {
    if (this._cachedUpdatedAt) return this._cachedUpdatedAt;
    const raw = this.data.props.updatedAt;
    if (typeof raw === "string") {
      this._cachedUpdatedAt = new Date(raw);
    } else if (typeof raw === "number") {
      this._cachedUpdatedAt = new Date(raw);
    } else {
      return this.createdAt;
    }
    return this._cachedUpdatedAt;
  }

  touch(): void {
    const now = new Date();
    this.data.props.updatedAt = now.toISOString();
    this._cachedUpdatedAt = now;
    this.bubbleUp();
  }

  /**
   * Merge props and optionally replace content. Calls `bubbleUp()`.
   */
  update(props?: Record<string, unknown>, content?: string): void {
    if (props) {
      Object.assign(this.data.props, props);
    }
    if (content !== undefined) {
      this.data.content = content;
    }
    this._cachedUpdatedAt = undefined;
    this.bubbleUp();
  }

  // ── Children (cached wrappers via factory) ──────────────────

  get children(): TreeNode[] {
    const dataChildren = this.data.children;
    if (!dataChildren || dataChildren.length === 0) return [];

    const result: TreeNode[] = [];
    for (const entry of dataChildren) {
      let cached = this._childCache.get(entry.id);
      if (!cached) {
        cached = this._wrapChild(entry);
      }
      result.push(cached);
    }
    return result;
  }

  /**
   * Add a child node. Accepts either:
   * - `TreeEntry` (existing data with id) — for deserialization/sync
   * - `NewEntryOptions` (no id required) — for creating new nodes
   *
   * The factory generates an id if not provided and creates the typed wrapper.
   */
  addChild(data: TreeEntry | NewEntryOptions): TreeNode {
    // Factory handles id generation and type dispatch
    const node = this.factory(data);
    const entry = node.data;

    this.data.children ??= [];
    this.data.children = [...this.data.children, entry];

    node.parent = this;
    this._childCache.set(entry.id, node);
    const unsub = node.onUpdate(() => this.bubbleUp());
    this._childCleanups.set(node, unsub);

    this.bubbleUp();
    return node;
  }

  removeChild(child: TreeNode): void {
    const unsub = this._childCleanups.get(child);
    if (unsub) {
      unsub();
      this._childCleanups.delete(child);
    }
    this._childCache.delete(child.id);
    child.parent = undefined;
    this.data.children = (this.data.children ?? []).filter(
      (c) => c.id !== child.id,
    );
    this.bubbleUp();
  }

  remove() {
    this.parent?.removeChild(this);
  }

  childrenOfType(type: string): TreeNode[] {
    return this.children.filter((c) => c.type === type);
  }

  // ── Propagation ─────────────────────────────────────────────

  bubbleUp(): void {
    this.notify();
    this.parent?.bubbleUp();
  }

  // ── Traversal ───────────────────────────────────────────────

  visit(
    begin: (entry: TreeEntry) => undefined | boolean,
    end?: () => void,
  ): void {
    const entry: TreeEntry = {
      id: this.data.id,
      props: this.data.props,
    };
    if (this.data.content !== undefined) {
      entry.content = this.data.content;
    }
    if (this.data.children && this.data.children.length > 0) {
      entry.children = this.data.children;
    }

    const result = begin(entry);

    if (result !== false && this.data.children) {
      for (const child of this.children) {
        child.visit(begin, end);
      }
    }

    end?.();
  }

  // ── Internal ────────────────────────────────────────────────

  /** Wrap an existing TreeEntry child (from data.children) without going through factory addChild path. */
  private _wrapChild(entry: TreeEntry): TreeNode {
    const node = this.factory(entry);
    node.parent = this;
    this._childCache.set(entry.id, node);

    const unsub = node.onUpdate(() => this.bubbleUp());
    this._childCleanups.set(node, unsub);

    return node;
  }
}

/**
 * Wrap a `TreeEntry` data tree using a factory.
 */
export function wrapTree(
  data: TreeEntry | NewEntryOptions,
  factory: NodeFactory,
): TreeNode {
  return factory(data);
}
