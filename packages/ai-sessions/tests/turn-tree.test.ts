// The turn tree (statewalker/statewalker-root#190, decided in #159): an agent session's turns form
// a tree with a movable head; the context is the path from the root to the head; rewind moves the
// head (rewound turns stay as an inactive branch), edit and regenerate are a rewind plus a turn,
// and a fork copies a turn and its ancestors into another session. Driven through
// AgentSessionCore with a scripted core that records the context each turn is given.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AgentSessionCore,
  type ApprovalRequest,
  type ContextEntry,
  type Item,
  type SqlLike,
  type Summarizer,
  type TurnRun,
} from "../src/index.js";

const sqlite = (db = new DatabaseSync(":memory:")): SqlLike & { db: DatabaseSync } => ({
  db,
  exec: (query, ...bindings) => {
    const statements = query.split(";").filter((s) => s.trim());
    let rows: Record<string, unknown>[] = [];
    for (const s of statements) {
      const st = db.prepare(s);
      if (st.columns().length) rows = st.all(...(bindings as never[])) as Record<string, unknown>[];
      else {
        st.run(...(bindings as never[]));
        rows = [];
      }
    }
    return { toArray: () => rows };
  },
});

const config = (id = "s1") => ({
  id,
  user: "ann",
  workspace: "default",
  project: "alpha",
  agent: "a",
  capability: "cap",
});

const request = (id: string, path: string): ApprovalRequest =>
  ({
    id,
    session: "s1",
    project: "alpha",
    action: { method: "write", path },
    permission: `files.write:${path}`,
    reason: "the mode asks",
  }) as ApprovalRequest;

/** The user and assistant texts of a context, in order. */
const texts = (context: ContextEntry[]) =>
  context.flatMap((e) =>
    e.type === "item" && e.item.kind === "message" ? [`${e.item.role}:${e.item.text}`] : [],
  );

/**
 * A core whose turns answer "re: <message>"; `HOLD` keeps a turn running until released,
 * `TOOL <name>` calls a tool first (`FAILTOOL`: it fails), `ASK <id>` waits on an approval.
 */
async function harness(
  options: { summarizer?: Summarizer; sql?: ReturnType<typeof sqlite>; id?: string } = {},
) {
  const runs: TurnRun[] = [];
  const cancelled: string[][] = [];
  let release = () => {};
  const sql = options.sql ?? sqlite();
  const core = new AgentSessionCore({
    sql,
    runTurn: async (turn, emit) => {
      runs.push(turn);
      const [command, arg] = turn.content.split(" ");
      if (command === "HOLD")
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          turn.signal.addEventListener("abort", () => reject(turn.signal.reason));
        });
      if (command === "TOOL" || command === "FAILTOOL") {
        emit({ kind: "tool_call", callId: "c1", name: String(arg), args: { x: 1 } });
        emit({
          kind: "tool_result",
          callId: "c1",
          name: String(arg),
          output: command === "TOOL" ? "done" : "refused",
          isError: command === "FAILTOOL",
        });
      }
      if (command === "ASK") {
        const path = `/alpha/${arg}.md`;
        emit({ kind: "tool_call", callId: "c1", name: "write", args: { path } });
        turn.onApproval(request(String(arg), path), { method: "write", path });
        emit({ kind: "tool_result", callId: "c1", output: "waiting", isError: true });
        return {};
      }
      emit({ kind: "message", role: "assistant", text: `re: ${turn.content}` });
      return turn.model ? { model: turn.model } : {};
    },
    runAction: async () => undefined,
    recordApprovals: async (_config, requests) =>
      requests.map((r) => ({ id: r.id, expires: Date.now() + 60_000 })),
    cancelApprovals: async (_config, ids) => {
      cancelled.push(ids);
    },
    effectOf: (item: Item) =>
      item.name === "memory"
        ? "memory"
        : item.name === "db_exec"
          ? "database"
          : item.name === "fetch"
            ? "outside"
            : undefined,
    ...(options.summarizer
      ? {
          compaction: {
            summarizer: options.summarizer,
            options: { budgetTokens: 1, tail: { messages: 1 }, groupSize: 1 },
          },
        }
      : {}),
  });
  // A store from an earlier version already holds its session.
  if (!options.sql) await core.start(config(options.id));
  const say = async (content: string, model?: string) => {
    const accepted = await core.send({
      content,
      delivery: "next",
      ignored: [],
      ...(model ? { model } : {}),
    });
    return core.waitTurn(accepted.turn_id);
  };
  return { core, runs, cancelled, sql, say, release: () => release() };
}

