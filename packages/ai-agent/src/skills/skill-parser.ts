import type { SkillInfo } from "./skill-types.js";

/**
 * Parse a SKILL.md file (YAML frontmatter + markdown body) into a SkillInfo.
 *
 * Supports simple `key: value` frontmatter between `---` delimiters.
 * No external YAML library required — keeps it browser-compatible.
 *
 * If no frontmatter is found, uses the first `# heading` as name
 * and the first paragraph as description.
 */
export function parseSkillMarkdown(text: string, location?: string): SkillInfo {
  const trimmed = text.trim();

  if (trimmed.startsWith("---")) {
    return parseWithFrontmatter(trimmed, location);
  }
  return parseWithoutFrontmatter(trimmed, location);
}

function parseWithFrontmatter(text: string, location?: string): SkillInfo {
  // Find closing ---
  const endIndex = text.indexOf("---", 3);
  if (endIndex === -1) {
    return parseWithoutFrontmatter(text, location);
  }

  const frontmatter = text.slice(3, endIndex).trim();
  const content = text.slice(endIndex + 3).trim();

  const fields = parseFrontmatterFields(frontmatter);
  const name = fields.name || extractHeadingName(content) || "unnamed";
  const description = fields.description || extractFirstParagraph(content);

  return { name, description, content, ...(location && { location }) };
}

function parseWithoutFrontmatter(text: string, location?: string): SkillInfo {
  const name = extractHeadingName(text) || "unnamed";
  const description = extractFirstParagraph(text);
  return { name, description, content: text, ...(location && { location }) };
}

function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line
      .slice(colonIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && value) {
      fields[key] = value;
    }
  }
  return fields;
}

function extractHeadingName(text: string): string | undefined {
  const match = /^#\s+(.+)/m.exec(text);
  return match?.[1]?.trim();
}

function extractFirstParagraph(text: string): string {
  // Skip headings and blank lines, take the first non-empty non-heading line
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return "";
}
