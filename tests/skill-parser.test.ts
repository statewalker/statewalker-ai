import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../src/skills/skill-parser.js";

describe("parseSkillMarkdown", () => {
  describe("with frontmatter", () => {
    it("parses name, description, and content from frontmatter", () => {
      const text = `---
name: my-skill
description: Does useful things
---
# Heading

Body text here.`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("my-skill");
      expect(result.description).toBe("Does useful things");
      expect(result.content).toBe("# Heading\n\nBody text here.");
    });

    it("strips quotes from frontmatter values", () => {
      const text = `---
name: "quoted-name"
description: 'single-quoted'
---
Content`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("quoted-name");
      expect(result.description).toBe("single-quoted");
    });

    it("falls back to heading for name if frontmatter name is missing", () => {
      const text = `---
description: A description
---
# Fallback Name

Some content.`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("Fallback Name");
      expect(result.description).toBe("A description");
    });

    it("falls back to first paragraph for description if not in frontmatter", () => {
      const text = `---
name: my-skill
---
# Heading

First paragraph here.`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("my-skill");
      expect(result.description).toBe("First paragraph here.");
    });

    it("handles unclosed frontmatter as no-frontmatter", () => {
      const text = `---
name: broken
No closing delimiter
# Heading
Body`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("Heading");
    });

    it("passes location through", () => {
      const text = `---
name: loc-skill
description: test
---
Content`;

      const result = parseSkillMarkdown(text, "/path/to/skill.md");
      expect(result.location).toBe("/path/to/skill.md");
    });

    it("omits location when not provided", () => {
      const text = `---
name: no-loc
description: test
---
Content`;

      const result = parseSkillMarkdown(text);
      expect(result.location).toBeUndefined();
    });
  });

  describe("without frontmatter", () => {
    it("extracts name from first heading", () => {
      const text = `# My Skill

A useful skill.

More details.`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("My Skill");
      expect(result.description).toBe("A useful skill.");
      expect(result.content).toBe(text);
    });

    it("uses 'unnamed' when no heading exists", () => {
      const text = "Just some text";

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("unnamed");
      expect(result.description).toBe("Just some text");
    });

    it("skips blank lines and headings for description", () => {
      const text = `# Title

## Subtitle

Actual first paragraph.`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("Title");
      expect(result.description).toBe("Actual first paragraph.");
    });

    it("returns empty description when only headings exist", () => {
      const text = `# Title
## Subtitle`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("Title");
      expect(result.description).toBe("");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const result = parseSkillMarkdown("");
      expect(result.name).toBe("unnamed");
      expect(result.description).toBe("");
      expect(result.content).toBe("");
    });

    it("handles whitespace-only string", () => {
      const result = parseSkillMarkdown("   \n  \n  ");
      expect(result.name).toBe("unnamed");
      expect(result.description).toBe("");
    });

    it("trims surrounding whitespace", () => {
      const text = `\n\n---
name: trimmed
description: test
---
Content\n\n`;

      const result = parseSkillMarkdown(text);
      expect(result.name).toBe("trimmed");
      expect(result.content).toBe("Content");
    });
  });
});