describe("the turn tree", () => {
  it("records each turn's parent and origin, moves the head, and gives the root-to-head path as context", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    expect(a).toMatchObject({ parent_turn: null, origin: "run" });
    expect(b).toMatchObject({ parent_turn: a.id, origin: "run" });
    expect((await h.core.branches()).head).toBe(b.id);
    expect(texts(h.runs[1]?.context ?? [])).toEqual(["user:one", "assistant:re: one"]);
  });

  it("rewinds the head: rewound turns stay as an inactive branch, the next turn is their sibling", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    const result = await h.core.rewind({ to_turn: a.id });
    expect(result).toMatchObject({ head: a.id, previous: b.id, rewound: [b.id] });
    const c = await h.say("three");
    expect(c.parent_turn).toBe(a.id);
    // The rewound turn is still there; the new turn's context leaves it out.
    expect((await h.core.turn(b.id)).status).toBe("completed");
    expect(texts(h.runs[2]?.context ?? [])).toEqual(["user:one", "assistant:re: one"]);
    const tree = await h.core.branches();
    expect(tree.head).toBe(c.id);
    expect(tree.turns.map((t) => [t.id, t.parent_turn, t.active])).toEqual([
      [a.id, null, true],
      [b.id, a.id, false],
      [c.id, a.id, true],
    ]);
    expect(tree.leaves.sort()).toEqual([b.id, c.id].sort());
  });

  it("rewinds before a turn, or before the first turn", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    expect((await h.core.rewind({ before_turn: b.id })).head).toBe(a.id);
    expect((await h.core.rewind({ to_turn: null })).head).toBeNull();
    const c = await h.say("fresh");
    expect(c.parent_turn).toBeNull();
    expect(texts(h.runs[2]?.context ?? [])).toEqual([]);
  });

  it("refuses an unknown turn, or both or neither of to_turn and before_turn", async () => {
    const h = await harness();
    await h.say("one");
    await expect(h.core.rewind({ to_turn: "s1.tu-nope" })).rejects.toThrow(/ENOENT/);
    await expect(h.core.rewind({})).rejects.toThrow(/EINVAL/);
    await expect(h.core.rewind({ to_turn: null, before_turn: "x" })).rejects.toThrow(/EINVAL/);
  });

  it("a running turn blocks a rewind (EBUSY) unless cancel_running, which cancels it and the queued ones", async () => {
    const h = await harness();
    const a = await h.say("one");
    const running = await h.core.send({ content: "HOLD", delivery: "next", ignored: [] });
    const queued = await h.core.send({ content: "later", delivery: "next", ignored: [] });
    while ((await h.core.turn(running.turn_id)).status !== "running")
      await new Promise((r) => setTimeout(r, 1));
    await expect(h.core.rewind({ to_turn: a.id })).rejects.toThrow(/EBUSY/);
    await expect(h.core.setHead(a.id)).rejects.toThrow(/EBUSY/);
    const result = await h.core.rewind({ to_turn: a.id, cancel_running: true });
    expect(result.cancelled_turns.sort()).toEqual([running.turn_id, queued.turn_id].sort());
    expect((await h.core.turn(running.turn_id)).status).toBe("cancelled");
    expect((await h.core.turn(queued.turn_id)).status).toBe("cancelled");
    expect(result.head).toBe(a.id);
    expect(result.rewound).toEqual([running.turn_id]);
  });

  it("lists items on the active path by default, a branch's with `branch`, and every item with `all`", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    await h.core.rewind({ to_turn: a.id });
    const c = await h.say("three");
    const turnsOf = (items: Item[]) => [...new Set(items.map((i) => i.turn))];
    expect(turnsOf((await h.core.items()).items)).toEqual([a.id, c.id]);
    expect(turnsOf((await h.core.items({ branch: b.id })).items)).toEqual([a.id, b.id]);
    expect(turnsOf((await h.core.items({ all: true })).items)).toEqual([a.id, b.id, c.id]);
    await expect(h.core.items({ branch: "s1.tu-nope" })).rejects.toThrow(/EINVAL/);
  });

  it("starts the next turn with an item describing the rewind, and lists the effects it did not revert", async () => {
    const h = await harness();
    const a = await h.say("one");
    const m = await h.say("TOOL memory");
    const d = await h.say("TOOL db_exec");
    // A call that failed changed nothing: not listed.
    const x = await h.say("FAILTOOL db_exec");
    const f = await h.say("TOOL fetch");
    await h.core.childStarted(f.id, "as-child");
    const result = await h.core.rewind({ to_turn: a.id });
    expect(result.rewound).toEqual([m.id, d.id, x.id, f.id]);
    expect(result.memory_writes).toEqual([
      expect.objectContaining({ turn: m.id, name: "memory", args: { x: 1 } }),
    ]);
    expect(result.database_changes).toEqual([
      expect.objectContaining({ turn: d.id, name: "db_exec" }),
    ]);
    expect(result.irreversible_effects).toEqual([
      expect.objectContaining({ turn: f.id, name: "fetch" }),
    ]);
    expect(result.stopped_children).toEqual(["as-child"]);
    const next = await h.say("again");
    expect(next.items[0]).toMatchObject({
      kind: "rewind",
      rewind: { head: a.id, previous: f.id, turns: [m.id, d.id, x.id, f.id] },
    });
    expect(next.items[0]?.text).toMatch(/rewound/);
    expect(next.items[0]?.text).toMatch(/memory/);
    // The model sees it before the user's message.
    const last = h.runs.at(-1)?.context ?? [];
    expect(last.at(-1)).toMatchObject({ type: "item", item: { kind: "rewind" } });
    // Only once.
    const after = await h.say("more");
    expect(after.items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("cancels the pending approvals of rewound turns: their answers are refused", async () => {
    const h = await harness();
    const a = await h.say("one");
    const w = await h.say("ASK ap-1");
    expect(w.status).toBe("waiting");
    expect(h.core.nextExpiry()).toBeDefined();
    const result = await h.core.rewind({ to_turn: a.id });
    expect(result.cancelled_approvals).toEqual(["ap-1"]);
    expect(h.cancelled).toEqual([["ap-1"]]);
    expect(h.core.nextExpiry()).toBeUndefined();
    await expect(h.core.answer("ap-1", { decision: "allow", scope: "once" })).rejects.toThrow(
      /EINVAL/,
    );
    expect(await h.core.status()).toBe("idle");
  });

  it("logs session.rewound and session.head_changed", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    const { offset } = await h.core.events();
    await h.core.rewind({ to_turn: a.id });
    await h.core.setHead(b.id);
    const { events } = await h.core.events({ since: offset });
    expect(events.map((e) => [e.type, (e.data as { head?: string }).head])).toEqual([
      ["session.rewound", a.id],
      ["session.head_changed", a.id],
      ["session.head_changed", b.id],
    ]);
  });

  it("switches branch with setHead, which never runs anything", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    await h.core.rewind({ to_turn: a.id });
    const c = await h.say("three");
    const result = await h.core.setHead(b.id);
    expect(result).toMatchObject({ head: b.id, previous: c.id, rewound: [c.id] });
    const d = await h.say("four");
    expect(d.parent_turn).toBe(b.id);
    expect(texts(h.runs.at(-1)?.context ?? []).slice(0, 4)).toEqual([
      "user:one",
      "assistant:re: one",
      "user:two",
      "assistant:re: two",
    ]);
  });

  it("edit and regenerate are a rewind plus a turn: sibling turns", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    const edited = await h.core.edit(b.id, { content: "two, edited" });
    expect(edited.rewind).toMatchObject({ head: a.id, rewound: [b.id] });
    const e = await h.core.waitTurn(edited.turn_id);
    expect(e).toMatchObject({ parent_turn: a.id });
    expect(e.items.find((i) => i.kind === "message")?.text).toBe("two, edited");
    const again = await h.core.regenerate(e.id, { model: "other/model" });
    const r = await h.core.waitTurn(again.turn_id);
    expect(r).toMatchObject({ parent_turn: a.id, model: "other/model" });
    expect(r.items.find((i) => i.kind === "message" && i.role === "user")?.text).toBe(
      "two, edited",
    );
    const tree = await h.core.branches();
    expect(tree.turns.filter((t) => t.parent_turn === a.id).map((t) => t.id)).toEqual([
      b.id,
      e.id,
      r.id,
    ]);
  });

  it("erases an inactive branch, never the active path", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    const b2 = await h.say("three");
    await h.core.rewind({ to_turn: a.id });
    const c = await h.say("other");
    await expect(h.core.eraseBranch(a.id)).rejects.toThrow(/EINVAL/);
    await expect(h.core.eraseBranch(c.id)).rejects.toThrow(/EINVAL/);
    expect((await h.core.eraseBranch(b.id)).erased).toEqual([b.id, b2.id]);
    await expect(h.core.turn(b2.id)).rejects.toThrow(/ENOENT/);
    expect((await h.core.items({ all: true })).items.map((i) => i.turn)).not.toContain(b.id);
    expect((await h.core.branches()).turns.map((t) => t.id)).toEqual([a.id, c.id]);
  });

  it("reports the session's status from its head", async () => {
    const h = await harness();
    const a = await h.say("one");
    await h.say("ASK ap-2");
    expect(await h.core.status()).toBe("waiting");
    await h.core.rewind({ to_turn: a.id });
    expect(await h.core.status()).toBe("idle");
  });

  it("uses a summary only when the turn it runs through is on the active path", async () => {
    const summarizer: Summarizer = {
      summarize: async (input) => ({
        content: `SUM(${input.kind === "items" ? input.items.map((i) => i.text ?? "").join("|") : "deeper"})`,
      }),
    };
    const h = await harness({ summarizer });
    const a = await h.say("one");
    await h.say("two");
    await h.say("three");
    const summarized = (context: ContextEntry[]) =>
      context.flatMap((e) => (e.type === "summary" ? [e.summary.content] : []));
    expect(summarized(h.runs[2]?.context ?? []).join(" ")).toContain("two");
    await h.core.rewind({ to_turn: a.id });
    await h.say("four");
    // No summary drawn from the rewound turns reaches the new branch's context.
    const context = h.runs.at(-1)?.context ?? [];
    expect(summarized(context).join(" ")).not.toContain("two");
    expect(JSON.stringify(context)).not.toContain("three");
  });
});

