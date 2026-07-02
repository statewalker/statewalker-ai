import type { LogMessage } from "../../state/log-message.js";

/**
 * A single-consumer async queue bridging the FSM engine's fire-and-forget state
 * handlers (which push LogMessages) to the {@link import("./fsm-executor.js").FsmExecutor}
 * generator (which yields them). Closing it ends the stream; a close-with-error
 * rethrows on the consumer side.
 */
export class LogChannel {
  #queue: LogMessage[] = [];
  #wake?: () => void;
  #closed = false;
  #error?: unknown;

  push(message: LogMessage): void {
    this.#queue.push(message);
    this.#wake?.();
  }

  close(error?: unknown): void {
    this.#closed = true;
    this.#error = error;
    this.#wake?.();
  }

  async *stream(): AsyncGenerator<LogMessage> {
    for (;;) {
      while (this.#queue.length > 0) yield this.#queue.shift() as LogMessage;
      if (this.#closed) {
        if (this.#error) throw this.#error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}
