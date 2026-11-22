// The task queue over SQLite (statewalker/statewalker-root#160, built by #206): every project's
// tasks, subscriptions, deliveries, leases, dead letters and job logs in one database (a Workspace
// DO's), every call synchronous, so a task is taken once in a subscription even when claimers race.
//
// A delivery is one task waiting for one matching subscription: made when the task is published
// (for the subscriptions there) and when a subscription is created (for the tasks still waiting).
// Taking or acking a task ends its delivery; a task is removed once it had a matching subscription
// and none still waits for it, or when it expires. Time comes from `now`, so tests move it.
//
// New tables only (task_*): rolling back leaves them unused.
import { INBOX_PREFIX, isInbox, isPattern, isSubject, subjectMatches } from "./subjects.js";
import type {
  DeadLetter,
  JobLog,
  Lease,
  Subscription,
  SubscriptionCounts,
  SubscriptionInput,
  Task,
  TaskInput,
} from "./types.js";

/** What the queue needs of SQLite: Durable Objects' `SqlStorage` has this shape. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface TaskQueueOptions {
  now?: () => number;
  newId?: () => string;
  /** A payload's cap, as JSON in UTF-8: 64 KB. */
  maxPayloadBytes?: number;
  /** A task's life when the publisher names none: 7 days. */
  defaultExpiryMs?: number;
  /** The longest life a task may ask for: 30 days. */
  maxExpiryMs?: number;
  /** How long dead letters are kept: 14 days. */
  deadLetterMs?: number;
  /** Tasks a project holds at most (inboxes' included): 10,000. */
  maxWaiting?: number;
  /** A claim's lease when neither the claim nor the subscription names one: 5 minutes. */
  defaultLeaseMs?: number;
  defaultMaxAttempts?: number;
}

/**
 * Who reads: `id` is the principal leases and replies are held by, `destinations` the
 * destinations it answers to, and `may` whether it may take a task of a subject now (the host's
 * rights, checked for every task: one it may not take stays for others).
 */
export interface QueueReader {
  id: string;
  destinations: readonly string[];
  may?: (subject: string) => boolean;
}

export const DEFAULTS = {
  maxPayloadBytes: 64 * 1024,
  defaultExpiryMs: 7 * 86_400_000,
  maxExpiryMs: 30 * 86_400_000,
  deadLetterMs: 14 * 86_400_000,
  maxWaiting: 10_000,
  defaultLeaseMs: 5 * 60_000,
  defaultMaxAttempts: 3,
} as const;

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 12 * 3_600_000;
const MAX_ATTEMPTS = 100;
const MAX_READ = 100;
const DEFAULT_READ = 10;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DESTINATION = /^[a-z]+:[^\s]{1,256}$/;
const CORRELATION = /^[^\s]{1,128}$/;
const MAX_SENDER_FILTER = 256;

/** An error whose message starts with its code, as the harness's errors do. */
export function taskError(code: string, message: string): Error & { code: string } {
  const e = new Error(`${code}: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

const utf8 = new TextEncoder();

function globMatches(pattern: string, text: string): boolean {
  const re = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${re}$`).test(text);
}

interface TaskRow {
  seq: number;
  project: string;
  id: string;
  subject: string;
  destination: string | null;
  sender: string;
  payload: string;
  bytes: number;
  created: number;
  expires_at: number;
  reply_to: string | null;
  correlation_id: string | null;
}

interface SubRow {
  project: string;
  name: string;
  subject: string;
  destination: string | null;
  sender: string | null;
  lease_ms: number;
  max_attempts: number;
  owner: string;
  created: number;
  inbox: number;
  expired: number;
}

function taskOf(r: TaskRow): Task {
  return {
    id: r.id,
    subject: r.subject,
    ...(r.destination ? { destination: r.destination } : {}),
    sender: r.sender,
    payload: JSON.parse(r.payload),
    created: Number(r.created),
    expires_at: Number(r.expires_at),
    ...(r.reply_to ? { reply_to: r.reply_to } : {}),
    ...(r.correlation_id ? { correlation_id: r.correlation_id } : {}),
  };
}

function subscriptionOf(r: SubRow, counts?: SubscriptionCounts): Subscription {
  return {
    name: r.name,
    filter: {
      subject: r.subject,
      ...(r.destination ? { destination: r.destination } : {}),
      ...(r.sender ? { sender: r.sender } : {}),
    },
    lease_ms: Number(r.lease_ms),
    max_attempts: Number(r.max_attempts),
    owner: r.owner,
    created: Number(r.created),
    ...(r.inbox ? { inbox: true as const } : {}),
    ...(counts ? { counts } : {}),
  };
}

