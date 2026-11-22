// The runner serving a subscription with an executor, over the in-process API of a queue.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  type Executor,
  queueApi,
  type SqlLike,
  serveSubscription,
  TaskQueue,
} from "../src/index.js";

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
};

const P = "alpha";

describe("serveSubscription", () => {
  it("runs each task, logs its progress and replies with a reference to the job log", async () => {
    const queue = new TaskQueue(sqlite());
    const ann = queueApi(queue, { id: "user:ann", destinations: ["user:ann"] });
    const worker = queueApi(queue, { id: "user:worker", destinations: [] });
    await worker.subscribe(P, { name: "sums", filter: { subject: "calls.sum" } });
    const inbox = await ann.createInbox(P);
    await ann.publish(P, {
      subject: "calls.sum",
      payload: [1, 2, 3],
      reply_to: inbox.name,
      correlation_id: "c1",
    });
    await ann.publish(P, { subject: "calls.sum", payload: "not numbers" });
    const ran: unknown[] = [];
    const executor: Executor = {
      async run(lease, { progress, signal }) {
        expect(signal.aborted).toBe(false);
        ran.push(lease.task.payload);
        if (!Array.isArray(lease.task.payload)) throw new Error("not a list");
        await progress({ adding: lease.task.payload.length });
        return (lease.task.payload as number[]).reduce((a, b) => a + b, 0);
      },
    };
    const stop = new AbortController();
    const served = serveSubscription(worker, {
      project: P,
      subscription: "sums",
      executor,
      signal: stop.signal,
      waitMs: 20,
    });
    let replies: Awaited<ReturnType<typeof ann.take>>["tasks"] = [];
    for (let i = 0; i < 200 && !replies.length; i++) {
      replies = (await ann.take(P, inbox.name)).tasks;
      if (!replies.length) await new Promise((r) => setTimeout(r, 5));
    }
    expect(replies).toHaveLength(1);
    const reply = replies[0]?.payload as { job: string; result: number };
    expect(reply.result).toBe(6);
    expect(replies[0]?.correlation_id).toBe("c1");
    const job = await ann.job(P, reply.job);
    expect(job.entries.map((e) => e.progress)).toEqual([{ adding: 3 }]);
    // The failing task is released each time, then dead-lettered after 3 attempts.
    for (let i = 0; i < 200; i++) {
      if ((await worker.deadLetters(P, "sums")).dead_letters.length) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await worker.deadLetters(P, "sums")).dead_letters).toMatchObject([
      { attempts: 3, reason: "not a list" },
    ]);
    stop.abort();
    await served;
    expect(ran.filter((p) => p === "not numbers")).toHaveLength(3);
  });
});
