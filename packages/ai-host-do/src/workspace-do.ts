// One Workspace DO per workspace: the store, the role source (each project's access file), the
// user and agent sessions, and the workspace's root key, which never leaves this DO.

import { DurableObject } from "cloudflare:workers";
import {
  accessFilePath,
  fromBase64,
  parseAccessFile,
  type StoredRootKey,
  verifyAccessToken,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import { normalise, SqlFiles } from "@statewalker/ai-environment";
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
      roleOf: async (project, user) =>
        parseAccessFile(await tryReadText(this.#store, accessFilePath(project)))[user],
      mintCapability: (id) => this.#authority.mint(id),
    });
  }

  openUserSession(token: string) {
    return this.#sessions.openUserSession(token);
  }

  startAgentSession(token: string, req: StartSessionRequest) {
    return this.#sessions.startAgentSession(token, req);
  }

  /** Test-only fixtures (the Worker admits this only with the ADMIN_KEY). */
  async seed(files: Record<string, string>): Promise<number> {
    const enc = new TextEncoder();
    for (const [path, text] of Object.entries(files))
      await this.#store.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