function matches(sub: SubRow, task: Pick<TaskRow, "subject" | "destination" | "sender">): boolean {
  if (!subjectMatches(sub.subject, task.subject)) return false;
  if (sub.destination && sub.destination !== task.destination) return false;
  if (sub.sender && !globMatches(sub.sender, task.sender)) return false;
  return true;
}

export class TaskQueue {
  readonly #sql: SqlLike;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #o: Required<Omit<TaskQueueOptions, "now" | "newId">>;

  constructor(sql: SqlLike, options: TaskQueueOptions = {}) {
    this.#sql = sql;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#o = {
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes,
      defaultExpiryMs: options.defaultExpiryMs ?? DEFAULTS.defaultExpiryMs,
      maxExpiryMs: options.maxExpiryMs ?? DEFAULTS.maxExpiryMs,
      deadLetterMs: options.deadLetterMs ?? DEFAULTS.deadLetterMs,
      maxWaiting: options.maxWaiting ?? DEFAULTS.maxWaiting,
      defaultLeaseMs: options.defaultLeaseMs ?? DEFAULTS.defaultLeaseMs,
      defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULTS.defaultMaxAttempts,
    };
    sql.exec(`CREATE TABLE IF NOT EXISTS task_items (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, id TEXT NOT NULL, subject TEXT NOT NULL, destination TEXT,
      sender TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, reply_to TEXT, correlation_id TEXT,
      matched INTEGER NOT NULL DEFAULT 0, UNIQUE (project, id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS task_subscriptions (project TEXT NOT NULL,
      name TEXT NOT NULL, subject TEXT NOT NULL, destination TEXT, sender TEXT,
      lease_ms INTEGER NOT NULL, max_attempts INTEGER NOT NULL, owner TEXT NOT NULL,
      created INTEGER NOT NULL, inbox INTEGER NOT NULL DEFAULT 0, expired INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project, name))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS task_deliveries (project TEXT NOT NULL,
      subscription TEXT NOT NULL, task INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      lease TEXT, lease_expires INTEGER, holder TEXT, PRIMARY KEY (project, subscription, task))`);
    sql.exec("CREATE INDEX IF NOT EXISTS task_deliveries_lease ON task_deliveries (lease)");
    sql.exec("CREATE INDEX IF NOT EXISTS task_deliveries_task ON task_deliveries (task)");
    sql.exec(`CREATE TABLE IF NOT EXISTS task_dead (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, subscription TEXT NOT NULL, task TEXT NOT NULL, bytes INTEGER NOT NULL,
      attempts INTEGER NOT NULL, reason TEXT NOT NULL, dead_at INTEGER NOT NULL,
      expires INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS task_takers (project TEXT NOT NULL, task TEXT NOT NULL,
      holder TEXT NOT NULL, reply_to TEXT NOT NULL, correlation_id TEXT, until INTEGER NOT NULL,
      replied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, task, holder))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS task_jobs (id TEXT PRIMARY KEY, project TEXT NOT NULL,
      task TEXT NOT NULL, subscription TEXT NOT NULL, holder TEXT NOT NULL, sender TEXT NOT NULL,
      until INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS task_job_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL, at INTEGER NOT NULL, progress TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS task_changes (project TEXT PRIMARY KEY,
      seq INTEGER NOT NULL)`);
  }

  #rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.#sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

  // --- changes --------------------------------------------------------------------------------

  /** The project's change counter: it grows whenever a subscription may have tasks to read. */
  changeSeq(project: string): number {
    const row = this.#rows<{ seq: number }>(
      "SELECT seq FROM task_changes WHERE project = ?",
      project,
    )[0];
    return row ? Number(row.seq) : 0;
  }

  readonly #waiters = new Map<string, Set<() => void>>();

  /**
   * Waits up to `waitMs` for the project's change counter to pass `after`: the current counter at
   * once when it already has (or when `after` is undefined). In memory: one queue instance's
   * waiters (a Durable Object's).
   */
  async waitChange(project: string, after: number | undefined, waitMs: number): Promise<number> {
    const seq = this.changeSeq(project);
    if (after === undefined || seq > after || !(waitMs > 0)) return seq;
    await new Promise<void>((resolve) => {
      const set = this.#waiters.get(project) ?? new Set<() => void>();
      this.#waiters.set(project, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) this.#waiters.delete(project);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      set.add(done);
    });
    return this.changeSeq(project);
  }

  #changed(project: string): void {
    queueMicrotask(() => {
      for (const wake of [...(this.#waiters.get(project) ?? [])]) wake();
    });
    this.#sql.exec(
      `INSERT INTO task_changes (project, seq) VALUES (?, 1)
       ON CONFLICT (project) DO UPDATE SET seq = seq + 1`,
      project,
    );
  }

  // --- publishing -----------------------------------------------------------------------------

  /** Publishes a task from `sender`; an inbox's subject only through `reply`. */
  publish(project: string, input: TaskInput, sender: string): Task {
    const subject = (input ?? ({} as TaskInput)).subject;
    if (!isSubject(subject))
      throw taskError("EINVAL", "a task's subject is `.`-separated tokens, without wildcards");
    if (isInbox(subject)) throw taskError("EACCES", "an inbox takes only replies");
    if (input.reply_to !== undefined) {
      const inbox =
        typeof input.reply_to === "string" ? this.#sub(project, input.reply_to) : undefined;
      if (!inbox?.inbox || inbox.owner !== sender)
        throw taskError("EACCES", "reply_to is an inbox of the sender's");
    }
    return this.#insert(project, input, sender);
  }

  #insert(project: string, input: TaskInput, sender: string): Task {
    this.sweep(project);
    const now = this.#now();
    const { destination, correlation_id } = input;
    if (
      destination !== undefined &&
      (typeof destination !== "string" || !DESTINATION.test(destination))
    )
      throw taskError("EINVAL", "a destination is `<kind>:<name>`");
    if (
      correlation_id !== undefined &&
      (typeof correlation_id !== "string" || !CORRELATION.test(correlation_id))
    )
      throw taskError("EINVAL", "a correlation id is up to 128 characters, without spaces");
    const payload = JSON.stringify(input.payload ?? null);
    const bytes = utf8.encode(payload).length;
    if (bytes > this.#o.maxPayloadBytes)
      throw taskError("EINVAL", `a task's payload is at most ${this.#o.maxPayloadBytes} bytes`);
    let expires = now + this.#o.defaultExpiryMs;
    if (input.expires_in_ms !== undefined) {
      if (!Number.isFinite(input.expires_in_ms) || input.expires_in_ms <= 0)
        throw taskError("EINVAL", "expires_in_ms is a positive number");
      expires = now + Number(input.expires_in_ms);
    } else if (input.expires_at !== undefined) {
      if (!Number.isFinite(input.expires_at) || input.expires_at <= now)
        throw taskError("EINVAL", "expires_at is a time in the future (ms since the epoch)");
      expires = Number(input.expires_at);
    }
    expires = Math.min(expires, now + this.#o.maxExpiryMs);
    if (this.waitingCount(project) >= this.#o.maxWaiting)
      throw taskError(
        "ELIMIT",
        `the project's queue holds at most ${this.#o.maxWaiting} waiting tasks; retry after 60 s`,
      );
    const id = this.#newId();
    this.#sql.exec(
      `INSERT INTO task_items (project, id, subject, destination, sender, payload, bytes, created,
        expires_at, reply_to, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project,
      id,
      input.subject,
      destination ?? null,
      sender,
      payload,
      bytes,
      now,
      expires,
      input.reply_to ?? null,
      correlation_id ?? null,
    );
    const row = this.#task(project, id) as TaskRow;
    for (const sub of this.#subs(project)) if (matches(sub, row)) this.#deliver(sub, row);
    this.#changed(project);
    return taskOf(row);
  }

  #deliver(sub: SubRow, task: TaskRow): void {
    this.#sql.exec(
      "INSERT OR IGNORE INTO task_deliveries (project, subscription, task) VALUES (?, ?, ?)",
      sub.project,
      sub.name,
      task.seq,
    );
    this.#sql.exec("UPDATE task_items SET matched = 1 WHERE seq = ?", task.seq);
  }

  /** Tasks the project holds now (those waiting for an inbox included). */
  waitingCount(project: string): number {
    return Number(
      this.#rows<{ n: number }>(
        "SELECT count(*) AS n FROM task_items WHERE project = ?",
        project,
      )[0]?.n ?? 0,
    );
  }

  /** The bytes the project's queue holds: waiting tasks' and dead letters' payloads. */
  bytes(project: string): number {
    const t = this.#rows<{ n: number }>(
      "SELECT coalesce(sum(bytes), 0) AS n FROM task_items WHERE project = ?",
      project,
    )[0];
    const d = this.#rows<{ n: number }>(
      "SELECT coalesce(sum(bytes), 0) AS n FROM task_dead WHERE project = ?",
      project,
    )[0];
    return Number(t?.n ?? 0) + Number(d?.n ?? 0);
  }

  /** The project's waiting tasks, oldest first. */
  listTasks(project: string, options: { limit?: number } = {}): Task[] {
    this.sweep(project);
    return this.#rows<TaskRow>(
      "SELECT * FROM task_items WHERE project = ? ORDER BY seq LIMIT ?",
      project,
      limitOf(options.limit, 1000),
    ).map(taskOf);
  }

  #task(project: string, id: string): TaskRow | undefined {
    return this.#rows<TaskRow>(
      "SELECT * FROM task_items WHERE project = ? AND id = ?",
      project,
      id,
    )[0];
  }

  // --- subscriptions --------------------------------------------------------------------------

  #subs(project: string): SubRow[] {
    return this.#rows<SubRow>("SELECT * FROM task_subscriptions WHERE project = ?", project);
  }

  #sub(project: string, name: string): SubRow | undefined {
    return this.#rows<SubRow>(
      "SELECT * FROM task_subscriptions WHERE project = ? AND name = ?",
      project,
      name,
    )[0];
  }

  /** Creates a subscription owned by `owner`; it receives the matching tasks still waiting. */
  subscribe(project: string, input: SubscriptionInput, owner: string): Subscription {
    const { name, filter, lease_ms, max_attempts } = input ?? ({} as SubscriptionInput);
    if (typeof name !== "string" || !NAME.test(name))
      throw taskError("EINVAL", "a subscription's name is letters, digits, `_`, `.` and `-`");
    if (!filter || typeof filter !== "object" || !isPattern(filter.subject))
      throw taskError("EINVAL", "a subscription filters on a subject (`*` and a last `>` allowed)");
    if (filter.subject.startsWith(INBOX_PREFIX) || filter.subject.startsWith("_inbox"))
      throw taskError("EINVAL", "inboxes are read through their own subscription");
    if (
      filter.destination !== undefined &&
      (typeof filter.destination !== "string" || !DESTINATION.test(filter.destination))
    )
      throw taskError("EINVAL", "a destination is `<kind>:<name>`");
    if (
      filter.sender !== undefined &&
      (typeof filter.sender !== "string" ||
        !filter.sender ||
        filter.sender.length > MAX_SENDER_FILTER)
    )
      throw taskError("EINVAL", "a sender filter is a principal, `*` matching any characters");
    const lease = leaseOf(lease_ms, this.#o.defaultLeaseMs);
    const attempts = max_attempts === undefined ? this.#o.defaultMaxAttempts : Number(max_attempts);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS)
      throw taskError("EINVAL", `max_attempts is a whole number from 1 to ${MAX_ATTEMPTS}`);
    if (this.#sub(project, name)) throw taskError("EEXIST", `the subscription '${name}' exists`);
    return this.#createSub(project, {
      name,
      subject: filter.subject,
      destination: filter.destination ?? null,
      sender: filter.sender ?? null,
      lease_ms: lease,
      max_attempts: attempts,
      owner,
      inbox: 0,
    });
  }

  /** A new reply inbox of `owner`'s: a subscription named by its subject, read only by it. */
  createInbox(project: string, owner: string): Subscription {
    const subject = `${INBOX_PREFIX}${this.#newId().replace(/[^A-Za-z0-9_-]/g, "")}`;
    return this.#createSub(project, {
      name: subject,
      subject,
      destination: null,
      sender: null,
      lease_ms: this.#o.defaultLeaseMs,
      max_attempts: this.#o.defaultMaxAttempts,
      owner,
      inbox: 1,
    });
  }

  #createSub(project: string, s: Omit<SubRow, "project" | "created" | "expired">): Subscription {
    this.sweep(project);
    this.#sql.exec(
      `INSERT INTO task_subscriptions (project, name, subject, destination, sender, lease_ms,
        max_attempts, owner, created, inbox) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project,
      s.name,
      s.subject,
      s.destination,
      s.sender,
      s.lease_ms,
      s.max_attempts,
      s.owner,
      this.#now(),
      s.inbox,
    );
    const sub = this.#sub(project, s.name) as SubRow;
    if (!s.inbox) {
      let found = false;
      for (const task of this.#rows<TaskRow>(
        "SELECT * FROM task_items WHERE project = ? ORDER BY seq",
        project,
      ))
        if (matches(sub, task)) {
          this.#deliver(sub, task);
          found = true;
        }
      if (found) this.#changed(project);
    }
    return subscriptionOf(sub, this.#counts(sub));
  }

  #counts(sub: SubRow): SubscriptionCounts {
    const d = this.#rows<{ waiting: number; leased: number }>(
      `SELECT count(*) AS waiting, coalesce(sum(lease IS NOT NULL), 0) AS leased
       FROM task_deliveries WHERE project = ? AND subscription = ?`,
      sub.project,
      sub.name,
    )[0];
    const dead = this.#rows<{ n: number }>(
      "SELECT count(*) AS n FROM task_dead WHERE project = ? AND subscription = ?",
      sub.project,
      sub.name,
    )[0];
    return {
      waiting: Number(d?.waiting ?? 0),
      leased: Number(d?.leased ?? 0),
      dead_letters: Number(dead?.n ?? 0),
      expired: Number(sub.expired),
    };
  }

  /** The project's subscriptions (inboxes left out unless `inboxes`), with their counts. */
  listSubscriptions(project: string, options: { inboxes?: boolean } = {}): Subscription[] {
    this.sweep(project);
    return this.#subs(project)
      .filter((s) => options.inboxes || !s.inbox)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((s) => subscriptionOf(s, this.#counts(s)));
  }

  /** One subscription with its counts; ENOENT when there is none. */
  getSubscription(project: string, name: string): Subscription {
    this.sweep(project);
    const sub = this.#sub(project, name);
    if (!sub) throw taskError("ENOENT", `no subscription '${name}'`);
    return subscriptionOf(sub, this.#counts(sub));
  }

  /** Deletes a subscription: what waited for it is done for it, its dead letters dropped. */
  unsubscribe(project: string, name: string): void {
    if (!this.#sub(project, name)) throw taskError("ENOENT", `no subscription '${name}'`);
    this.#sql.exec(
      "DELETE FROM task_deliveries WHERE project = ? AND subscription = ?",
      project,
      name,
    );
    this.#sql.exec("DELETE FROM task_dead WHERE project = ? AND subscription = ?", project, name);
    this.#sql.exec("DELETE FROM task_subscriptions WHERE project = ? AND name = ?", project, name);
    this.#collect(project);
  }

  // --- reading --------------------------------------------------------------------------------

  #readable(project: string, name: string, reader: QueueReader): SubRow {
    this.sweep(project);
    const sub = this.#sub(project, name);
    // An inbox is its owner's alone: to anyone else it does not exist.
    if (!sub || (sub.inbox && sub.owner !== reader.id))
      throw taskError("ENOENT", `no subscription '${name}'`);
    return sub;
  }

  /** The deliveries the reader may take now, oldest first, up to `limit`. */
  #candidates(sub: SubRow, reader: QueueReader, limit: number) {
    const out: { delivery: { attempts: number }; task: TaskRow }[] = [];
    const may = new Map<string, boolean>();
    const rows = this.#rows<TaskRow & { attempts: number }>(
      `SELECT t.*, d.attempts AS attempts FROM task_deliveries d JOIN task_items t ON t.seq = d.task
       WHERE d.project = ? AND d.subscription = ? AND d.lease IS NULL ORDER BY t.seq`,
      sub.project,
      sub.name,
    );
    for (const row of rows) {
      if (out.length >= limit) break;
      if (row.destination && !reader.destinations.includes(row.destination)) continue;
      if (reader.may) {
        let ok = may.get(row.subject);
        if (ok === undefined) {
          ok = reader.may(row.subject);
          may.set(row.subject, ok);
        }
        if (!ok) continue;
      }
      out.push({ delivery: { attempts: Number(row.attempts) }, task: row });
    }
    return out;
  }

  /** Tasks waiting for the subscription that the reader may take, left in place. */
  peek(
    project: string,
    name: string,
    reader: QueueReader,
    options: { limit?: number } = {},
  ): Task[] {
    const sub = this.#readable(project, name, reader);
    return this.#candidates(sub, reader, limitOf(options.limit)).map((c) => taskOf(c.task));
  }

  /** Takes tasks: each is done for the subscription as it is read. */
  take(
    project: string,
    name: string,
    reader: QueueReader,
    options: { limit?: number } = {},
  ): Task[] {
    const sub = this.#readable(project, name, reader);
    const found = this.#candidates(sub, reader, limitOf(options.limit));
    for (const { task } of found) {
      this.#sql.exec(
        "DELETE FROM task_deliveries WHERE project = ? AND subscription = ? AND task = ?",
        project,
        name,
        task.seq,
      );
      this.#tookFor(task, reader.id);
    }
    const tasks = found.map((c) => taskOf(c.task));
    if (found.length) this.#collect(project);
    return tasks;
  }

  /** Remembers who took a task that asks for a reply: only they may send it. */
  #tookFor(task: TaskRow, holder: string): void {
    if (!task.reply_to) return;
    this.#sql.exec(
      `INSERT OR IGNORE INTO task_takers (project, task, holder, reply_to, correlation_id, until)
       VALUES (?, ?, ?, ?, ?, ?)`,
      task.project,
      task.id,
      holder,
      task.reply_to,
      task.correlation_id,
      Number(task.expires_at),
    );
  }

  // --- leases ---------------------------------------------------------------------------------

  /** Leases tasks to the reader: each is its until acked, released, or the lease runs out. */
  claim(
    project: string,
    name: string,
    reader: QueueReader,
    options: { limit?: number; lease_ms?: number } = {},
  ): Lease[] {
    const sub = this.#readable(project, name, reader);
    const leaseMs = leaseOf(options.lease_ms, Number(sub.lease_ms));
    const now = this.#now();
    const leases: Lease[] = [];
    for (const { delivery, task } of this.#candidates(sub, reader, limitOf(options.limit))) {
      const id = this.#newId();
      const attempt = delivery.attempts + 1;
      this.#sql.exec(
        `UPDATE task_deliveries SET attempts = ?, lease = ?, lease_expires = ?, holder = ?
         WHERE project = ? AND subscription = ? AND task = ?`,
        attempt,
        id,
        now + leaseMs,
        reader.id,
        project,
        name,
        task.seq,
      );
      this.#tookFor(task, reader.id);
      // The lease's job log: what its executor reports, referenced by its reply.
      this.#sql.exec(
        `INSERT INTO task_jobs (id, project, task, subscription, holder, sender, until)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        project,
        task.id,
        name,
        reader.id,
        task.sender,
        Math.max(Number(task.expires_at), now + this.#o.deadLetterMs),
      );
      leases.push({
        id,
        subscription: name,
        task: taskOf(task),
        attempt,
        max_attempts: Number(sub.max_attempts),
        expires: now + leaseMs,
      });
    }
    return leases;
  }

  /** The live lease `id` held by `holder`, its project swept first; ENOENT otherwise. */
  #lease(id: string, holder: string) {
    const find = () =>
      this.#rows<{
        project: string;
        subscription: string;
        task: number;
        attempts: number;
        lease_expires: number;
        holder: string;
      }>("SELECT * FROM task_deliveries WHERE lease = ?", String(id))[0];
    const first = find();
    if (first) this.sweep(first.project);
    const row = first && find();
    if (!row || row.holder !== holder)
      throw taskError("ENOENT", "no such lease (it may have run out)");
    const sub = this.#sub(row.project, row.subscription) as SubRow;
    const task = this.#rows<TaskRow>(
      "SELECT * FROM task_items WHERE seq = ?",
      row.task,
    )[0] as TaskRow;
    return { row, sub, task };
  }

  /** Done: the task is done for the lease's subscription. */
  ack(id: string, holder: string): void {
    const { row } = this.#lease(id, holder);
    this.#sql.exec("DELETE FROM task_deliveries WHERE lease = ?", String(id));
    this.#collect(row.project);
  }

  /** Not done: the task waits again, or goes to the dead letters once its attempts are used up. */
  release(id: string, holder: string, options: { reason?: string } = {}): { dead: boolean } {
    const { row, sub, task } = this.#lease(id, holder);
    const reason =
      typeof options.reason === "string" && options.reason
        ? options.reason.slice(0, 1000)
        : "released";
    const dead = Number(row.attempts) >= Number(sub.max_attempts);
    if (dead) this.#bury(sub, task, Number(row.attempts), reason);
    else
      this.#sql.exec(
        "UPDATE task_deliveries SET lease = NULL, lease_expires = NULL, holder = NULL WHERE lease = ?",
        String(id),
      );
    this.#changed(row.project);
    return { dead };
  }

  /** Extends a live lease (by the subscription's lease, or `lease_ms`), logging progress. */
  renew(
    id: string,
    holder: string,
    options: { lease_ms?: number; progress?: unknown } = {},
  ): Lease {
    const { row, sub, task } = this.#lease(id, holder);
    const now = this.#now();
    const expires = now + leaseOf(options.lease_ms, Number(sub.lease_ms));
    this.#sql.exec(
      "UPDATE task_deliveries SET lease_expires = ? WHERE lease = ?",
      expires,
      String(id),
    );
    if (options.progress !== undefined) {
      const progress = JSON.stringify(options.progress);
      if (utf8.encode(progress).length > this.#o.maxPayloadBytes)
        throw taskError("EINVAL", `a progress entry is at most ${this.#o.maxPayloadBytes} bytes`);
      this.#sql.exec(
        "INSERT INTO task_job_entries (job, at, progress) VALUES (?, ?, ?)",
        String(id),
        now,
        progress,
      );
    }
    return {
      id: String(id),
      subscription: sub.name,
      task: taskOf(task),
      attempt: Number(row.attempts),
      max_attempts: Number(sub.max_attempts),
      expires,
    };
  }

  /** Moves a task's delivery to the subscription's dead letters. */
  #bury(sub: SubRow, task: TaskRow, attempts: number, reason: string): void {
    const now = this.#now();
    this.#sql.exec(
      `INSERT INTO task_dead (project, subscription, task, bytes, attempts, reason, dead_at, expires)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sub.project,
      sub.name,
      JSON.stringify(taskOf(task)),
      Number(task.bytes),
      attempts,
      reason,
      now,
      now + this.#o.deadLetterMs,
    );
    this.#sql.exec(
      "DELETE FROM task_deliveries WHERE project = ? AND subscription = ? AND task = ?",
      sub.project,
      sub.name,
      task.seq,
    );
    this.#collect(sub.project);
  }

  /** A subscription's dead letters, oldest first. */
  deadLetters(project: string, name: string): DeadLetter[] {
    this.sweep(project);
    if (!this.#sub(project, name)) throw taskError("ENOENT", `no subscription '${name}'`);
    return this.#rows<{
      task: string;
      subscription: string;
      attempts: number;
      reason: string;
      dead_at: number;
      expires: number;
    }>(
      "SELECT * FROM task_dead WHERE project = ? AND subscription = ? ORDER BY seq LIMIT 1000",
      project,
      name,
    ).map((r) => ({
      task: JSON.parse(r.task) as Task,
      subscription: r.subscription,
      attempts: Number(r.attempts),
      reason: r.reason,
      dead_at: Number(r.dead_at),
      expires: Number(r.expires),
    }));
  }

  // --- replies and job logs -------------------------------------------------------------------

  /**
   * Replies to a task `holder` took or claimed, once: a task in its `reply_to` inbox with its
   * correlation id, sent by `holder`.
   */
  reply(project: string, taskId: string, holder: string, input: { payload?: unknown }): Task {
    this.sweep(project);
    const taker = this.#rows<{ reply_to: string; correlation_id: string | null; replied: number }>(
      "SELECT * FROM task_takers WHERE project = ? AND task = ? AND holder = ?",
      project,
      String(taskId),
      holder,
    )[0];
    if (!taker)
      throw taskError("EACCES", "only a consumer that took or claimed a task replies to it");
    if (taker.replied) throw taskError("EBUSY", "this task has its reply");
    if (!this.#sub(project, taker.reply_to)) throw taskError("ENOENT", "the reply inbox is gone");
    const task = this.#insert(
      project,
      {
        subject: taker.reply_to,
        payload: input?.payload ?? null,
        ...(taker.correlation_id ? { correlation_id: taker.correlation_id } : {}),
      },
      holder,
    );
    // An inbox is matched by its subject alone: deliver to it.
    this.#sql.exec(
      "UPDATE task_takers SET replied = 1 WHERE project = ? AND task = ? AND holder = ?",
      project,
      String(taskId),
      holder,
    );
    return task;
  }

  /** A job log, for its lease's holder and its task's sender; ENOENT for anyone else. */
  job(project: string, id: string, reader: string): JobLog {
    this.sweep(project);
    const job = this.#rows<{
      id: string;
      task: string;
      subscription: string;
      holder: string;
      sender: string;
    }>("SELECT * FROM task_jobs WHERE project = ? AND id = ?", project, String(id))[0];
    if (!job || (job.holder !== reader && job.sender !== reader))
      throw taskError("ENOENT", "no such job");
    return {
      id: job.id,
      task: job.task,
      subscription: job.subscription,
      entries: this.#rows<{ at: number; progress: string }>(
        "SELECT at, progress FROM task_job_entries WHERE job = ? ORDER BY seq",
        job.id,
      ).map((e) => ({ at: Number(e.at), progress: JSON.parse(e.progress) })),
    };
  }

  // --- upkeep ---------------------------------------------------------------------------------

  /** Removes tasks that had a matching subscription and that none waits for any more. */
  #collect(project: string): void {
    this.#sql.exec(
      `DELETE FROM task_items WHERE project = ? AND matched = 1
       AND NOT EXISTS (SELECT 1 FROM task_deliveries d WHERE d.task = task_items.seq)`,
      project,
    );
  }

  /** Expires what is due in a project: tasks, leases, dead letters, job logs. */
  sweep(project: string): void {
    const now = this.#now();
    let changed = false;
    // Expired tasks: each subscription still waiting for one counts it.
    const expired = this.#rows<TaskRow>(
      "SELECT * FROM task_items WHERE project = ? AND expires_at <= ?",
      project,
      now,
    );
    for (const task of expired) {
      for (const d of this.#rows<{ subscription: string }>(
        "SELECT subscription FROM task_deliveries WHERE task = ?",
        task.seq,
      ))
        this.#sql.exec(
          "UPDATE task_subscriptions SET expired = expired + 1 WHERE project = ? AND name = ?",
          project,
          d.subscription,
        );
      this.#sql.exec("DELETE FROM task_deliveries WHERE task = ?", task.seq);
      this.#sql.exec("DELETE FROM task_items WHERE seq = ?", task.seq);
    }
    // Leases that ran out: the task waits again, or is dead once its attempts are used up.
    for (const d of this.#rows<{ subscription: string; task: number; attempts: number }>(
      "SELECT * FROM task_deliveries WHERE project = ? AND lease IS NOT NULL AND lease_expires <= ?",
      project,
      now,
    )) {
      changed = true;
      const sub = this.#sub(project, d.subscription) as SubRow;
      const task = this.#rows<TaskRow>("SELECT * FROM task_items WHERE seq = ?", d.task)[0];
      if (task && Number(d.attempts) >= Number(sub.max_attempts))
        this.#bury(sub, task, Number(d.attempts), "the lease ran out");
      else
        this.#sql.exec(
          `UPDATE task_deliveries SET lease = NULL, lease_expires = NULL, holder = NULL
           WHERE project = ? AND subscription = ? AND task = ?`,
          project,
          d.subscription,
          d.task,
        );
    }
    this.#sql.exec("DELETE FROM task_dead WHERE project = ? AND expires <= ?", project, now);
    this.#sql.exec("DELETE FROM task_takers WHERE project = ? AND until <= ?", project, now);
    for (const job of this.#rows<{ id: string }>(
      "SELECT id FROM task_jobs WHERE project = ? AND until <= ?",
      project,
      now,
    )) {
      this.#sql.exec("DELETE FROM task_job_entries WHERE job = ?", job.id);
      this.#sql.exec("DELETE FROM task_jobs WHERE id = ?", job.id);
    }
    if (changed) this.#changed(project);
  }

  /** The projects with something due by now (for an alarm's sweep). */
  dueProjects(): string[] {
    const now = this.#now();
    return this.#rows<{ project: string }>(
      `SELECT project FROM task_items WHERE expires_at <= ?1
       UNION SELECT project FROM task_deliveries WHERE lease_expires <= ?1
       UNION SELECT project FROM task_dead WHERE expires <= ?1`,
      now,
    ).map((r) => r.project);
  }

  /** When the next task, lease or dead letter is due, across projects (undefined: none). */
  nextDue(): number | undefined {
    const row = this.#rows<{ at: number | null }>(
      `SELECT min(at) AS at FROM (SELECT min(expires_at) AS at FROM task_items
       UNION ALL SELECT min(lease_expires) FROM task_deliveries
       UNION ALL SELECT min(expires) FROM task_dead)`,
    )[0];
    return row?.at === null || row?.at === undefined ? undefined : Number(row.at);
  }
}

function limitOf(limit: unknown, max = MAX_READ): number {
  if (limit === undefined || limit === null) return Math.min(DEFAULT_READ, max);
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) throw taskError("EINVAL", "limit is a positive whole number");
  return Math.min(n, max);
}

function leaseOf(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_LEASE_MS || n > MAX_LEASE_MS)
    throw taskError("EINVAL", `a lease is from ${MIN_LEASE_MS} ms to ${MAX_LEASE_MS} ms`);
  return Math.round(n);
}

export type { DeadLetter, JobLog, Lease };
