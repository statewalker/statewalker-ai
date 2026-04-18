import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBuilder } from "../../src/builder/agent-builder.js";
import type { HierarchicalSummarizer } from "../../src/context/hierarchical-summarizer.js";
import { selectAll } from "../../src/context/select-messages.js";

function mockProvider() {
  return { languageModel: vi.fn() } as unknown as import(
    "@ai-sdk/provider"
  ).ProviderV3;
}

function stubSummarizer(): HierarchicalSummarizer {
  return {
    summarize: vi.fn(async () => ({ content: "stub" })),
  };
}

describe("AgentBuilder.withBudgetCompaction", () => {
  let files: MemFilesApi;

  beforeEach(() => {
    files = new MemFilesApi();
  });

  it("is chainable and returns the same builder instance", () => {
    const b = new AgentBuilder();
    expect(
      b
        .withProvider(mockProvider())
        .withBudgetCompaction({
          budgetTokens: 1000,
          summarizer: stubSummarizer(),
        })
        .withModel("m"),
    ).toBe(b);
  });

  it("build() installs hierarchical selector and compactor on the controller", async () => {
    const agent = await new AgentBuilder()
      .withProvider(mockProvider())
      .withModel("m")
      .withFilesApi(files)
      .withBudgetCompaction({
        budgetTokens: 1000,
        summarizer: stubSummarizer(),
      })
      .build();

    expect(agent.controller.select).toBeTypeOf("function");
    expect(agent.controller.compactor).toBeDefined();
    expect(agent.controller.compactOptions?.budgetTokens).toBe(1000);
  });

  it("applies documented defaults when optional fields are missing", async () => {
    const agent = await new AgentBuilder()
      .withProvider(mockProvider())
      .withModel("m")
      .withFilesApi(files)
      .withBudgetCompaction({
        budgetTokens: 1000,
        summarizer: stubSummarizer(),
      })
      .build();

    expect(agent.controller.compactOptions?.keepRecentTurns).toBe(4);
    expect(agent.controller.compactOptions?.estimator).toBeDefined();
    expect(agent.controller.compactOptions?.pinPolicy).toBeDefined();
    expect(agent.controller.compactOptions?.elisionPolicy).toBeDefined();
  });

  it("last-set wins: withSelectionStrategy overrides prior withBudgetCompaction", async () => {
    const agent = await new AgentBuilder()
      .withProvider(mockProvider())
      .withModel("m")
      .withFilesApi(files)
      .withBudgetCompaction({
        budgetTokens: 1000,
        summarizer: stubSummarizer(),
      })
      .withSelectionStrategy(selectAll)
      .build();

    expect(agent.controller.select).toBe(selectAll);
    expect(agent.controller.compactor).toBeUndefined();
    expect(agent.controller.compactOptions).toBeUndefined();
  });

  it("last-set wins: withBudgetCompaction overrides prior withSelectionStrategy", async () => {
    const agent = await new AgentBuilder()
      .withProvider(mockProvider())
      .withModel("m")
      .withFilesApi(files)
      .withSelectionStrategy(selectAll)
      .withBudgetCompaction({
        budgetTokens: 1000,
        summarizer: stubSummarizer(),
      })
      .build();

    expect(agent.controller.select).not.toBe(selectAll);
    expect(agent.controller.compactor).toBeDefined();
  });
});
