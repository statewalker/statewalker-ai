import { BaseClass } from "@repo/shared-baseclass";
import { parseSkillMarkdown } from "../skills/skill-parser.js";
import type { SkillInfo } from "../skills/skill-types.js";

export class SkillsModel extends BaseClass {
  #registry = new Map<string, SkillInfo>();
  #selected = new Set<string>();

  /** Register a skill. Returns a function to unregister it. */
  register(skill: SkillInfo): () => void {
    this.#registry.set(skill.name, skill);
    this.notify();
    return () => {
      this.#registry.delete(skill.name);
      this.#selected.delete(skill.name);
      this.notify();
    };
  }

  /** Register a skill from markdown text. Returns a function to unregister it. */
  registerFromMarkdown(text: string, location?: string): () => void {
    const info = parseSkillMarkdown(text, location);
    return this.register(info);
  }

  /** Set the selected skill set. Unknown names are silently ignored. */
  select(names: string[]): void {
    this.#selected.clear();
    for (const name of names) {
      if (this.#registry.has(name)) {
        this.#selected.add(name);
      }
    }
    this.notify();
  }

  /** Clear all selected skills. */
  reset(): void {
    this.#selected.clear();
    this.notify();
  }

  /** Get full info for all selected skills. */
  get selected(): SkillInfo[] {
    return [...this.#selected]
      .map((name) => this.#registry.get(name))
      .filter((s): s is SkillInfo => s !== undefined);
  }

  /** List all registered skills (name + description only). */
  get available(): Array<{ name: string; description: string }> {
    return [...this.#registry.values()].map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  get size(): number {
    return this.#registry.size;
  }
}
