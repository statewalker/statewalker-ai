// One Workspace DO per workspace: the store, the role source (each project's access file), the
// user and agent sessions, the workspace's root key (it never leaves this DO), and the gate every
// file call of every agent session goes through.

import { DurableObject } from "cloudflare:workers";
import {
  accessFilePath,
  codedError,
  DEFAULT_SYSTEM_FOLDER,
  fromBase64,
  parseAccessFile,
  type StoredRootKey,
  verifyAccessToken,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import {
  answerFileCall,
  type FileCall,
  gatedFiles,
  normalise,
  SqlFiles,
} from "@statewalker/ai-environment";
import { type StartSessionRequest, WorkspaceSessions } from "@statewalker/ai-sessions";
import { tryReadText } from "@statewalker/webrun-files";
import { type Env, issuerOf, workspaceName } from "./env.js";

export class Workspace extends DurableObject<Env> {
  readonly #store: SqlFiles;
  readonly #sessions: WorkspaceSessions;
  readonly #authority: WorkspaceAuthority;
  #issuerKey?: Promise<Uint8Array>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const workspace = workspaceName(env);
    const sql = ctx.storage.sql;
    this.#store = new SqlFiles(sql);
    sql.exec("CREATE TABLE IF NOT EXISTS ws_keys (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const stored = sql.exec("SELECT value FROM ws_keys WHERE name = 'root'").toArray()[0];
    let root: StoredRootKey;
    if (stored) root = JSON.parse(String(stored.value));
    else {
      root = WorkspaceAuthority.generate();
      sql.exec("INSERT INTO ws_keys VALUES ('root', ?)", JSON.stringify(root));
    }
    this.#authority = WorkspaceAuthority.fromStored(root);
    this.#sessions = new WorkspaceSessions({
      sql,
      workspace,
      verifyToken: async (token) => {
        this.#issuerKey ??= issuerOf(env)
          .publicKey()
          .then((k) => fromBase64(k));
        return verifyAccessToken(token, await this.#issuerKey, { workspace });
      },
      roleOf: (project, user) => this.#roleOf(project, user),
      mintCapability: (id) => this.#authority.mint(id),
    });
  }

  openUserSession(token: string) {
    return this.#sessions.openUserSession(token);
  }

  startAgentSession(token: string, req: StartSessionRequest) {
    return this.#sessions.startAgentSession(token, req);
  }

  ownAgentSession(token: string, id: string) {
    return this.#sessions.ownAgentSession(token, id);
  }

  #roleOf(project: string, user: string) {
    return tryReadText(this.#store, accessFilePath(project)).then((t) => parseAccessFile(t)[user]);
  }

  /**
   * The gate: one file call of the agent session the capability names, decided now. The role is
   * read from the access file at this moment, never fixed at the session's start.
   */
  async fileCall(capability: string, call: FileCall): Promise<unknown> {
    const session = await this.#authority.sessionOf(capability);
    const facts = this.#sessions.sessionFacts(session);
    if (!facts) throw codedError("EACCES", "unknown agent session");
    const role = await this.#roleOf(facts.project, facts.user);
    const view = gatedFiles(this.#store, {
      project: facts.project,
      systemFolder: DEFAULT_SYSTEM_FOLDER,
      authorize: (action, path) =>
        this.#authority.authorize(capability, session, {
          action,
          path,
          project: facts.project,
          role,
        }),
    });
    return answerFileCall(view, call);
  }

  /** Test-only fixtures (the Worker admits this only with the ADMIN_KEY). */
  async seed(files: Record<string, string>): Promise<number> {
    const enc = new TextEncoder();
    for (const [path, text] of Object.entries(files))
      await this.#store.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
