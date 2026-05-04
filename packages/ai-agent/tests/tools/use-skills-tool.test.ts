import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsModel } from "../../src/state/skills-model.js";
import { createUseSkillsTool } from "../../src/tools/use-skills-tool.js";

// Mock generateText at the module level
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from "ai";

const mockGenerateText = generateText as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGenerateText.mockReset();
});

type SkillResult = {
  selected: string[];
  content: Array<{ name: string; content: string }>;
};

function fakeProvider(): import("@ai-sdk/provider").ProviderV3 {
  return {
    languageModel: vi.fn().mockReturnValue("fake-model"),
  } as unknown as import("@ai-sdk/provider").ProviderV3;
}

async function executeTool(
  toolDef: ReturnType<typeof createUseSkillsTool>,
  prompt: string,
): Promise<SkillResult> {
  const exec = toolDef.execute;
  if (!exec) throw new Error("execute is undefined");
  const result = await exec({ prompt }, {
    toolCallId: "test",
    messages: [],
  } as Parameters<typeof exec>[1]);
  return result as SkillResult;
}

describe("createUseSkillsTool", () => {
  it("calls generateText with available skills and prompt", async () => {
    const skills = new SkillsModel();
    skills.register({
      name: "file-ops",
      description: "File operations",
      content: "# File Ops\nRead/write files.",
    });
    skills.register({
      name: "math",
      description: "Math utilities",
      content: "# Math\nCalculations.",
    });

    mockGenerateText.mockResolvedValue({
      text: '{"selected": ["file-ops"]}',
    });

    const useTool = createUseSkillsTool({
      skills,
      provider: fakeProvider(),
      model: "test-model",
    });

    const result = await executeTool(useTool, "I need to manage files");

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0]?.[0];
    expect(call.prompt).toContain("manage files");
    expect(call.prompt).toContain("file-ops: File operations");
    expect(call.prompt).toContain("math: Math utilities");

    expect(result.selected).toEqual(["file-ops"]);
    expect(result.content).toEqual([
      { name: "file-ops", content: "# File Ops\nRead/write files." },
    ]);
  });

  it("updates SkillsModel.selected", async () => {
    const skills = new SkillsModel();
    skills.register({
      name: "skill-a",
      description: "A",
      content: "Content A",
    });

    mockGenerateText.mockResolvedValue({
      text: '{"selected": ["skill-a"]}',
    });

    const useTool = createUseSkillsTool({
      skills,
      provider: fakeProvider(),
      model: "m",
    });

    await executeTool(useTool, "test");

    expect(skills.selected).toHaveLength(1);
    expect(skills.selected[0]?.name).toBe("skill-a");
  });

  it("returns empty when no skills are available", async () => {
    const skills = new SkillsModel();

    const useTool = createUseSkillsTool({
      skills,
      provider: fakeProvider(),
      model: "m",
    });

    const result = await executeTool(useTool, "test");

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(result).toEqual({ selected: [], content: [] });
  });

  it("ignores unknown skill names from LLM", async () => {
    const skills = new SkillsModel();
    skills.register({
      name: "real",
      description: "Real skill",
      content: "Real",
    });

    mockGenerateText.mockResolvedValue({
      text: '{"selected": ["real", "hallucinated"]}',
    });

    const useTool = createUseSkillsTool({
      skills,
      provider: fakeProvider(),
      model: "m",
    });

    const result = await executeTool(useTool, "test");

    // Only the real skill is selected (filtered against availableNames)
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.name).toBe("real");
  });

  it("accepts a bare JSON array (common from local models)", async () => {
    const skills = new SkillsModel();
    skills.register({ name: "search", description: "Search", content: "S" });
    skills.register({
      name: "browse-notes",
      description: "Browse notes",
      content: "B",
    });

    // This is exactly what Qwen3.5-2B (transformers.js) produces —
    // a bare array instead of `{"selected": [...]}`.
    mockGenerateText.mockResolvedValue({
      text: '["search","browse-notes"]',
    });

    const useTool = createUseSkillsTool({
      skills,
      provider: fakeProvider(),
      model: "m",
    });

    const result = await executeTool(useTool, "test");

    expect(result.selected).toEqual(["search", "browse-notes"]);
  });

  it("extracts the array even when the model wraps it in prose", async () => {
    const skills = new SkillsModel();
    skills.register({ name: "search", description: "S", content: "S" });

    mockGenerateText.mockResolvedValue({
      text: 'Here are the relevant skills: ["search"]. Hope this helps!',
    });

    const useTool = createUseSkillsTool({
      skills,
      provider: fakeProvider(),
      model: "m",
    });

    const result = await executeTool(useTool, "test");

    expect(result.selected).toEqual(["search"]);
  });

  it("returns no selection when parsing fails", async () => {
    const skills = new SkillsModel();
    skills.register({ name: "search", description: "S", content: "S" });

    mockGenerateText.mockResolvedValue({
      text: "I don't know which skills are relevant.",
    });

    const useTool = createUseSkillsTool({
      skills,
      provider: fakeProvider(),
      model: "m",
    });

    const result = await executeTool(useTool, "test");

    expect(result.selected).toEqual([]);
  });
});
