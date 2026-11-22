// Compaction over an agent session's two append-only tables (statewalker/statewalker-root#131,
// decided in #83): `items`, the session's flat log, and `summaries`, the summary tree whose rows
// cover item ranges. Driven through AgentSessionCore with a scripted turn runner (which records
// the context each turn is given) and a scripted summarizer.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AgentSessionCore,
  type CompactionOptions,
  type ContextEntry,
  type ItemInput,
  type SqlLike,
  type Summarizer,
  type SummarizerInput,
} from "../src/index.js";

const sqlite = (): SqlLike & { db: DatabaseSync } => {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec: (query, ...bindings) => {
      const statements = query.split(";").filter((s) => s.trim());
      let rows: Record<string, unknown>[] = [];
      for (const s of statements) {
        const st = db.prepare(s);
        if (st.columns().length)
          rows = st.all(...(bindings as never[])) as Record<string, unknown>[];
        else {
          st.run(...(bindings as never[]));
          rows = [];
        }
      }
      return { toArray: () => rows };
    },
  };
};

const CONFIG = {
  id: "s1",
  user: "ann",
  workspace: "default",
  project: "alpha",
  agent: "a",
  capability: "cap",
};

interface Harness {
  core: AgentSessionCore;
  sql: ReturnType<typeof sqlite>;
  /** The context each turn was given, in order. */
  contexts: ContextEntry[][];
  /** What the summarizer was asked. */
  asked: SummarizerInput[];
  /** Sends a message and waits for its turn; the runner emits `reply` items after it. */
  say(content: string, reply?: ItemInput[]): Promise<void>;
}

async function harness(
  options: Partial<CompactionOptions> = {},
  summarizer?: Summarizer,
): Promise<Harness> {
  const sql = sqlite();
  const contexts: ContextEntry[][] = [];
  const asked: SummarizerInput[] = [];
  const replies: ItemInput[][] = [];
  let n = 0;
  const scripted: Summarizer = summarizer ?? {
    async summarize(input) {
      asked.push(input);
      n++;
      return input.kind === "items"
        ? {
            content: `S${n}: ${input.items.map((i) => i.text ?? i.output ?? i.name).join(", ")}`,
            sections: [{ title: "T", body: "B", refs: [input.items[0]?.id ?? ""] }],
          }
        : { content: `S${n}: ${input.summaries.map((s) => s.content).join(" + ")}` };
    },
  };
  const core = new AgentSessionCore({
    sql,
    runTurn: async (turn, emit) => {
      contexts.push(turn.context);
      for (const item of replies.shift() ?? [{ kind: "message", role: "assistant", text: "ok" }])
        emit(item);
      return {};
    },
    runAction: async () => undefined,
    recordApprovals: async () => {},
    compaction: { summarizer: scripted, options },
  });
  await core.start(CONFIG);
  return {
    core,
    sql,
    contexts,
    asked,
    async say(content, reply) {
      replies.push(reply ?? [{ kind: "message", role: "assistant", text: `re ${content}` }]);
      const accepted = await core.send({ content, delivery: "next", ignored: [] });
      await core.waitTurn(accepted.turn_id);
    },
  };
}

/** A context as short strings: `[S<depth>] <content>` for a summary, the item's text otherwise. */
const shape = (context: ContextEntry[]) =>
  context.map((e) =>
    e.type === "summary"
      ? `[S${e.summary.depth}] ${e.summary.content}`
      : String(e.item.text ?? e.item.output ?? e.item.name),
  );

