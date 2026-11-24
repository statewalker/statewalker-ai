/// <reference types="node" />
// A Workspace DO's task queue written by @statewalker/ai-tasks 0.1.0 opens through
// @statewalker/shared-tasks with its tasks, subscriptions, leases and job logs
// (statewalker/statewalker-root#406). The host opens the queue in one place: `TasksHost`, over the
// DO's SQL (`ctx.storage.sql`), so the test gives it a database loaded from the fixture.
//
// The fixture is an SQL dump of a store the published ai-tasks 0.1.0 created (copied from
// statewalker-shared's shared-tasks tests): project `alpha`, subscription `work` on `jobs.*` owned
// by `user:ann`, task id1 leased as id3 with one progress entry, and task id2 waiting.
//
// Rolling back to ai-tasks is not supported once shared-tasks has written to a store.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveRoles } from "@statewalker/ai-access";
import type { SqlLike } from "@statewalker/shared-tasks";
import { describe, expect, it } from "vitest";
import { type TaskCaller, TasksHost } from "../src/tasks-host.js";

const P = "alpha";
const ann: TaskCaller = { user: "ann" };

function aiTasksStore(): { sql: SqlLike; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const fixture = fileURLToPath(new URL("./fixtures/ai-tasks-0.1.0.sql", import.meta.url).href);
  db.exec(readFileSync(fixture, "utf8"));
  const sql: SqlLike = {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
  return { sql, db };
}

function host(sql: SqlLike) {
  const owner = resolveRoles(["owner"], {}).grants;
  return new TasksHost({
    sql,
    // Within the fixture's lease (it runs out at 1,300,000).
    now: () => 1_001_000,
    options: {},
    access: async (project, user) => ({
      member: project === P && user === "ann",
      grants: owner,
    }),
    publishMode: async () => {},
    admitBytes: async () => {},
    adjustBytes: async () => {},
    arm: async () => {},
  });
}

describe("a Workspace DO's queue written by ai-tasks 0.1.0", () => {
  it("opens through shared-tasks with its tasks, subscriptions, leases and job logs", async () => {
    const tasks = host(aiTasksStore().sql);
    const call = (op: string, ...args: unknown[]) => tasks.call(ann, { op, args } as never);

    expect(await call("listSubscriptions", P)).toMatchObject({
      subscriptions: [{ name: "work", filter: { subject: "jobs.*" }, owner: "user:ann" }],
    });
    expect(await call("listTasks", P)).toMatchObject({
      tasks: [
        { id: "id1", subject: "jobs.a", payload: { n: 1 }, sender: "user:ann" },
        { id: "id2", subject: "jobs.b", payload: { n: 2 }, sender: "user:ann" },
      ],
    });
    expect(await call("job", P, "id3")).toMatchObject({
      entries: [{ at: 1_000_000, progress: { step: 1 } }],
    });

    // The lease taken under ai-tasks is still its holder's to renew and ack.
    await call("renew", "id3", { progress: { step: 2 } });
    expect(await call("ack", "id3")).toEqual({ acked: true });

    // The waiting task is claimed and settled as any other.
    const { leases } = (await call("claim", P, "work")) as {
      leases: { id: string; task: { id: string; payload: unknown } }[];
    };
    expect(leases.map((l) => [l.task.id, l.task.payload])).toEqual([["id2", { n: 2 }]]);
    await call("ack", leases[0]?.id);
    expect(await call("listTasks", P)).toEqual({ tasks: [] });

    // And new tasks go into the same store.
    await call("publish", P, { subject: "jobs.c", payload: { n: 3 } });
    expect(await call("peek", P, "work")).toMatchObject({ tasks: [{ subject: "jobs.c" }] });
  });

  it("keeps the store's table layout as it was", () => {
    const { sql, db } = aiTasksStore();
    const schema = () =>
      db
        .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
    const before = schema();
    host(sql);
    expect(schema()).toEqual(before);
  });
});
