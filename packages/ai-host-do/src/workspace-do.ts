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
  deploymentSecrets,
  type FileCall,
  type GatewayResult,
  gatedFiles,
  gatewayFetch,
  normalise,
  type OutgoingRequest,
  type SecretInfo,
  SecretStore,
  SqlFiles,
  type StoredLevel,
  sessionSecrets,
} from "@statewalker/ai-environment";
import type {
  DeleteSecretRequest,
  SecretScope,
  SecretView,
  SetSecretRequest,
} from "@statewalker/ai-sessions";
import { tryReadText } from "@statewalker/webrun-files";
import { type Env, nameOf, verifyToken } from "./env.js";

export class Workspace extends DurableObject<Env> {
  readonly #name: string;
  readonly #store: SqlFiles;
  readonly #authority: WorkspaceAuthority;
  readonly #secrets: SecretStore;

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
    // Workspace, project and user secrets: sealed rows in this DO's SQLite, never files.
    this.#secrets = new SecretStore({ sql, secretsKey: env.SECRETS_KEY, workspace: this.#name });
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

  #deploymentSecrets() {
    return deploymentSecrets(
      this.env.DEPLOYMENT_SECRETS,
      this.env as unknown as Record<string, unknown>,
    );
  }

  async #isWorkspaceAdmin(user: string): Promise<boolean> {
    const text = await tryReadText(this.#store, `/${DEFAULT_SYSTEM_FOLDER}/access`);
    return parseAccessFile(text)[user] === "admin";
  }

  /**
   * `secrets.write:<level>` for a user capability's user, and the scope its rows are kept under:
   * the user manages their own, a project's owner its project's, the workspace admin the
   * workspace's. Deployment secrets are the runtime's: the admin may list them, nobody writes them.
   */
  // A minimal check until the permission language (statewalker/statewalker-root#123) carries a
  // `secrets` area; then this asks the member's role grants instead.
  async #secretScope(
    capability: string,
    scope: SecretScope,
    write: boolean,
  ): Promise<{ level: StoredLevel | "deployment"; scope: string }> {
    const user = await this.#authority.userOfUserCapability(capability);
    const refuse = () => codedError("EACCES", `${user} may not manage ${scope.level} secrets here`);
    switch (scope.level) {
      case "user":
        return { level: "user", scope: user };
      case "project": {
        const project = String(scope.project);
        if ((await this.#roleOf(project, user)) !== "owner") throw refuse();
        return { level: "project", scope: project };
      }
      case "workspace":
        if (!(await this.#isWorkspaceAdmin(user))) throw refuse();
        return { level: "workspace", scope: "" };
      case "deployment":
        if (write || !(await this.#isWorkspaceAdmin(user))) throw refuse();
        return { level: "deployment", scope: "" };
      default:
        throw codedError("EINVAL", "no such secret level");
    }
  }

  #view(info: SecretInfo): SecretView {
    return {
      name: info.name,
      level: info.level,
      ...(info.level === "project" ? { project: info.scope } : {}),
      bindings: info.bindings,
      updated: info.updated,
    };
  }

  /** The secrets of one level the caller manages: never a value. */
  async listSecrets(capability: string, scope: SecretScope): Promise<SecretView[]> {
    const s = await this.#secretScope(capability, scope, false);
    const infos =
      s.level === "deployment"
        ? this.#deploymentSecrets().info
        : this.#secrets.list(s.level, s.scope);
    return infos.map((i) => this.#view(i));
  }

  /** Sets or replaces one secret (write-only: the answer never holds its value). */
  async setSecret(capability: string, req: SetSecretRequest): Promise<SecretView> {
    const s = await this.#secretScope(capability, req, true);
    if (s.level === "deployment")
      throw codedError("EACCES", "deployment secrets are runtime secrets");
    return this.#view(await this.#secrets.set(s.level, s.scope, req.name, req.value, req.bindings));
  }

  async deleteSecret(capability: string, req: DeleteSecretRequest): Promise<void> {
    const s = await this.#secretScope(capability, req, true);
    if (s.level === "deployment")
      throw codedError("EACCES", "deployment secrets are runtime secrets");
    if (!this.#secrets.delete(s.level, s.scope, req.name))
      throw codedError("ENOENT", `secret ${req.name} is not set`);
  }

  /** Deletes all the user-level secrets of a user capability's user (they are being erased). */
  async eraseUserSecrets(capability: string): Promise<void> {
    const user = await this.#authority.userOfUserCapability(capability);
    this.#secrets.deleteScope("user", user);
  }

  /**
   * The host-side gateway for one outgoing request of a plugin in an agent session: its
   * `{{secret:NAME}}` placeholders resolve to the session's user's, project's, workspace's or the
   * deployment's secret, the most specific first, only where its binding names the plugin and the
   * request's host. Values are read now and never leave this DO except in the request itself; the
   * answer is redacted and names the secrets used.
   */
  async gatewayFetch(
    capability: string,
    call: { plugin: string; request: OutgoingRequest },
  ): Promise<GatewayResult> {
    const facts = await this.#authority.agentSessionOf(capability);
    if (!(await this.#roleOf(facts.project, facts.user)))
      throw codedError("EACCES", `${facts.user} is not a member of ${facts.project}`);
    const lookup = sessionSecrets(this.#secrets, this.#deploymentSecrets(), facts);
    return gatewayFetch(call.request, String(call.plugin), lookup);
  }

  /** Test-only fixtures (the Worker admits this only with the ADMIN_KEY). */
  async seed(files: Record<string, string>): Promise<number> {
    const enc = new TextEncoder();
    for (const [path, text] of Object.entries(files))
      await this.#store.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
