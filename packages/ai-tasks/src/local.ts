// The task API over a queue in the same process, for one reader: what tests and single-process
// hosts use. It checks no rights: a host with rights wraps the queue itself.
import type { QueueReader, TaskQueue } from "./queue.js";
import type { TasksApi } from "./types.js";

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;

/** The task API of `reader` over `queue`; every call is the reader's. */
export function queueApi(queue: TaskQueue, reader: QueueReader): TasksApi {
  const run = async <T>(f: () => T): Promise<T> => f();
  return {
    publish: (project, task) => run(() => queue.publish(project, task, reader.id)),
    listTasks: (project, options) => run(() => ({ tasks: queue.listTasks(project, options) })),
    subscribe: (project, sub) => run(() => queue.subscribe(project, sub, reader.id)),
    listSubscriptions: (project) =>
      run(() => ({ subscriptions: queue.listSubscriptions(project) })),
    getSubscription: (project, name) => run(() => queue.getSubscription(project, name)),
    unsubscribe: (project, name) =>
      run(() => {
        queue.unsubscribe(project, name);
        return { deleted: true as const };
      }),
    peek: (project, name, options) =>
      run(() => ({ tasks: queue.peek(project, name, reader, options) })),
    take: (project, name, options) =>
      run(() => ({ tasks: queue.take(project, name, reader, options) })),
    claim: (project, name, options) =>
      run(() => ({ leases: queue.claim(project, name, reader, options) })),
    deadLetters: (project, name) => run(() => ({ dead_letters: queue.deadLetters(project, name) })),
    async changes(project, name, options = {}) {
      queue.getSubscription(project, name);
      const wait = Math.min(Math.max(Number(options.wait_ms ?? DEFAULT_WAIT_MS), 0), MAX_WAIT_MS);
      return { seq: await queue.waitChange(project, options.after, wait) };
    },
    createInbox: (project) => run(() => queue.createInbox(project, reader.id)),
    reply: (project, task, reply) => run(() => queue.reply(project, task, reader.id, reply)),
    ack: (lease) =>
      run(() => {
        queue.ack(lease, reader.id);
        return { acked: true as const };
      }),
    release: (lease, options) =>
      run(() => {
        const { dead } = queue.release(lease, reader.id, options);
        return { released: true as const, ...(dead ? { dead: true as const } : {}) };
      }),
    renew: (lease, options) => run(() => queue.renew(lease, reader.id, options)),
    job: (project, id) => run(() => queue.job(project, id, reader.id)),
  };
}
