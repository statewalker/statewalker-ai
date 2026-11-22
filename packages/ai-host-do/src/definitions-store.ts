// The Workspace DO's definitions (statewalker/statewalker-root#82, #128): plugin bundles in the
// standard layout, kept by content hash, and each agent session's pins, so the definitions a
// session started with stay its own whatever later happens to the plugins' sources.
//
// New tables only: plugin_files(hash, path, content) and session_definitions(session, user,
// project, pins, run). Rolling back leaves them unused.
import type { NarrowedAgent, Plugin } from "@statewalker/ai-definitions";
import type { AgentRun } from "@statewalker/ai-sessions";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Where a plugin comes from: the deployment's catalog, the workspace or the project. */
export type PluginLevel = "deployment" | "workspace" | "project";

/** A pinned plugin: its name, the hash of its bundle, and its level (deployment if unknown). */
export interface Pin {
  name: string;
  hash: string;
  level?: PluginLevel;
}

export interface SessionDefinitions {
  user: string;
  project: string;
  /** The session's catalog: its pinned bundles, each at `/<plugin>/`. */
  catalog: MemFilesApi;
  /** The pinned plugins. */
  pins: Pin[];
  run?: NarrowedAgent;
}

/** The agent run as an agent session DO is told it. */
export function agentRun(agent: NarrowedAgent): AgentRun {
  return {
    id: agent.id,
    ...(agent.description ? { description: agent.description } : {}),
    instructions: agent.instructions,
    models: agent.models,
    skills: agent.skills,
    tools: agent.tools,
    agents: agent.agents,
    ...(agent.mode ? { mode: agent.mode } : {}),
    ...(agent.requires !== undefined ? { requires: agent.requires } : {}),
  };
}

const MAX_CACHED = 64;

export class DefinitionsStore {
  readonly #sql: SqlLike;
  readonly #cache = new Map<string, Promise<SessionDefinitions | undefined>>();

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS plugin_files (
      hash TEXT NOT NULL, path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY (hash, path))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS session_definitions (
      session TEXT PRIMARY KEY, user TEXT NOT NULL, project TEXT NOT NULL, pins TEXT NOT NULL,
      run TEXT, created INTEGER NOT NULL)`);
  }

  /** Keeps a plugin's bundle under its hash (once: the same hash is the same content). */
  keep(plugin: Plugin): void {
    const known = this.#sql
      .exec("SELECT 1 FROM plugin_files WHERE hash = ? LIMIT 1", plugin.hash)
      .toArray().length;
    if (known) return;
    for (const [path, data] of plugin.files)
      this.#sql.exec(
        "INSERT OR IGNORE INTO plugin_files VALUES (?, ?, ?)",
        plugin.hash,
        path,
        data,
      );
  }

  /** Pins a new session's plugins and agent. A session's pins never change. */
  pin(session: string, user: string, project: string, pins: Pin[], run?: NarrowedAgent): void {
    this.#sql.exec(
      "INSERT INTO session_definitions VALUES (?, ?, ?, ?, ?, ?)",
      session,
      user,
      project,
      JSON.stringify(pins),
      run ? JSON.stringify(run) : null,
      Date.now(),
    );
  }

  /** What a session pinned, as pinned: its user, project, plugin pins and agent. */
  pins(
    session: string,
  ): { user: string; project: string; pins: Pin[]; run?: NarrowedAgent } | undefined {
    const row = this.#sql
      .exec("SELECT * FROM session_definitions WHERE session = ?", session)
      .toArray()[0];
    if (!row) return undefined;
    return {
      user: String(row.user),
      project: String(row.project),
      pins: JSON.parse(String(row.pins)) as Pin[],
      ...(row.run ? { run: JSON.parse(String(row.run)) as NarrowedAgent } : {}),
    };
  }

  /** A catalog of plugins (in memory), each at `/<plugin>/`. */
  async catalogOf(plugins: readonly Plugin[]): Promise<MemFilesApi> {
    const catalog = new MemFilesApi();
    for (const p of plugins)
      for (const [path, data] of p.files) await catalog.write(`/${p.name}/${path}`, [data]);
    return catalog;
  }

  /** What a session pinned, with its catalog rebuilt from the bundles; undefined if none. */
  session(session: string): Promise<SessionDefinitions | undefined> {
    let found = this.#cache.get(session);
    if (!found) {
      found = this.#load(session);
      this.#cache.set(session, found);
      if (this.#cache.size > MAX_CACHED)
        this.#cache.delete(this.#cache.keys().next().value as string);
      found.catch(() => this.#cache.delete(session));
    }
    return found;
  }

  async #load(session: string): Promise<SessionDefinitions | undefined> {
    const row = this.#sql
      .exec("SELECT * FROM session_definitions WHERE session = ?", session)
      .toArray()[0];
    if (!row) return undefined;
    const catalog = new MemFilesApi();
    const pins = JSON.parse(String(row.pins)) as Pin[];
    for (const pin of pins) {
      const files = this.#sql
        .exec("SELECT path, content FROM plugin_files WHERE hash = ?", pin.hash)
        .toArray();
      for (const f of files)
        await catalog.write(`/${pin.name}/${String(f.path)}`, [
          new Uint8Array(f.content as ArrayBuffer),
        ]);
    }
    return {
      user: String(row.user),
      project: String(row.project),
      catalog,
      pins,
      ...(row.run ? { run: JSON.parse(String(row.run)) as NarrowedAgent } : {}),
    };
  }
}
