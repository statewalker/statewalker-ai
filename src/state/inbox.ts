import { BaseClass } from "@statewalker/shared-baseclass";

export type InboxMessage = {
  role: "user" | "agent" | "system";
  text: string;
  source?: string;
};

export class Inbox extends BaseClass {
  #queue: InboxMessage[] = [];
  #resolve?: () => void;

  /** Push a message (from user, another agent, system event, etc.) */
  push(message: InboxMessage): void {
    this.#queue.push(message);
    this.#resolve?.();
    this.notify();
  }

  /** Consume next message — suspends until one arrives or signal aborts. */
  async take(signal?: AbortSignal): Promise<InboxMessage | undefined> {
    if (signal?.aborted) return undefined;

    let cleanup = () => {};
    try {
      const abortPromise = new Promise<void>((resolve) => {
        const handler = () => resolve();
        signal?.addEventListener("abort", handler, { once: true });
        cleanup = () => signal?.removeEventListener("abort", handler);
      });

      while (this.#queue.length === 0) {
        if (signal?.aborted) return undefined;
        await Promise.race([
          abortPromise,
          new Promise<void>((resolve) => {
            this.#resolve = resolve;
          }),
        ]);
        if (signal?.aborted) return undefined;
      }

      const msg = this.#queue.shift() as InboxMessage;
      this.notify();
      return msg;
    } finally {
      cleanup();
    }
  }

  get pending(): number {
    return this.#queue.length;
  }
}
