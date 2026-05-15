import { SnowflakeId } from "@statewalker/shared-ids";
import type { FilesApi } from "@statewalker/webrun-files";
import { readText, tryReadText, writeText } from "@statewalker/webrun-files";
import { createAgentNodeFactory } from "../state/node-factory.js";
import { NodeType } from "../state/node-types.js";
import { markdownToSession, sessionToMarkdown } from "../state/session-serialization.js";
import { SessionState } from "../state/session-state.js";
import type { NodeFactory } from "../state/tree-types.js";
import type { SessionMetadata } from "./metadata.js";

interface IndexData {
  sessions: SessionMetadata[];
}

export class FilesSessionManager {
  private idGen = new SnowflakeId();
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

  async create(title?: string): Promise<string> {
    const id = this.idGen.generate();
    const now = new Date().toISOString();
    const meta: SessionMetadata = {
      id,
      title: title ?? "",
      createdAt: now,
      updatedAt: now,
    };

    // Load/create index BEFORE writing session folder to avoid
    // rebuildIndex() picking up the folder we're about to create.
    const index = await this.loadIndex();
    index.sessions.unshift(meta);
    await this.saveIndex(index);

    // Create session folder with empty session
    const session = this.factory({
      type: NodeType.session,
      props: { title: meta.title },
    }) as SessionState;
    const markdown = await sessionToMarkdown(session);
    await writeText(this.files, `${this.sessionsDir}/${id}/${id}.md`, markdown);

    return id;
  }

  async save(id: string, session: SessionState): Promise<void> {
    const sessionDir = `${this.sessionsDir}/${id}`;
    const markdown = await sessionToMarkdown(session);

    // Extract large attachments
    const { text, attachments } = this.extractAttachments(markdown, id);
    for (const [fileName, content] of attachments) {
      await writeText(this.files, `${sessionDir}/${fileName}`, content);
    }

    await writeText(this.files, `${sessionDir}/${id}.md`, text);

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

    // Re-inject attachments
    const rehydrated = await this.rehydrateAttachments(text, sessionDir);

    const root = await markdownToSession(rehydrated, this.factory);
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

  // --- Attachment handling ---

  private extractAttachments(
    markdown: string,
    _id: string,
  ): { text: string; attachments: [string, string][] } {
    // For now, attachment extraction is a future optimization.
    // The full markdown is stored inline.
    // TODO: extract tool responses > ATTACHMENT_THRESHOLD
    return { text: markdown, attachments: [] };
  }

  private async rehydrateAttachments(text: string, _sessionDir: string): Promise<string> {
    // TODO: resolve [attachment:{callId}] markers from .att.json files
    return text;
  }
}
