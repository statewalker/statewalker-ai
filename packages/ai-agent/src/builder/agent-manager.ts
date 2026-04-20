import type { SessionManager, SessionMetadata } from "../sessions/types.js";
import type { Agent } from "./agent.js";
import type { AgentBuilder } from "./agent-builder.js";

export class AgentManager {
  private _active?: Agent;
  private _activeSessionId?: string;

  constructor(private builder: AgentBuilder) {}

  get sessions(): SessionManager {
    // Sessions are resolved during build — we need the builder to expose it.
    // For now, build a temporary agent context to get sessions.
    // This is set after first create/resume.
    if (!this._active) {
      throw new Error("No active agent. Call create() or resume() first.");
    }
    return this._active.context.sessions;
  }

  get active(): Agent | undefined {
    return this._active;
  }

  async create(title?: string): Promise<Agent> {
    await this.autoSave();
    const agent = await this.builder.build();
    const id = await agent.context.sessions.create(title);
    this._activeSessionId = id;
    this._active = agent;
    return agent;
  }

  async resume(sessionId: string): Promise<Agent> {
    await this.autoSave();
    const agent = await this.builder.build();
    await agent.resume(sessionId);
    this._activeSessionId = sessionId;
    this._active = agent;
    return agent;
  }

  async list(): Promise<SessionMetadata[]> {
    if (!this._active) {
      // Build a temporary agent to access session manager
      const agent = await this.builder.build();
      return agent.context.sessions.list();
    }
    return this._active.context.sessions.list();
  }

  async delete(sessionId: string): Promise<boolean> {
    if (sessionId === this._activeSessionId) {
      throw new Error("Cannot delete the active session");
    }
    if (!this._active) {
      const agent = await this.builder.build();
      return agent.context.sessions.delete(sessionId);
    }
    return this._active.context.sessions.delete(sessionId);
  }

  private async autoSave(): Promise<void> {
    if (this._active && this._activeSessionId) {
      try {
        await this._active.save();
      } catch {
        // Best-effort save on switch
      }
    }
  }
}
