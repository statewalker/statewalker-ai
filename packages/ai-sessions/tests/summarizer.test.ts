// The summarizer and the pieces ported with it from ai-agent.core (statewalker/statewalker-root#131):
// the input it renders for a model, how it reads the reply, tool-result trimming and the token
// estimator.
import { describe, expect, it } from "vitest";
import {
  type Complete,
  createModelSummarizer,
  createTokenEstimator,
  createTrimPolicy,
  type Item,
  SUMMARIZER_PROMPT_START,
  type Summary,
  trimToolResult,
} from "../src/index.js";

const item = (seq: number, rest: Partial<Item>): Item =>
  ({ seq, id: `it-${seq}`, turn: "s.tu-1", kind: "message", ...rest }) as Item;

const ITEMS: Item[] = [
  item(1, { role: "user", text: "read the readme" }),
  item(2, { kind: "tool_call", callId: "c1", name: "read", args: { path: "/alpha/readme.md" } }),
  item(3, { kind: "tool_result", callId: "c1", name: "read", output: "z".repeat(3000) }),
  item(4, { role: "assistant", text: "It says alpha." }),
];

function replies(...texts: string[]): Complete & { asked: Parameters<Complete>[0][] } {
  const asked: Parameters<Complete>[0][] = [];
  const fn = (async (request) => {
    asked.push(request);
    return texts.shift() ?? "";
  }) as Complete & { asked: Parameters<Complete>[0][] };
  fn.asked = asked;
  return fn;
}

describe("summarizer", () => {
  it("renders items tagged with their ids, long tool results trimmed, and keeps only sections whose refs it was given", async () => {
    const complete = replies(
      'Here it is:\n```json\n{"content": " Read the readme. ", "sections": [{"title": "Files", "body": "readme", "refs": ["it-2", "it-99"]}, {"title": "Made up", "body": "x", "refs": ["it-77"]}]}\n```',
    );
    const out = await createModelSummarizer({ complete }).summarize({
      kind: "items",
      items: ITEMS,
    });
    expect(out).toEqual({
      content: "Read the readme.",
      sections: [{ title: "Files", body: "readme", refs: ["it-2"] }],
    });
    const [request] = complete.asked;
    expect(request?.system.startsWith(SUMMARIZER_PROMPT_START)).toBe(true);
    expect(request?.prompt.split("\n")[0]).toBe("[it-1] User: read the readme");
    expect(request?.prompt).toContain('[it-2] Tool call read args={"path":"/alpha/readme.md"}');
    expect(request?.prompt).toContain("…trimmed 2600 chars…");
    expect(request?.prompt).toContain("[it-4] Assistant: It says alpha.");
    expect(request?.maxOutputTokens).toBe(800);
  });

  it("summarizes summaries by their content and sections, tagged with their ids", async () => {
    const complete = replies('{"content": "deeper"}');
    const lower: Summary[] = [1, 2].map((n) => ({
      id: `su-${n}`,
      depth: 1,
      from_seq: n,
      to_seq: n,
      content: `part ${n}`,
      sections: [{ title: "T", body: "B", refs: [`it-${n}`] }],
      tokens: 2,
      through_turn: "s.tu-1",
      created: 0,
    }));
    const out = await createModelSummarizer({ complete }).summarize({
      kind: "summaries",
      summaries: lower,
      depth: 2,
    });
    expect(out).toEqual({ content: "deeper" });
    expect(complete.asked[0]?.prompt).toBe(
      "[su-1] depth=1\npart 1\n## T\nB\nrefs: it-1\n[su-2] depth=1\npart 2\n## T\nB\nrefs: it-2",
    );
  });

  it("asks once more after an empty or malformed reply, then gives up", async () => {
    const twice = replies("not json", '{"content": "second time"}');
    expect(
      await createModelSummarizer({ complete: twice }).summarize({ kind: "items", items: ITEMS }),
    ).toEqual({ content: "second time" });
    expect(twice.asked[1]?.system).toContain("previous response was empty or malformed");
    const never = replies('{"content": ""}', "{}");
    await expect(
      createModelSummarizer({ complete: never }).summarize({ kind: "items", items: ITEMS }),
    ).rejects.toThrow(/EIO/);
  });
});

describe("tool-result trimming", () => {
  it("keeps short outputs, and trims long ones by head and tail, by placeholder, or not at all per tool", () => {
    const policy = createTrimPolicy({
      minChars: 10,
      strategy: { kind: "head-tail", headChars: 2, tailChars: 3 },
      tools: { keepme: { kind: "keep" }, big: { kind: "placeholder" } },
    });
    expect(trimToolResult("short", "read", {}, policy)).toBe("short");
    expect(trimToolResult("abcdefghijklmnop", "read", {}, policy)).toBe(
      "ab\n…trimmed 11 chars…\nnop",
    );
    expect(trimToolResult("abcdefghijklmnop", "keepme", {}, policy)).toBe("abcdefghijklmnop");
    expect(trimToolResult("abcdefghijklmnop", "big", { path: "/a", depth: 1 }, policy)).toBe(
      "[result trimmed: 16 chars; call big with args {path, depth} again to see it]",
    );
  });
});

describe("token estimator", () => {
  it("counts characters per token, or an exact tokenizer, over what an item shows the model", () => {
    const four = createTokenEstimator();
    expect(four.text("12345678")).toBe(2);
    expect(four.item(ITEMS[0] as Item)).toBe(4);
    expect(four.item(ITEMS[1] as Item)).toBe(1 + 7);
    expect(four.item(item(9, { kind: "approval" }))).toBe(0);
    const words = createTokenEstimator({ tokenize: (t) => t.split(/\s+/).filter(Boolean).length });
    expect(words.item(ITEMS[3] as Item)).toBe(3);
  });
});
