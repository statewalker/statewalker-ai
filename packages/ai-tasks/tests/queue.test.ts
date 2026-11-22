// The queue at its package interface, with an injected clock: leases and expiry are time.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type QueueReader, type SqlLike, TaskQueue, type TaskQueueOptions } from "../src/index.js";

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
};

const MIN = 60_000;
const DAY = 86_400_000;

function setup(options: Partial<TaskQueueOptions> = {}) {
  let now = 1_000_000;
  let n = 0;
  const queue = new TaskQueue(sqlite(), {
    now: () => now,
    newId: () => `id${++n}`,
    ...options,
  });
  return {
    queue,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const ann: QueueReader = { id: "user:ann", destinations: ["user:ann"] };
const bob: QueueReader = { id: "user:bob", destinations: ["user:bob"] };
const P = "alpha";

describe("task queue", () => {
  it("stamps the sender and refuses payloads over the cap", () => {
    const { queue } = setup({ maxPayloadBytes: 32 });
    const task = queue.publish(P, { subject: "orders.created", payload: { n: 1 } }, "user:ann");
    expect(task).toMatchObject({
      subject: "orders.created",
      sender: "user:ann",
      payload: { n: 1 },
    });
    expect(() =>
      queue.publish(P, { subject: "orders.created", payload: "x".repeat(40) }, "user:ann"),
    ).toThrow(/^EINVAL: .*32 bytes/);
    expect(() => queue.publish(P, { subject: "orders.*" }, "user:ann")).toThrow(/^EINVAL/);
  });

  it("gives every matching subscription each task, taken once in each", () => {
    const { queue } = setup();
    queue.subscribe(P, { name: "billing", filter: { subject: "orders.>" } }, "user:ann");
    queue.subscribe(P, { name: "audit", filter: { subject: "*.created" } }, "user:ann");
    queue.subscribe(P, { name: "other", filter: { subject: "users.>" } }, "user:ann");
    const task = queue.publish(P, { subject: "orders.created" }, "user:ann");
    expect(queue.peek(P, "billing", ann).map((t) => t.id)).toEqual([task.id]);
    expect(queue.peek(P, "other", ann)).toEqual([]);
    expect(queue.take(P, "billing", ann).map((t) => t.id)).toEqual([task.id]);
    expect(queue.take(P, "billing", bob)).toEqual([]);
    // Still waiting for audit, so it stays.
    expect(queue.listTasks(P).map((t) => t.id)).toEqual([task.id]);
    expect(queue.take(P, "audit", bob).map((t) => t.id)).toEqual([task.id]);
    expect(queue.listTasks(P)).toEqual([]);
  });

  it("keeps a task no subscription matches until one does", () => {
    const { queue } = setup();
    const task = queue.publish(P, { subject: "late.news" }, "user:ann");
    expect(queue.listTasks(P).map((t) => t.id)).toEqual([task.id]);
    queue.subscribe(P, { name: "late", filter: { subject: "late.*" } }, "user:bob");
    expect(queue.take(P, "late", bob).map((t) => t.id)).toEqual([task.id]);
    expect(queue.listTasks(P)).toEqual([]);
  });

  it("filters on destination and sender, and a destination narrows who may take", () => {
    const { queue } = setup();
    queue.subscribe(P, { name: "all", filter: { subject: ">" } }, "user:ann");
    queue.subscribe(
      P,
      { name: "from-bob", filter: { subject: ">", sender: "user:b*" } },
      "user:ann",
    );
    const forBob = queue.publish(P, { subject: "a.b", destination: "user:bob" }, "user:ann");
    const fromBob = queue.publish(P, { subject: "a.c" }, "user:bob");
    expect(queue.peek(P, "from-bob", ann).map((t) => t.id)).toEqual([fromBob.id]);
    // Ann does not answer to user:bob: the task stays for him.
    expect(queue.take(P, "all", ann).map((t) => t.id)).toEqual([fromBob.id]);
    expect(queue.take(P, "all", bob).map((t) => t.id)).toEqual([forBob.id]);
  });

  it("leaves tasks the reader may not take for others", () => {
    const { queue } = setup();
    queue.subscribe(P, { name: "all", filter: { subject: ">" } }, "user:ann");
    queue.publish(P, { subject: "hooks.gh.push" }, "server:gh");
    const plain = queue.publish(P, { subject: "plain.one" }, "user:ann");
    const limited: QueueReader = { ...bob, may: (s) => !s.startsWith("hooks.") };
    expect(queue.take(P, "all", limited).map((t) => t.id)).toEqual([plain.id]);
    expect(queue.peek(P, "all", ann).map((t) => t.subject)).toEqual(["hooks.gh.push"]);
  });

  it("claims with a lease once, even with parallel claimers", async () => {
    const { queue } = setup();
    queue.subscribe(P, { name: "work", filter: { subject: "jobs.*" } }, "user:ann");
    for (let i = 0; i < 5; i++) queue.publish(P, { subject: "jobs.x", payload: i }, "user:ann");
    const claimers = Array.from({ length: 8 }, (_, i) => ({
      id: `user:c${i}`,
      destinations: [],
    }));
    const results = await Promise.all(
      claimers.map(async (c) => queue.claim(P, "work", c, { limit: 2 })),
    );
    const ids = results.flat().map((l) => l.task.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(results.flat()[0]).toMatchObject({ attempt: 1, max_attempts: 3, subscription: "work" });
  });

  it("acks, releases and renews a lease; only its holder may", () => {
    const { queue, advance, now } = setup();
    queue.subscribe(P, { name: "work", filter: { subject: "jobs.*" } }, "user:ann");
    const task = queue.publish(P, { subject: "jobs.x" }, "user:ann");
    const [lease] = queue.claim(P, "work", ann);
    expect(lease?.expires).toBe(now() + 5 * MIN);
    expect(queue.peek(P, "work", bob)).toEqual([]);
    expect(() => queue.ack(String(lease?.id), "user:bob")).toThrow(/^ENOENT/);
    advance(MIN);
    const renewed = queue.renew(String(lease?.id), "user:ann", { lease_ms: 2 * MIN });
    expect(renewed.expires).toBe(now() + 2 * MIN);
    expect(queue.release(String(lease?.id), "user:ann")).toEqual({ dead: false });
    const [again] = queue.claim(P, "work", bob);
    expect(again).toMatchObject({ attempt: 2, task: { id: task.id } });
    queue.ack(String(again?.id), "user:bob");
    expect(queue.listTasks(P)).toEqual([]);
    expect(() => queue.ack(String(again?.id), "user:bob")).toThrow(/^ENOENT/);
  });

  it("returns a task whose lease ran out, and dead-letters it after max_attempts", () => {
    const { queue, advance } = setup();
    queue.subscribe(
      P,
      { name: "work", filter: { subject: "jobs.*" }, lease_ms: MIN, max_attempts: 2 },
      "user:ann",
    );
    const task = queue.publish(P, { subject: "jobs.x" }, "user:ann");
    const [first] = queue.claim(P, "work", ann);
    advance(MIN + 1);
    expect(() => queue.renew(String(first?.id), "user:ann")).toThrow(/^ENOENT/);
    const [second] = queue.claim(P, "work", ann);
    expect(second).toMatchObject({ attempt: 2, task: { id: task.id } });
    expect(queue.release(String(second?.id), "user:ann", { reason: "boom" })).toEqual({
      dead: true,
    });
    expect(queue.claim(P, "work", ann)).toEqual([]);
    const dead = queue.deadLetters(P, "work");
    expect(dead).toMatchObject([{ task: { id: task.id }, attempts: 2, reason: "boom" }]);
    expect(queue.getSubscription(P, "work").counts).toMatchObject({ dead_letters: 1, waiting: 0 });
    expect(queue.listTasks(P)).toEqual([]);
    advance(14 * DAY);
    expect(queue.deadLetters(P, "work")).toEqual([]);
  });

  it("expires tasks (7 days by default, 30 at most), counted per subscription", () => {
    const { queue, advance, now } = setup();
    queue.subscribe(P, { name: "slow", filter: { subject: "x.*" } }, "user:ann");
    const t = queue.publish(P, { subject: "x.a" }, "user:ann");
    expect(t.expires_at).toBe(now() + 7 * DAY);
    const long = queue.publish(P, { subject: "y.a", expires_in_ms: 90 * DAY }, "user:ann");
    expect(long.expires_at).toBe(now() + 30 * DAY);
    advance(7 * DAY);
    expect(queue.peek(P, "slow", ann)).toEqual([]);
    expect(queue.getSubscription(P, "slow").counts).toMatchObject({ expired: 1, waiting: 0 });
    expect(queue.listTasks(P).map((x) => x.id)).toEqual([long.id]);
    expect(queue.nextDue()).toBe(long.expires_at);
  });

  it("caps the waiting tasks of a project", () => {
    const { queue } = setup({ maxWaiting: 2 });
    queue.publish(P, { subject: "a.b" }, "user:ann");
    queue.publish(P, { subject: "a.b" }, "user:ann");
    expect(() => queue.publish(P, { subject: "a.b" }, "user:ann")).toThrow(/^ELIMIT/);
    queue.publish("beta", { subject: "a.b" }, "user:ann");
  });

  it("replies only from a consumer that took or claimed the task, into the sender's inbox", () => {
    const { queue } = setup();
    queue.subscribe(P, { name: "calls", filter: { subject: "calls.*" } }, "user:bob");
    const inbox = queue.createInbox(P, "user:ann");
    expect(inbox).toMatchObject({ inbox: true, owner: "user:ann" });
    expect(inbox.name).toMatch(/^_inbox\./);
    // Only the sender's own inbox.
    expect(() =>
      queue.publish(P, { subject: "calls.sum", reply_to: inbox.name }, "user:bob"),
    ).toThrow(/^EACCES/);
    expect(() => queue.publish(P, { subject: inbox.name }, "user:ann")).toThrow(/^EACCES/);
    const call = queue.publish(
      P,
      { subject: "calls.sum", payload: [1, 2], reply_to: inbox.name, correlation_id: "c-1" },
      "user:ann",
    );
    expect(() => queue.reply(P, call.id, "user:bob", { payload: 3 })).toThrow(/^EACCES/);
    const [lease] = queue.claim(P, "calls", bob);
    queue.renew(String(lease?.id), "user:bob", { progress: { step: "adding" } });
    const reply = queue.reply(P, call.id, "user:bob", { payload: { sum: 3, job: lease?.id } });
    expect(reply).toMatchObject({ subject: inbox.name, sender: "user:bob", correlation_id: "c-1" });
    expect(() => queue.reply(P, call.id, "user:bob", { payload: 4 })).toThrow(/^EBUSY/);
    queue.ack(String(lease?.id), "user:bob");
    // The inbox is its creator's alone, and no wildcard filter sees it.
    expect(() => queue.peek(P, inbox.name, bob)).toThrow(/^ENOENT/);
    expect(queue.take(P, inbox.name, ann).map((t) => t.payload)).toEqual([
      { sum: 3, job: lease?.id },
    ]);
    // The job log: the holder and the sender read it.
    expect(queue.job(P, String(lease?.id), "user:ann")).toMatchObject({
      task: call.id,
      entries: [{ progress: { step: "adding" } }],
    });
    expect(() => queue.job(P, String(lease?.id), "user:eve")).toThrow(/^ENOENT/);
  });
});
