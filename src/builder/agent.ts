import type { AgentController } from "../agent-controller.js";
import type { AgentContext } from "../config/types.js";
import type { Inbox } from "../state/inbox.js";
import type { LogMessage } from "../state/log-message.js";
import type { Session } from "../state/session.js";

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
    yield* this.controller.run(signal);
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
    // Replace the session in the controller
    // The controller's session is readonly, so we copy turns into it
    // This is a simplified approach — in practice the controller would
    // accept a session replacement method
    const session = this.controller.session;
    // Clear existing turns
    for (const turn of [...session.turns]) {
      session.removeChild(turn);
    }
    // Copy loaded turns
    for (const child of loaded.children) {
      session.addChild(child.data);
    }
  }
}
