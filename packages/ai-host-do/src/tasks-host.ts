// The task queue's host side (statewalker/statewalker-root#206, decision #160): the project queues
// of one workspace, kept by its Workspace DO in its SQLite (ai-tasks' TaskQueue), with the rights
// decided here at every call from the caller's capability and their current roles:
//
// - a person (user capability) is `user:<name>` and answers to `user:<name>`; an agent session is
//   `session:<id>` and answers to `session:<id>` and `agent:<plugin>/<agent>`; it reaches only its
//   own project, and its publishing is an action under the mode (the Workspace DO's `publishMode`);
// - publishing takes `tasks.publish:<subject>`; `hooks.*` and `schedule.*` are the server's own,
//   `agents.<plugin>.<agent>.*` that agent's sessions', and inboxes take only replies;
// - reading a subscription takes `tasks.subscribe` on its filter, and each task read
//   `tasks.subscribe:<its subject>` (a task the reader may not take stays for others); an inbox is
//   its creator's alone; deleting another's subscription or listing every task takes `tasks.admin`;
// - the queue's bytes (waiting tasks and dead letters, inboxes' included) are a storage category
//   (`queue`), admitted before publishing (ENOSPC) and counted after every call.
import { type AgentSessionFacts, codedError, decide, type RoleGrant } from "@statewalker/ai-access";
import type { TasksCall } from "@statewalker/ai-sessions";
import {
  INBOX_PREFIX,
  type QueueReader,
  type SqlLike,
  type Subscription,
  TaskQueue,
  type TaskQueueOptions,
} from "@statewalker/ai-tasks";

/** Subjects only the server publishes: webhooks' and schedules' (#207). */
export const SERVER_PREFIXES = ["hooks.", "schedule."] as const;
/** Subjects an agent's own sessions publish: `agents.<plugin>.<agent>.…`. */
export const AGENT_PREFIX = "agents.";

const DAY = 86_400_000;
const MAX_WAIT_MS = 60_000;

