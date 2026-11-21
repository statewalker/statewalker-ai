// One Workspace DO per workspace: the store, the role source (each project's access file), the
// workspace's root key (it never leaves this DO), and the gate every file call of every agent
// session goes through. Its name is the workspace. It mints a user capability for a user session
// that a User DO opens with the user's access token, and the gate reads user, project and session
// from each call's capability: it never calls a User DO (statewalker/statewalker-root#157).

import { DurableObject } from "cloudflare:workers";
import {
  accessFilePath,
  codedError,
  DEFAULT_SYSTEM_FOLDER,
  parseAccessFile,
  type StoredRootKey,
  WorkspaceAuthority,
} from "@statewalker/ai-access";
import {
  answerFileCall,
  type FileCall,
  gatedFiles,
  normalise,
  SqlFiles,
} from "@statewalker/ai-environment";
import { tryReadText } from "@statewalker/webrun-files";
import { type Env, nameOf, verifyToken } from "./env.js";

export class Workspace extends DurableObject<Env> {
  readonly #name: string;
  readonly #store: SqlFiles;
  readonly #authority: WorkspaceAuthority;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#name = nameOf(ctx);
    const sql = ctx.storage.sql;
    this.#store = new SqlFiles(sql);
    sql.exec("CREATE TABLE IF NOT EXISTS ws_keys (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // The tracer kept user and agent sessions here; they live in User DOs now. No release held
    // them, so their rows are dropped rather than migrated.
    sql.exec("DROP TABLE IF EXISTS user_sessions");
    sql.exec("DROP TABLE IF EXISTS agent_sessions");
    const stored = sql.exec("SELECT value FROM ws_keys WHERE name = 'root'").toArray()[0];
    let root: StoredRootKey;
    if (stored) root = JSON.parse(String(stored.value));
    else {
      root = WorkspaceAuthority.generate();
      sql.exec("INSERT INTO ws_keys VALUES ('root', ?)", JSON.stringify(root));
    }
    this.#authority = WorkspaceAuthority.fromStored(root);
  }

  /**
   * The user capability for the user session of the access token's user, which must be for this
   * workspace: signed here, so the root key stays here.
   */
  async userCapability(token: string): Promise<string> {
    const claims = await verifyToken(this.env, token);
    if (claims.workspace !== this.#name)
      throw codedError("EAUTH", "the access token is for another workspace");
    return this.#authority.mintUser(claims.user);
  }

  /** The role in a project of the user a user capability names; EACCES for a non-member. */
  async memberRole(capability: string, project: string): Promise<string> {
    const user = await this.#authority.userOf(capability);
    const role = await this.#roleOf(project, user);
    if (!role) throw codedError("EACCES", `${user} is not a member of ${project}`);
    return role;
  }

  #roleOf(project: string, user: string) {
    return tryReadText(this.#store, accessFilePath(project)).then((t) => parseAccessFile(t)[user]);
  }

  /**
   * The gate: one file call of the agent session the capability names, decided now. User and
   * project come from the capability itself; the role is read from the access file at this
   * moment, never fixed at the session's start.
   */
  async fileCall(capability: string, call: FileCall): Promise<unknown> {
    const facts = await this.#authority.agentSessionOf(capability);
    const role = await this.#roleOf(facts.project, facts.user);
    const view = gatedFiles(this.#store, {
      project: facts.project,
      systemFolder: DEFAULT_SYSTEM_FOLDER,
      authorize: (action, path) =>
        this.#authority.authorize(capability, { action, path, project: facts.project, role }),
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
