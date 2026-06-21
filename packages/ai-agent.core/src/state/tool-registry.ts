import { BaseClass } from "@statewalker/shared-baseclass";
import type { Tool, ToolSet } from "ai";

export class ToolRegistry extends BaseClass {
  #tools = new Map<string, Tool>();

  /** Register a tool. Returns a function to unregister it. */
  register(name: string, tool: Tool): () => void {
    this.#tools.set(name, tool);
    this.notify();
    return () => {
      this.#tools.delete(name);
      this.notify();
    };
  }

  /** Snapshot as Vercel AI SDK ToolSet — called on each turn. */
  toToolSet(): ToolSet {
    return Object.fromEntries(this.#tools);
  }

  get size(): number {
    return this.#tools.size;
  }
}
