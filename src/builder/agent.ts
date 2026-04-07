import type { AgentContext } from "../config/types.js";
import type { AgentController } from "../controller/agent-controller.js";
import type { Inbox } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
import type { Session } from "../state/session.js";

const AUTO_SAVE_MS = 250;

export class Agent {
  constructor(
    readonly controller: AgentController,
    readonly context: AgentContext,
  ) {}

  get inbox(): Inbox {
    return this.controller.inbox;
  }

  get session(): Session {
    return this.controller.session;
  }

  async *run(signal?: AbortSignal): AsyncGenerator<LogMessage> {
    const stopAutoSave = this._startAutoSave();
    try {
      yield* this.controller.run(signal);
    } finally {
      stopAutoSave();
    }
  }

  async save(title?: string): Promise<string> {
    const session = this.controller.session;
    const id = session.id;

    if (title !== undefined) {
      session.update({ title });
    }

    await this.context.sessions.save(id, session);
    return id;
  }

  async resume(id: string): Promise<void> {
    const loaded = await this.context.sessions.load(id);
    const session = this.controller.session;
    for (const turn of [...session.turns]) {
      session.removeChild(turn);
    }
    for (const child of loaded.children) {
      session.addChild(child.data);
    }
  }

  private _startAutoSave(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;

    const flush = () => {
      timer = undefined;
      if (dirty) {
        dirty = false;
        this.save().catch(() => {});
      }
    };

    const unsubscribe = this.session.onUpdate(() => {
      if (this.session.turns.length === 0) return;
      dirty = true;
      if (!timer) {
        timer = setTimeout(flush, AUTO_SAVE_MS);
      }
    });

    return () => {
      unsubscribe();
      clearTimeout(timer);
      flush();
    };
  }
}