describe("forks", () => {
  it("exports a turn and its ancestors from any branch, and imports them with new ids as copied turns", async () => {
    const h = await harness();
    const a = await h.say("one");
    const b = await h.say("two");
    await h.core.rewind({ to_turn: a.id });
    await h.say("three");
    const history = await h.core.exportPath(b.id);
    expect(history.turns.map((t) => t.id)).toEqual([a.id, b.id]);
    const fork = await harness({ id: "s2" });
    const { head } = await fork.core.importHistory(history);
    const tree = await fork.core.branches();
    expect(tree.head).toBe(head);
    expect(tree.turns).toHaveLength(2);
    const [ca, cb] = await Promise.all(tree.turns.map((t) => fork.core.turn(t.id)));
    expect(ca).toMatchObject({ origin: "copied", copied_from: { session: "s1", turn: a.id } });
    expect(cb).toMatchObject({
      parent_turn: ca?.id,
      origin: "copied",
      copied_from: { session: "s1", turn: b.id },
    });
    expect(ca?.id.startsWith("s2.tu-")).toBe(true);
    expect(cb?.items.map((i) => i.text)).toEqual(["two", "re: two"]);
    expect(cb?.items.every((i) => !(history.items as { id: string }[]).some((x) => x.id === i.id)));
    // The next turn continues from the copy.
    const next = await fork.say("four");
    expect(next.parent_turn).toBe(cb?.id);
    expect(texts(fork.runs[0]?.context ?? [])).toEqual([
      "user:one",
      "assistant:re: one",
      "user:two",
      "assistant:re: two",
    ]);
  });

  it("refuses to export a running turn (EBUSY) or a turn not in the tree (ENOENT)", async () => {
    const h = await harness();
    await h.say("one");
    const running = await h.core.send({ content: "HOLD", delivery: "next", ignored: [] });
    while ((await h.core.turn(running.turn_id)).status !== "running")
      await new Promise((r) => setTimeout(r, 1));
    await expect(h.core.exportPath(running.turn_id)).rejects.toThrow(/EBUSY/);
    await expect(h.core.exportPath("s1.tu-nope")).rejects.toThrow(/ENOENT/);
    h.release();
    await h.core.waitTurn(running.turn_id);
  });

  it("a fork copies no pending approval: it is not waiting, and nothing of the parent's is answered there", async () => {
    const h = await harness();
    const w = await h.say("ASK ap-3");
    const fork = await harness({ id: "s2" });
    await fork.core.importHistory(await h.core.exportPath(w.id));
    expect(await fork.core.status()).toBe("idle");
    expect(fork.core.nextExpiry()).toBeUndefined();
    await expect(fork.core.answer("ap-3", { decision: "allow", scope: "once" })).rejects.toThrow();
  });

  it("refuses to import into a session that already has turns", async () => {
    const h = await harness();
    const a = await h.say("one");
    await expect(h.core.importHistory(await h.core.exportPath(a.id))).rejects.toThrow(/EINVAL/);
  });
});

