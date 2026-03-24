/**
 * Skills — domain expertise loaded from SKILL.md files.
 *
 * Compatible with the AgentSkills standard (https://agentskills.io).
 * A skill is a directory containing a SKILL.md with YAML frontmatter
 * and markdown instructions. The agent sees a compact index of available
 * skills and reads the full file on demand.
 */

export interface SkillInfo {
  name: string;
  description: string;
  /** Opaque location hint (URL, path, etc.) — informational only. */
  location?: string;
  /** Full markdown content of the skill. */
  content: string;
}

export interface SkillSet {
  skills: SkillInfo[];
  /** Format the skill index for injection into the system prompt. */
  formatForPrompt(): string;
}

/**
 * Create a SkillSet from an array of skill infos.
 */
export function createSkillSet(skills: SkillInfo[]): SkillSet {
  return {
    skills,
    formatForPrompt() {
      if (skills.length === 0) return "";
      const lines = skills.map((s) => {
        const path = s.location ? ` path="${s.location}"` : "";
        return `  <skill name="${s.name}"${path}>${s.description}</skill>`;
      });
      return `<available-skills>\n${lines.join("\n")}\n</available-skills>`;
    },
  };
}

/**
 * Registry for dynamic skill management (register/unregister/lookup).
 */
export class SkillRegistry {
  #skills = new Map<string, SkillInfo>();

  /** Register a skill. Returns a function to unregister it. */
  register(skill: SkillInfo): () => void {
    this.#skills.set(skill.name, skill);
    return () => {
      this.#skills.delete(skill.name);
    };
  }

  /** List all registered skills (name + description only). */
  list(): Array<{ name: string; description: string }> {
    return [...this.#skills.values()].map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  /** Get a skill by name. Returns undefined if not found. */
  get(name: string): SkillInfo | undefined {
    return this.#skills.get(name);
  }

  /** Number of registered skills. */
  get size(): number {
    return this.#skills.size;
  }
}

/**
 * Parse a SKILL.md file into a SkillInfo.
 * Expects YAML frontmatter with `name` and `description` fields.
 */
export function parseSkillMarkdown(
  markdown: string,
  location: string,
): SkillInfo | null {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1] ?? "";
  const content = match[2] ?? "";

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch) return null;

  const name = nameMatch[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const description = descMatch
    ? (descMatch[1]?.trim().replace(/^["']|["']$/g, "") ?? "")
    : "";

  return { name, description, location, content };
}