describe("compaction", () => {
  it("gives a turn every earlier item as its context while under the budget", async () => {
    const h = await harness({ budgetTokens: 10_000 });
    await h.say("one");
    await h.say("two");
    await h.say("three");
    expect(shape(h.contexts[0] ?? [])).toEqual([]);
    expect(shape(h.contexts[2] ?? [])).toEqual(["one", "re one", "two", "re two"]);
    expect(h.asked).toEqual([]);
  });

  it("compacts the oldest messages outside the tail into depth-1 summaries once over the budget, keeping every item", async () => {
    const h = await harness({ budgetTokens: 1, tail: { messages: 2 }, groupSize: 2 });
    for (const m of ["one", "two", "three", "four"]) await h.say(m);
    expect(shape(h.contexts[3] ?? [])).toEqual([
      "[S1] S1: one, re one",
      "[S1] S2: two, re two",
      "three",
      "re three",
    ]);
    const { items } = await h.core.items();
    expect(items.map((i) => i.text)).toEqual([
      "one",
      "re one",
      "two",
      "re two",
      "three",
      "re three",
      "four",
      "re four",
    ]);
    const summaries = h.sql.db.prepare("SELECT * FROM summaries ORDER BY from_seq").all();
    expect(summaries).toMatchObject([
      {
        depth: 1,
        from_seq: items[0]?.seq,
        to_seq: items[1]?.seq,
        parent_id: null,
        through_turn: items[1]?.turn,
      },
      {
        depth: 1,
        from_seq: items[2]?.seq,
        to_seq: items[3]?.seq,
        parent_id: null,
        through_turn: items[3]?.turn,
      },
    ]);
    // The summarizer's sections keep their refs: the seed of the session's table of contents.
    expect(JSON.parse(String(summaries[0]?.sections))).toEqual([
      { title: "T", body: "B", refs: [items[0]?.id] },
    ]);
  });

  it("promotes a run of same-depth summaries into a deeper one, which becomes their parent", async () => {
    const h = await harness({
      budgetTokens: 1,
      tail: { messages: 1 },
      groupSize: 1,
      promoteThreshold: 3,
    });
    for (const m of ["a", "b", "c"]) await h.say(m);
    expect(shape(h.contexts[2] ?? [])).toEqual(["[S2] S4: S1: a + S2: re a + S3: b", "re b"]);
    const rows = h.sql.db
      .prepare(
        "SELECT id, depth, from_seq, to_seq, parent_id FROM summaries ORDER BY depth, from_seq",
      )
      .all() as {
      id: string;
      depth: number;
      from_seq: number;
      to_seq: number;
      parent_id: string | null;
    }[];
    const top = rows.find((r) => r.depth === 2);
    expect(
      rows.map((r) => [r.depth, r.parent_id === null ? null : r.parent_id === top?.id]),
    ).toEqual([
      [1, true],
      [1, true],
      [1, true],
      [2, null],
    ]);
    expect([top?.from_seq, top?.to_seq]).toEqual([rows[0]?.from_seq, rows[2]?.to_seq]);
    expect(h.asked.at(-1)).toMatchObject({ kind: "summaries", depth: 2 });
    // Each new summary is in the session's event log.
    const { events } = await h.core.events({ limit: 1000 });
    expect(
      events
        .filter((e) => e.type === "summary.created")
        .map((e) => (e.data as { depth: number }).depth),
    ).toEqual([1, 1, 1, 2]);
  });

  it("sizes the tail by tokens: the newest messages that fit, at least one", async () => {
    // Each "message-N" reply is 3 tokens at 4 characters a token.
    const h = await harness({ budgetTokens: 1, tail: { tokens: 6 }, groupSize: 1 });
    for (const m of ["m-1", "m-2", "m-3"])
      await h.say(m, [{ kind: "message", role: "assistant", text: `reply-${m}` }]);
    // Before the third turn: m-1, reply-m-1, m-2, reply-m-2; the tail is the last two (1 + 3 tokens; one more would be 7).
    expect(shape(h.contexts[2] ?? []).slice(-2)).toEqual(["m-2", "reply-m-2"]);
    expect(
      shape(h.contexts[2] ?? [])
        .slice(0, -2)
        .every((e) => e.startsWith("[S1]")),
    ).toBe(true);
    const big = await harness({ budgetTokens: 1, tail: { tokens: 1 }, groupSize: 1 });
    await big.say("first", [{ kind: "message", role: "assistant", text: "a long reply here" }]);
    await big.say("second");
    expect(shape(big.contexts[1] ?? [])).toEqual(["[S1] S1: first", "a long reply here"]);
  });

  it("trims long tool results outside the tail, never in it, and summarizes nothing when trimming is enough", async () => {
    const long = "x".repeat(5000);
    const call = (id: string): ItemInput[] => [
      { kind: "tool_call", callId: id, name: "read", args: { path: "/alpha/a" } },
      { kind: "tool_result", callId: id, name: "read", output: long, isError: false },
      { kind: "message", role: "assistant", text: "done" },
    ];
    const h = await harness({
      budgetTokens: 1000,
      tail: { messages: 1 },
      trim: {
        minChars: 100,
        strategy: { kind: "head-tail", headChars: 10, tailChars: 10 },
        tools: {},
      },
    });
    await h.say("read it", call("c1"));
    await h.say("again", [{ kind: "message", role: "assistant", text: "ok" }, ...call("c2")]);
    await h.say("third");
    const context = h.contexts[2] ?? [];
    const results = context.flatMap((e) =>
      e.type === "item" && e.item.kind === "tool_result" ? [e] : [],
    );
    // The first result is outside the tail and trimmed; the last segment ("done" after c2) is the
    // tail, and c2's result is in the segment before it, so it is trimmed too.
    expect(results.map((r) => [r.item.callId, r.item.output?.length, r.trimmed])).toEqual([
      ["c1", "x".repeat(10).length * 2 + "\n…trimmed 4980 chars…\n".length, true],
      ["c2", 10 * 2 + "\n…trimmed 4980 chars…\n".length, true],
    ]);
    expect(h.asked).toEqual([]);
    // The items keep the whole output.
    const { items } = await h.core.items({ types: ["tool_result"] });
    expect(items.map((i) => i.output?.length)).toEqual([5000, 5000]);
    // In the tail, a long result is given whole.
    const t = await harness({
      budgetTokens: 100_000,
      tail: { messages: 3 },
      trim: { minChars: 100, strategy: { kind: "placeholder" }, tools: {} },
    });
    await t.say("read it", call("c1"));
    await t.say("next");
    const whole = (t.contexts[1] ?? []).find(
      (e) => e.type === "item" && e.item.kind === "tool_result",
    );
    expect(whole).toMatchObject({ item: { output: long } });
    expect(whole).not.toHaveProperty("trimmed");
  });

  it("never compacts or trims a pinned item: a pinned item, or the latest call of a pinned tool and its result", async () => {
    const long = "y".repeat(3000);
    const h = await harness({
      budgetTokens: 1,
      tail: { messages: 1 },
      groupSize: 6,
      pinTools: ["skills"],
      trim: { minChars: 100, strategy: { kind: "placeholder" }, tools: {} },
    });
    const skills = (id: string): ItemInput[] => [
      { kind: "tool_call", callId: id, name: "skills", args: {} },
      { kind: "tool_result", callId: id, name: "skills", output: `${id} ${long}`, isError: false },
    ];
    await h.say("one");
    await h.say("old skills", skills("k1"));
    await h.say("two");
    await h.say("note", [
      { kind: "message", role: "assistant", text: "remember this", pinned: true },
    ]);
    await h.say("new skills", skills("k2"));
    await h.say("three");
    await h.say("four");
    const context = shape(h.contexts[6] ?? []);
    // The latest skills call and its result stay whole, and so does the pinned message; what lies
    // between them is compacted in runs that stop at each pinned one.
    expect(context.filter((e) => !e.startsWith("[S"))).toEqual([
      "remember this",
      "new skills",
      "skills",
      `k2 ${long}`,
      "re three",
    ]);
    expect(context.find((e) => e.startsWith("[S"))).toContain("old skills");
    expect(context.find((e) => e.startsWith("k1"))).toBeUndefined();
  });

  it("makes at most maxPasses summaries before a turn and reports the context over its budget; the turn still runs", async () => {
    const h = await harness({ budgetTokens: 1, tail: { messages: 1 }, groupSize: 1, maxPasses: 1 });
    await h.say("one");
    await h.say("two");
    await h.say("three");
    // Before the third turn, three messages lie before the tail, one already summarized; one more
    // summary is made, and the context stays over its budget.
    expect(shape(h.contexts[2] ?? [])).toEqual([
      "[S1] S1: one",
      "[S1] S2: re one",
      "two",
      "re two",
    ]);
    const { events } = await h.core.events({ limit: 1000 });
    expect(events.filter((e) => e.type === "context.over_budget").at(-1)?.data).toMatchObject({
      budget: 1,
      estimated: expect.any(Number),
    });
  });

  it("runs the turn on the uncompacted context when the summarizer fails, and says so in the event log", async () => {
    const h = await harness(
      { budgetTokens: 1, tail: { messages: 1 } },
      {
        async summarize() {
          throw new Error("EIO: the model is down");
        },
      },
    );
    await h.say("one");
    await h.say("two");
    expect(shape(h.contexts[1] ?? [])).toEqual(["one", "re one"]);
    const turns = (await h.core.items()).items.map((i) => i.text);
    expect(turns).toEqual(["one", "re one", "two", "re two"]);
    const { events } = await h.core.events({ limit: 1000 });
    expect(events.find((e) => e.type === "compaction.failed")?.data).toEqual({
      message: "EIO: the model is down",
    });
  });

  it("purging the session removes its summaries with its items", async () => {
    const h = await harness({ budgetTokens: 1, tail: { messages: 1 }, groupSize: 1 });
    await h.say("one");
    await h.say("two");
    expect(h.sql.db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toEqual({ n: 1 });
    await h.core.purge();
    expect(h.sql.db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toEqual({ n: 0 });
  });
});
