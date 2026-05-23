import type { FilesApi } from "@statewalker/webrun-files";
import { readText, tryReadText, writeText } from "@statewalker/webrun-files";
import { createAgentNodeFactory } from "../state/node-factory.js";
import { NodeType } from "../state/node-types.js";
import { markdownToSession, sessionToMarkdown } from "../state/session-serialization.js";
import { SessionState } from "../state/session-state.js";
import type { NodeFactory } from "../state/tree-types.js";
import type { SessionMetadata, SessionModelRef } from "./metadata.js";

interface IndexData {
  sessions: SessionMetadata[];
}

export class FilesSessionManager {
  private factory: NodeFactory;
  private sessionsDir: string;
  private indexFile: string;

  constructor(
    private files: FilesApi,
    /**
     * The sessions storage directory itself (NOT a parent). Each session is
     * stored under `${sessionsDir}/<id>/<id>.md` plus a shared
     * `${sessionsDir}/index.json`.
     */
    sessionsDir = "/sessions",
    factory?: NodeFactory,
  ) {
    this.factory = factory ?? createAgentNodeFactory();
    // Normalize: ensure leading slash, no trailing slash.
    const normalized = sessionsDir.replace(/\/+$/, "") || "/";
    this.sessionsDir = normalized.startsWith("/") ? normalized : `/${normalized}`;
    this.indexFile = `${this.sessionsDir}/index.json`;
  }

  async save(id: string, session: SessionState): Promise<void> {
    const sessionDir = `${this.sessionsDir}/${id}`;
    const markdown = await sessionToMarkdown(session);
    await writeText(this.files, `${sessionDir}/${id}.md`, markdown);

    // Update index metadata
    const index = await this.loadIndex();
    const entry = index.sessions.find((s) => s.id === id);
    const title = (session.data.props?.title as string) ?? "";
    const now = new Date().toISOString();
    if (entry) {
      entry.updatedAt = now;
      entry.title = title;
    } else {
      index.sessions.unshift({
        id,
        title,
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.saveIndex(index);
  }

  async load(id: string): Promise<SessionState> {
    const sessionDir = `${this.sessionsDir}/${id}`;
    const text = await readText(this.files, `${sessionDir}/${id}.md`);

    const root = await markdownToSession(text, this.factory);
    if (root instanceof SessionState) return root;
    // Wrap in SessionState if the factory returned a plain TreeNode
    const session = this.factory({ type: NodeType.session }) as SessionState;
    for (const child of root.children) {
      session.addChild(child.data);
    }
    return session;
  }

  async list(): Promise<SessionMetadata[]> {
    const index = await this.loadIndex();
    return index.sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async delete(id: string): Promise<boolean> {
    const sessionDir = `${this.sessionsDir}/${id}`;
    const removed = await this.files.remove(sessionDir);
    if (removed) {
      const index = await this.loadIndex();
      index.sessions = index.sessions.filter((s) => s.id !== id);
      await this.saveIndex(index);
    }
    return removed;
  }

  async exists(id: string): Promise<boolean> {
    return this.files.exists(`${this.sessionsDir}/${id}`);
  }

  /** Update the per-session model selection. Pass `null` to clear.
   * No-op when the session id isn't in the index. The session's
   * `updatedAt` is bumped on any change. */
  async setModelRef(id: string, modelRef: SessionModelRef | null): Promise<void> {
    const index = await this.loadIndex();
    const entry = index.sessions.find((s) => s.id === id);
    if (!entry) return;
    const before = entry.modelRef;
    const after = modelRef ?? undefined;
    const sameRef =
      before?.connectionId === after?.connectionId && before?.modelId === after?.modelId;
    if (sameRef) return;
    if (after) {
      entry.modelRef = after;
    } else {
      delete entry.modelRef;
    }
    entry.updatedAt = new Date().toISOString();
    await this.saveIndex(index);
  }

  /** Read the metadata for a single session. Returns `undefined`
   * when the id isn't in the index. */
  async getMetadata(id: string): Promise<SessionMetadata | undefined> {
    const index = await this.loadIndex();
    return index.sessions.find((s) => s.id === id);
  }

  // --- Index management ---

  private async loadIndex(): Promise<IndexData> {
    const text = await tryReadText(this.files, this.indexFile);
    if (text) {
      try {
        return JSON.parse(text) as IndexData;
      } catch {
        // Corrupted index — rebuild
      }
    }
    return this.rebuildIndex();
  }

  private async saveIndex(index: IndexData): Promise<void> {
    await writeText(this.files, this.indexFile, JSON.stringify(index, null, 2));
  }

  private async rebuildIndex(): Promise<IndexData> {
    const sessions: SessionMetadata[] = [];
    if (!(await this.files.exists(this.sessionsDir))) {
      return { sessions };
    }
    for await (const entry of this.files.list(this.sessionsDir)) {
      if (entry.kind !== "directory") continue;
      const id = entry.name;
      const mdPath = `${this.sessionsDir}/${id}/${id}.md`;
      if (!(await this.files.exists(mdPath))) continue;
      sessions.push({
        id,
        title: "",
        createdAt: new Date(entry.lastModified ?? 0).toISOString(),
        updatedAt: new Date(entry.lastModified ?? 0).toISOString(),
      });
    }
    const index: IndexData = { sessions };
    await this.saveIndex(index);
    return index;
  }
}