describe("storage migration", () => {
  it("gives turns stored before the tree their previous turn as parent and origin run, and the last as head", async () => {
    const sql = sqlite();
    sql.exec(`CREATE TABLE agent_config (key TEXT PRIMARY KEY, value TEXT)`);
    sql.exec(`CREATE TABLE agent_turns (id TEXT PRIMARY KEY, status TEXT NOT NULL,
        delivery TEXT NOT NULL, content TEXT NOT NULL, model_requested TEXT, pos INTEGER NOT NULL,
        stop_reason TEXT, error TEXT, model TEXT, ignored TEXT NOT NULL, created INTEGER NOT NULL,
        started INTEGER, ended INTEGER)`);
    sql.exec(`CREATE TABLE items (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        turn TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE summaries (id TEXT PRIMARY KEY, depth INTEGER NOT NULL,
        from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, parent_id TEXT, content TEXT NOT NULL,
        sections TEXT, tokens INTEGER NOT NULL, through_turn TEXT NOT NULL, created INTEGER NOT NULL)`);
    sql.exec("INSERT INTO agent_config VALUES ('config', ?)", JSON.stringify(config()));
    const turn = (id: string, created: number, started: number | null, status = "completed") =>
      sql.exec(
        "INSERT INTO agent_turns VALUES (?, ?, 'next', 'x', NULL, 1, NULL, NULL, NULL, '[]', ?, ?, ?)",
        id,
        status,
        created,
        started,
        started,
      );
    turn("s1.tu-1", 1, 1);
    turn("s1.tu-2", 2, null, "cancelled");
    turn("s1.tu-3", 3, 3);
    sql.exec(
      `INSERT INTO items (id, turn, kind, body) VALUES ('it-1', 's1.tu-1', 'message', '{}')`,
    );
    sql.exec(
      `INSERT INTO items (id, turn, kind, body) VALUES ('it-2', 's1.tu-3', 'message', '{}')`,
    );
    sql.exec(`INSERT INTO summaries VALUES ('su-1', 1, 1, 2, NULL, 'c', NULL, 1, '', 0)`);
    const h = await harness({ sql });
    expect(await h.core.turn("s1.tu-1")).toMatchObject({ parent_turn: null, origin: "run" });
    expect(await h.core.turn("s1.tu-3")).toMatchObject({ parent_turn: "s1.tu-1", origin: "run" });
    expect((await h.core.branches()).head).toBe("s1.tu-3");
    expect(sql.exec("SELECT through_turn FROM summaries").toArray()).toEqual([
      { through_turn: "s1.tu-3" },
    ]);
  });
});
