import { SnowflakeId } from "@repo/ids";
import { BaseClass } from "@repo/shared/models";
import type { TreeNode } from "./types.js";

const defaultIdGen = new SnowflakeId();

export class TreeEntry extends BaseClass implements TreeNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: string;
  children?: TreeEntry[];
  parent?: TreeEntry;

  private _childCleanups = new Map<TreeEntry, () => void>();

  constructor(
    type: string,
    options?: {
      id?: string;
      props?: Record<string, unknown>;
      content?: string;
      idGen?: SnowflakeId;
    },
  ) {
    super();
    this.id = options?.id ?? (options?.idGen ?? defaultIdGen).generate();
    this.type = type;
    this.props = options?.props ?? {};
    if (options?.content !== undefined) {
      this.content = options.content;
    }
  }

  get parentId(): string | undefined {
    return this.parent?.id;
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
