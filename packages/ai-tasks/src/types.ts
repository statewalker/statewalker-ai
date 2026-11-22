// The task queue's contract (statewalker/statewalker-root#160, built by #206). Nothing here names
// the harness: a sender, an owner or a holder is an opaque principal string the host stamps
// (`user:<name>`, `session:<id>`, …), a destination is one the host's readers answer to, and a
// payload is JSON data. So the contract can move to a lower layer unchanged (#204).

/** A durable request for work, published under a subject to one project's queue. */
export interface Task {
  id: string;
  subject: string;
  /** Who may take it: a principal the reader answers to (`agent:<p>/<a>`, `user:<u>`, `session:<id>`). */
  destination?: string;
  /** Who published it: stamped by the server, never taken from the publisher. */
  sender: string;
  /** Data, never instructions: shown to agents fenced as untrusted. */
  payload: unknown;
  /** ms since the epoch. */
  created: number;
  expires_at: number;
  /** An inbox subject of the sender's (`_inbox.<id>`): the task asks for a reply there. */
  reply_to?: string;
  correlation_id?: string;
}

/** What a publisher gives: the server stamps `id`, `sender` and `created`. */
export interface TaskInput {
  subject: string;
  payload?: unknown;
  destination?: string;
  /** ms since the epoch; or `expires_in_ms`; the default is the queue's (7 days), capped (30). */
  expires_at?: number;
  expires_in_ms?: number;
  reply_to?: string;
  correlation_id?: string;
}

/** Which tasks a subscription receives: a subject filter, and optionally a destination and sender. */
export interface SubscriptionFilter {
  /** A subject, `*` for one token, `>` (last) for one or more. */
  subject: string;
  /** Only tasks for this destination (exact). */
  destination?: string;
  /** Only tasks from this sender; `*` matches any run of characters. */
  sender?: string;
}

export interface SubscriptionInput {
  /** Unique in the project: letters, digits, `_`, `.`, `-`. */
  name: string;
  filter: SubscriptionFilter;
  /** A claim's lease when the claim names none: 5 minutes by default. */
  lease_ms?: number;
  /** Leases a task may have before it goes to the dead letters: 3 by default. */
  max_attempts?: number;
}

/** What one subscription holds now. */
export interface SubscriptionCounts {
  /** Waiting for this subscription (leased ones included). */
  waiting: number;
  leased: number;
  dead_letters: number;
  /** Tasks that expired before this subscription was done with them. */
  expired: number;
}

export interface Subscription {
  name: string;
  filter: SubscriptionFilter;
  lease_ms: number;
  max_attempts: number;
  /** Who created it. */
  owner: string;
  created: number;
  /** A reply inbox: read only by its owner. */
  inbox?: true;
  counts?: SubscriptionCounts;
}

/** A claimed task, held until acked, released, or its lease runs out. */
export interface Lease {
  id: string;
  subscription: string;
  task: Task;
  /** 1 for the first lease of the task in this subscription. */
  attempt: number;
  max_attempts: number;
  /** When the lease runs out (ms since the epoch). */
  expires: number;
}

/** A task that used up its attempts in one subscription. */
export interface DeadLetter {
  task: Task;
  subscription: string;
  attempts: number;
  reason: string;
  dead_at: number;
  /** When it is dropped (14 days after it died, by default). */
  expires: number;
}

/** One progress entry of a job: what an executor reported, as it reported it. */
export interface JobEntry {
  at: number;
  progress: unknown;
}

/** The progress log of one lease's work: what a reply references by the lease's id. */
export interface JobLog {
  id: string;
  task: string;
  subscription: string;
  entries: JobEntry[];
}

export interface ReadOptions {
  /** At most this many tasks (10 by default, at most 100). */
  limit?: number;
}

export interface ClaimOptions extends ReadOptions {
  /** The lease (the subscription's by default). */
  lease_ms?: number;
}

export interface RenewOptions {
  lease_ms?: number;
  /** A progress entry for the job log. */
  progress?: unknown;
}

export interface ReleaseOptions {
  /** Why the work failed: kept with a dead letter. */
  reason?: string;
}

/** What a reply carries: its payload; it goes to the task's `reply_to` with its `correlation_id`. */
export interface ReplyInput {
  payload?: unknown;
}

/** A change of a subscription's tasks: a counter, never the tasks. Receivers pull. */
export interface Changed {
  seq: number;
}

/**
 * The task API, as a caller sees it: the host authenticates the caller and checks the rights
 * (`tasks.publish:<subject>`, `tasks.subscribe:<subject>`, `tasks.admin`) on every call.
 */
export interface TasksApi {
  /** Publishes a task; its `sender` is the caller. */
  publish(project: string, task: TaskInput): Promise<Task>;
  /** Waiting tasks of the project (`tasks.admin`). */
  listTasks(project: string, options?: ReadOptions): Promise<{ tasks: Task[] }>;
  subscribe(project: string, subscription: SubscriptionInput): Promise<Subscription>;
  listSubscriptions(project: string): Promise<{ subscriptions: Subscription[] }>;
  getSubscription(project: string, name: string): Promise<Subscription>;
  /** Its owner or `tasks.admin`: its waiting tasks are done for it. */
  unsubscribe(project: string, name: string): Promise<{ deleted: true }>;
  /** Tasks waiting for the subscription that the caller may take, left in place. */
  peek(project: string, name: string, options?: ReadOptions): Promise<{ tasks: Task[] }>;
  /** Removes on read: each task is taken once in the subscription. */
  take(project: string, name: string, options?: ReadOptions): Promise<{ tasks: Task[] }>;
  /** Leases tasks: ack, release or renew each; an expired lease returns its task. */
  claim(project: string, name: string, options?: ClaimOptions): Promise<{ leases: Lease[] }>;
  deadLetters(project: string, name: string): Promise<{ dead_letters: DeadLetter[] }>;
  /**
   * Waits up to `wait_ms` for a change of the subscription after `after` (a `seq` it returned):
   * what SSE `changed` events are made of. Answers at once when there was one.
   */
  changes(
    project: string,
    name: string,
    options?: { after?: number; wait_ms?: number },
  ): Promise<Changed>;
  /** A new reply inbox of the caller's: its subject is `reply_to` for the tasks it publishes. */
  createInbox(project: string): Promise<Subscription>;
  /** Replies to a task the caller took or claimed, in its `reply_to`. */
  reply(project: string, task: string, reply: ReplyInput): Promise<Task>;
  ack(lease: string): Promise<{ acked: true }>;
  release(lease: string, options?: ReleaseOptions): Promise<{ released: true; dead?: true }>;
  renew(lease: string, options?: RenewOptions): Promise<Lease>;
  /** A job log, for its lease's holder and the task's sender. */
  job(project: string, id: string): Promise<JobLog>;
}

/** What an executor is given with its lease. */
export interface ExecutorContext {
  /** Aborted when the lease is lost or the runner stops. */
  signal: AbortSignal;
  /** Records progress in the job log (and renews the lease). */
  progress(entry: unknown): Promise<void>;
}

/** Work done for the tasks of a subscription; its result is the reply, when one is asked for. */
export interface Executor {
  run(lease: Lease, context: ExecutorContext): Promise<unknown>;
}
