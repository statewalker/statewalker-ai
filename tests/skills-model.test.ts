import { describe, expect, it, vi } from "vitest";
import { SkillsModel } from "../src/state/skills-model.js";

const SKILL_A = {
  name: "skill-a",
  description: "Skill A",
  content: "Content A",
};
const SKILL_B = {
  name: "skill-b",
  description: "Skill B",
  content: "Content B",
};

describe("SkillsModel", () => {
  it("register adds to available", () => {
    const model = new SkillsModel();
    model.register(SKILL_A);

    expect(model.available).toEqual([
      { name: "skill-a", description: "Skill A" },
    ]);
    expect(model.size).toBe(1);
  });

  it("unregister removes from available and selected", () => {
    const model = new SkillsModel();
    const unsub = model.register(SKILL_A);
    model.select(["skill-a"]);
    unsub();

    expect(model.available).toEqual([]);
    expect(model.selected).toEqual([]);
  });

  it("select sets selected skills", () => {
    const model = new SkillsModel();
    model.register(SKILL_A);
    model.register(SKILL_B);
    model.select(["skill-a"]);

    expect(model.selected).toEqual([SKILL_A]);
  });

  it("select ignores unknown names", () => {
    const model = new SkillsModel();
    model.register(SKILL_A);
    model.select(["nonexistent"]);

    expect(model.selected).toEqual([]);
  });

  it("select replaces previous selection", () => {
    const model = new SkillsModel();
    model.register(SKILL_A);
    model.register(SKILL_B);

    model.select(["skill-a"]);
    model.select(["skill-b"]);

    expect(model.selected).toEqual([SKILL_B]);
  });

  it("reset clears selection", () => {
    const model = new SkillsModel();
    model.register(SKILL_A);
    model.select(["skill-a"]);
    model.reset();

    expect(model.selected).toEqual([]);
  });

  it("registerFromMarkdown parses and registers", () => {
    const model = new SkillsModel();
    const md = `---
name: from-md
description: Parsed skill
---
Skill content here.`;

    model.registerFromMarkdown(md, "/path/skill.md");

    expect(model.available).toEqual([
      { name: "from-md", description: "Parsed skill" },
    ]);
    const [skill] = model.selected.length ? model.selected : [];
    // Not selected yet — just registered
    expect(skill).toBeUndefined();

    model.select(["from-md"]);
    expect(model.selected[0]?.content).toBe("Skill content here.");
    expect(model.selected[0]?.location).toBe("/path/skill.md");
  });

  it("notifies on select", () => {
    const model = new SkillsModel();
    model.register(SKILL_A);

    const listener = vi.fn();
    model.onUpdate(listener);

    model.select(["skill-a"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies on reset", () => {
    const model = new SkillsModel();
    model.register(SKILL_A);
    model.select(["skill-a"]);

    const listener = vi.fn();
    model.onUpdate(listener);

    model.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies on register", () => {
    const model = new SkillsModel();
    const listener = vi.fn();
    model.onUpdate(listener);

    model.register(SKILL_A);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
