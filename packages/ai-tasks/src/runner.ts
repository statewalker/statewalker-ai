// The generic runner (statewalker/statewalker-root#160): serves one subscription with an executor.
// It claims tasks, keeps each lease renewed while the executor runs, records the executor's
// progress in the lease's job log, replies (when a task asks for one) with a reference to that log,
// and acks; a failure releases the lease, so the task is tried again or goes to the dead letters.
// While nothing waits it sleeps on the subscription's change notifications: it pulls, never pushed.
import type { Executor, Lease, TasksApi } from "./types.js";

export interface ServeOptions {
  project: string;
  subscription: string;
  executor: Executor;
  /** Stops the runner: running executors are aborted, their leases released. */
  signal: AbortSignal;
  /** Leases asked for (the subscription's by default). */
  leaseMs?: number;
  /** Tasks run at once (1 by default). */
  concurrency?: number;
  /** How long one wait for a change lasts before claiming again (30 s). */
  waitMs?: number;
  /** Logs the runner's own failures (a lost lease, a refused reply). */
  onError?: (error: unknown) => void;
}

/** What a reply of the runner carries: the job log's id and the result or the error. */
export interface RunnerReply {
  job: string;
  result?: unknown;
  error?: string;
}

const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

type RunnerApi = Pick<TasksApi, "claim" | "renew" | "ack" | "release" | "reply" | "changes">;

/** Serves the subscription until `signal` aborts; resolves once running tasks have settled. */
export async function serveSubscription(api: RunnerApi, options: ServeOptions): Promise<void> {
  const { project, subscription, executor, signal } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const waitMs = options.waitMs ?? 30_000;
  const onError = options.onError ?? (() => {});
  const running = new Set<Promise<void>>();

  const runOne = async (lease: Lease): Promise<void> => {
    const work = new AbortController();
    const stop = () => work.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    const renewMs = Math.max(500, Math.floor((lease.expires - Date.now()) / 2));
    const timer = setInterval(() => {
      api.renew(lease.id, options.leaseMs ? { lease_ms: options.leaseMs } : {}).catch((e) => {
        onError(e);
        work.abort(e);
      });
    }, renewMs);
    const reply = async (body: RunnerReply) => {
      if (!lease.task.reply_to) return;
      try {
        await api.reply(project, lease.task.id, { payload: body });
      } catch (e) {
        onError(e);
      }
    };
    try {
      const result = await executor.run(lease, {
        signal: work.signal,
        progress: async (entry) => {
          await api.renew(lease.id, {
            progress: entry,
            ...(options.leaseMs ? { lease_ms: options.leaseMs } : {}),
          });
        },
      });
      if (work.signal.aborted) throw work.signal.reason ?? new Error("aborted");
      await reply({ job: lease.id, ...(result !== undefined ? { result } : {}) });
      await api.ack(lease.id);
    } catch (e) {
      // The last attempt answers the caller with the error, so no one waits for a dead letter.
      if (lease.attempt >= lease.max_attempts) await reply({ job: lease.id, error: messageOf(e) });
      await api.release(lease.id, { reason: messageOf(e) }).catch(onError);
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", stop);
    }
  };

  // A wait for a change ends early when the runner stops.
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let seq = (await api.changes(project, subscription, { wait_ms: 0 })).seq;
  while (!signal.aborted) {
    const free = concurrency - running.size;
    let leases: Lease[] = [];
    if (free > 0) {
      try {
        leases = (
          await api.claim(project, subscription, {
            limit: free,
            ...(options.leaseMs ? { lease_ms: options.leaseMs } : {}),
          })
        ).leases;
      } catch (e) {
        onError(e);
      }
    }
    for (const lease of leases) {
      const p = runOne(lease).finally(() => running.delete(p));
      running.add(p);
    }
    if (leases.length && running.size < concurrency) continue;
    if (running.size >= concurrency) {
      await Promise.race(running);
      continue;
    }
    try {
      const changed = await Promise.race([
        api.changes(project, subscription, { after: seq, wait_ms: waitMs }),
        aborted.then(() => undefined),
      ]);
      if (changed) seq = changed.seq;
    } catch (e) {
      onError(e);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 1000)));
    }
  }
  await Promise.allSettled([...running]);
}