/** The deployment's TASKS setting as queue options; what is not a positive number is ignored. */
export function tasksOptions(text: string | undefined): Omit<TaskQueueOptions, "now" | "newId"> {
  let v: Record<string, unknown> = {};
  try {
    v = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    console.warn("TASKS: not JSON");
  }
  const n = (key: string, scale = 1) => {
    const x = Number(v?.[key]);
    return Number.isFinite(x) && x > 0 ? x * scale : undefined;
  };
  const out: Record<string, number> = {};
  const set = (key: string, value: number | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("maxPayloadBytes", n("max_payload_bytes"));
  set("defaultExpiryMs", n("expiry_days", DAY));
  set("maxExpiryMs", n("max_expiry_days", DAY));
  set("deadLetterMs", n("dead_letter_days", DAY));
  set("maxWaiting", n("max_waiting"));
  return out;
}

/** Who calls: a person, or an agent session (its facts). */
export interface TaskCaller {
  user: string;
  facts?: AgentSessionFacts;
}

export interface TasksHostOptions {
  sql: SqlLike;
  now: () => number;
  options: Omit<TaskQueueOptions, "now" | "newId">;
  /** The caller's membership and roles in a project, now. */
  access(project: string, user: string): Promise<{ member: boolean; grants: RoleGrant[] }>;
  /**
   * An agent session's publishing under its mode: returns when allowed, throws a denial or an
   * approval error (the stored call is `call`).
   */
  publishMode(facts: AgentSessionFacts, subject: string, call: TasksCall): Promise<void>;
  /** Refuses (ENOSPC) adding bytes to a project's storage. */
  admitBytes(project: string, delta: number): Promise<void>;
  /** Counts a change of a project's queue bytes (storage category `queue`). */
  adjustBytes(project: string, user: string, delta: number): Promise<void>;
  /** Asks for an alarm at a time of the queue's clock (undefined: none due). */
  arm(at: number | undefined): Promise<void>;
}

const principalOf = (c: TaskCaller) => (c.facts ? `session:${c.facts.session}` : `user:${c.user}`);

const startsWithAny = (subject: string, prefixes: readonly string[]) =>
  prefixes.some((p) => subject.startsWith(p));

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw codedError("EINVAL", `${what} is required`);
  return v;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export class TasksHost {
  readonly queue: TaskQueue;
  readonly #o: TasksHostOptions;

  constructor(o: TasksHostOptions) {
    this.#o = o;
    this.queue = new TaskQueue(o.sql, { ...o.options, now: o.now });
  }

  /** A caller's rights in a project; ENOENT when it is not theirs to see. */
  async #rights(caller: TaskCaller, project: unknown) {
    const p = str(project, "project");
    // An agent session reaches its own project only.
    if (caller.facts && caller.facts.project !== p) throw codedError("ENOENT", "no such project");
    const access = await this.#o.access(p, caller.user).catch(() => undefined);
    if (!access?.member) throw codedError("ENOENT", "no such project");
    const may = (action: string, target: string) =>
      decide(access.grants, { area: "tasks", action, target });
    return { project: p, may, admin: () => may("admin", ">") };
  }

  #reader(caller: TaskCaller, may: (action: string, target: string) => boolean): QueueReader {
    const id = principalOf(caller);
    return {
      id,
      destinations: caller.facts ? [id, `agent:${caller.facts.agent}`] : [`user:${caller.user}`],
      may: (subject) => may("subscribe", subject) || may("admin", subject),
    };
  }

  /** Publishing rights for a subject, beyond the queue's own checks. */
  #mayPublish(
    caller: TaskCaller,
    subject: unknown,
    may: (action: string, target: string) => boolean,
  ): string {
    const s = str(subject, "subject");
    if (startsWithAny(s, SERVER_PREFIXES))
      throw codedError("EACCES", `'${s}' is published by the server only`);
    if (s.startsWith(INBOX_PREFIX)) throw codedError("EACCES", "an inbox takes only replies");
    if (s.startsWith(AGENT_PREFIX)) {
      const own = caller.facts ? `${AGENT_PREFIX}${caller.facts.agent.replace("/", ".")}.` : "";
      if (!own || !s.startsWith(own))
        throw codedError("EACCES", `'${s}' is published by that agent's sessions only`);
    }
    if (!may("publish", s)) throw codedError("EACCES", `may not publish to '${s}'`);
    return s;
  }

  /** A subscription the caller may read: an inbox its owner's, any other on its filter's rights. */
  #readable(
    caller: TaskCaller,
    project: string,
    name: unknown,
    r: { may: (a: string, t: string) => boolean; admin: () => boolean },
  ): Subscription {
    const sub = this.queue.getSubscription(project, str(name, "subscription"));
    const mine = sub.owner === principalOf(caller);
    if (sub.inbox ? !mine : !(r.may("subscribe", sub.filter.subject) || r.admin()))
      throw codedError("ENOENT", `no subscription '${String(name)}'`);
    return sub;
  }

  /** One call of the task API, with the caller's rights now. */
  async call(caller: TaskCaller, raw: TasksCall): Promise<unknown> {
    const op = raw?.op;
    const args = Array.isArray(raw?.args) ? raw.args : [];
    if (caller.facts?.tool) throw codedError("EACCES", "a tool's capability does not reach tasks");
    // Lease calls name no project: the lease's own, its holder checked by the queue.
    if (op === "ack" || op === "release" || op === "renew") {
      const lease = str(args[0], "lease");
      const project = this.queue.leaseProject(lease);
      if (!project) throw codedError("ENOENT", "no such lease (it may have run out)");
      const holder = principalOf(caller);
      return this.#counted(project, caller.user, () => {
        if (op === "ack") {
          this.queue.ack(lease, holder);
          return { acked: true };
        }
        if (op === "release") {
          const { dead } = this.queue.release(lease, holder, obj(args[1]) as never);
          return { released: true, ...(dead ? { dead: true } : {}) };
        }
        return this.queue.renew(lease, holder, obj(args[1]) as never);
      });
    }
    const r = await this.#rights(caller, args[0]);
    const { project } = r;
    const me = principalOf(caller);
    switch (op) {
      case "publish": {
        const input = obj(args[1]);
        const subject = this.#mayPublish(caller, input.subject, r.may);
        if (caller.facts) await this.#o.publishMode(caller.facts, subject, raw);
        const bytes = new TextEncoder().encode(JSON.stringify(input.payload ?? null)).length;
        await this.#o.admitBytes(project, bytes);
        return this.#counted(project, caller.user, () =>
          this.queue.publish(
            project,
            {
              subject,
              payload: input.payload,
              ...(input.destination !== undefined
                ? { destination: input.destination as string }
                : {}),
              ...(input.expires_at !== undefined ? { expires_at: input.expires_at as number } : {}),
              ...(input.expires_in_ms !== undefined
                ? { expires_in_ms: input.expires_in_ms as number }
                : {}),
              ...(input.reply_to !== undefined ? { reply_to: input.reply_to as string } : {}),
              ...(input.correlation_id !== undefined
                ? { correlation_id: input.correlation_id as string }
                : {}),
            },
            me,
          ),
        );
      }
      case "listTasks":
        if (!r.admin()) throw codedError("EACCES", "listing every task takes tasks.admin");
        return this.#counted(project, caller.user, () => ({
          tasks: this.queue.listTasks(project, obj(args[1])),
        }));
      case "subscribe": {
        const input = obj(args[1]);
        const filter = obj(input.filter);
        if (typeof filter.subject !== "string" || !filter.subject)
          throw codedError("EINVAL", "a subscription filters on a subject");
        if (!r.may("subscribe", filter.subject))
          throw codedError("EACCES", `may not subscribe to '${filter.subject}'`);
        return this.#counted(project, caller.user, () =>
          this.queue.subscribe(project, input as never, me),
        );
      }
      case "listSubscriptions":
        return {
          subscriptions: this.queue
            .listSubscriptions(project)
            .filter((s) => s.owner === me || r.may("subscribe", s.filter.subject) || r.admin()),
        };
      case "getSubscription":
        return this.#readable(caller, project, args[1], r);
      case "unsubscribe": {
        const sub = this.#readable(caller, project, args[1], r);
        if (sub.owner !== me && !r.admin())
          throw codedError("EACCES", "only its owner or tasks.admin deletes a subscription");
        return this.#counted(project, caller.user, () => {
          this.queue.unsubscribe(project, sub.name);
          return { deleted: true };
        });
      }
      case "peek":
      case "take":
      case "claim": {
        const sub = this.#readable(caller, project, args[1], r);
        const reader = this.#reader(caller, r.may);
        const options = obj(args[2]);
        return this.#counted(project, caller.user, () =>
          op === "claim"
            ? { leases: this.queue.claim(project, sub.name, reader, options) }
            : {
                tasks:
                  op === "take"
                    ? this.queue.take(project, sub.name, reader, options)
                    : this.queue.peek(project, sub.name, reader, options),
              },
        );
      }
      case "deadLetters": {
        const sub = this.#readable(caller, project, args[1], r);
        return { dead_letters: this.queue.deadLetters(project, sub.name) };
      }
      case "changes": {
        const sub = this.#readable(caller, project, args[1], r);
        const options = obj(args[2]);
        const after = options.after === undefined ? undefined : Number(options.after);
        const wait = Math.min(Math.max(Number(options.wait_ms ?? 0) || 0, 0), MAX_WAIT_MS);
        return { seq: await this.queue.waitChange(project, after, wait), subscription: sub.name };
      }
      case "createInbox":
        return this.#counted(project, caller.user, () => {
          // An agent session keeps one inbox for all its calls.
          if (caller.facts) {
            const own = this.queue.inboxOf(project, me);
            if (own) return this.queue.getSubscription(project, own.name);
          }
          return this.queue.createInbox(project, me);
        });
      case "reply": {
        const task = str(args[1], "task");
        const target = this.queue.replyTo(project, task, me);
        if (caller.facts) await this.#o.publishMode(caller.facts, target, raw);
        const payload = obj(args[2]).payload;
        await this.#o.admitBytes(
          project,
          new TextEncoder().encode(JSON.stringify(payload ?? null)).length,
        );
        return this.#counted(project, caller.user, () =>
          this.queue.reply(project, task, me, { payload }),
        );
      }
      case "job":
        return this.queue.job(project, str(args[1], "job"), me);
      default:
        throw codedError("EINVAL", `'${String(op)}' is not a task API method`);
    }
  }

  /** Runs a queue call, counting what it changed of the project's queue bytes, then re-arms. */
  async #counted<T>(project: string, user: string, f: () => T): Promise<T> {
    const before = this.queue.bytes(project);
    let out: T;
    try {
      out = f();
    } finally {
      const delta = this.queue.bytes(project) - before;
      if (delta) await this.#o.adjustBytes(project, user, delta);
      await this.#o.arm(this.queue.nextDue());
    }
    return out;
  }

  /** The alarm's work: what is due in every project (expired tasks, lapsed leases, dead letters). */
  async sweepDue(): Promise<void> {
    for (const project of this.queue.dueProjects())
      await this.#counted(project, "", () => this.queue.sweep(project));
    await this.#o.arm(this.queue.nextDue());
  }

  /** Forgets a deleted project's queue. */
  async dropProject(project: string): Promise<void> {
    const before = this.queue.bytes(project);
    this.queue.dropProject(project);
    if (before) await this.#o.adjustBytes(project, "", -before);
  }
}
