// One Workspace DO per workspace: the store, the user sessions, and (as tickets add them) the
// agent sessions and the gate. Its own name is the workspace's.

import { DurableObject } from "cloudflare:workers";
import { fromBase64, verifyAccessToken } from "@statewalker/ai-access";
import { normalise, SqlFiles } from "@statewalker/ai-environment";
import { WorkspaceSessions } from "@statewalker/ai-sessions";
import { type Env, issuerOf, workspaceName } from "./env.js";

export class Workspace extends DurableObject<Env> {
  readonly #store: SqlFiles;
  readonly #sessions: WorkspaceSessions;
  #issuerKey?: Promise<Uint8Array>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const workspace = workspaceName(env);
    this.#store = new SqlFiles(ctx.storage.sql);
    this.#sessions = new WorkspaceSessions({
      sql: ctx.storage.sql,
      workspace,
      verifyToken: async (token) => {
        this.#issuerKey ??= issuerOf(env)
          .publicKey()
          .then((k) => fromBase64(k));
        return verifyAccessToken(token, await this.#issuerKey, { workspace });
      },
    });
  }

  openUserSession(token: string) {
    return this.#sessions.openUserSession(token);
  }

  /** Test-only fixtures (the Worker admits this only with the ADMIN_KEY). */
  async seed(files: Record<string, string>): Promise<number> {
    const enc = new TextEncoder();
    for (const [path, text] of Object.entries(files))
      await this.#store.write(normalise(path), [enc.encode(text)]);
    return Object.keys(files).length;
  }
}
