import { describe, expect, it } from "vitest";
import {
  createSkillSet,
  parseSkillMarkdown,
} from "../src/skills/skill-types.js";

describe("parseSkillMarkdown", () => {
  it("parses YAML frontmatter", () => {
    const md = `---
name: git
description: Git version control operations
---

# Git Skill

Use this skill for git operations.`;

    const result = parseSkillMarkdown(md, "./skills/git/SKILL.md");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("git");
    expect(result?.description).toBe("Git version control operations");
    expect(result?.content).toContain("# Git Skill");
  });

  it("returns null for invalid markdown", () => {
    expect(parseSkillMarkdown("no frontmatter", "test.md")).toBeNull();
  });
});

describe("createSkillSet", () => {
  it("formats skills for prompt injection", () => {
    const skills = createSkillSet([
      {
        name: "git",
        description: "Git operations",
        location: "./skills/git/SKILL.md",
        content: "...",
      },
    ]);
    const prompt = skills.formatForPrompt();
    expect(prompt).toContain("<available-skills>");
    expect(prompt).toContain('name="git"');
  });

  it("returns empty string for no skills", () => {
    const skills = createSkillSet([]);
    expect(skills.formatForPrompt()).toBe("");
  });
});
