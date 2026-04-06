import type { Session } from "../state/session.js";

export interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionManager {
  create(title?: string): Promise<string>;
  load(id: string): Promise<Session>;
  save(id: string, session: Session): Promise<void>;
  list(): Promise<SessionMetadata[]>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
}
