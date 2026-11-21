// The deployment's token issuer (statewalker/statewalker-root#78, #127): one DO holding the signing
// key. It signs access tokens for people an identity provider identified, exchanges a service
// account's API key for an access token, and renews valid tokens. Revoking a user everywhere is
// done here: the issuer stops signing and renewing their tokens, and those in hand expire soon.

import { DurableObject } from "cloudflare:workers";
import {
  codedError,
  fromBase64,
  hashApiKey,
  isServiceAccount,
  newApiKey,
  serviceAccountUser,
  TokenIssuer,
  toBase64,
  verifyAccessToken,
} from "@statewalker/ai-access";
import type { CreatedServiceAccount, ServiceAccountView } from "@statewalker/ai-sessions";
import { type Env, workspacesOf } from "./env.js";

interface AccountRow {
  user: string;
  workspace: string;
  name: string;
  key_hash: string;
  created: number;
}

export class Issuer extends DurableObject<Env> {
  #issuer?: TokenIssuer;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    // Users revoked everywhere: no token is signed or renewed for them.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS revoked_users (user TEXT PRIMARY KEY, revoked INTEGER NOT NULL)",
    );
    // Service accounts, each in one workspace; their API keys are kept only as hashes.
    sql.exec(`CREATE TABLE IF NOT EXISTS service_accounts (user TEXT PRIMARY KEY,
      workspace TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      created INTEGER NOT NULL)`);
  }

  async #get(): Promise<TokenIssuer> {
    if (this.#issuer) return this.#issuer;
    let keys = await this.ctx.storage.get<{ secret: string; public: string }>("keys");
    if (!keys) {
      const kp = TokenIssuer.generateKeys();
      keys = { secret: toBase64(kp.secretKey), public: toBase64(kp.publicKey) };
      await this.ctx.storage.put("keys", keys);
    }
    this.#issuer = new TokenIssuer(
      { secretKey: fromBase64(keys.secret), publicKey: fromBase64(keys.public) },
      { id: "issuer", ttlMs: Number(this.env.TOKEN_TTL_MS ?? 3_600_000) },
    );
    return this.#issuer;
  }

  #refuseRevoked(user: string): void {
    const revoked = this.ctx.storage.sql
      .exec("SELECT 1 FROM revoked_users WHERE user = ?", user)
      .toArray();
    if (revoked.length) throw codedError("EAUTH", "this user's access is revoked");
  }

  #account(user: string): AccountRow | undefined {
    return this.ctx.storage.sql
      .exec("SELECT * FROM service_accounts WHERE user = ?", user)
      .toArray()[0] as AccountRow | undefined;
  }

  async publicKey(): Promise<string> {
    return toBase64((await this.#get()).publicKey);
  }

  /**
   * Signs an access token for a person an identity provider has already identified. A user revoked
   * everywhere gets none, and no one signs in as a service account this way.
   */
  async issue(user: string, workspace: string, ttlMs?: number) {
    const issuer = await this.#get();
    this.#refuseRevoked(user);
    return issuer.issue(user, workspace, ttlMs);
  }

  /** An access token for the service account whose API key this is; EAUTH for any other key. */
  async exchangeApiKey(key: string) {
    const issuer = await this.#get();
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM service_accounts WHERE key_hash = ?", await hashApiKey(String(key)))
      .toArray()[0] as AccountRow | undefined;
    if (!row || !workspacesOf(this.env).includes(row.workspace))
      throw codedError("EAUTH", "invalid API key");
    this.#refuseRevoked(row.user);
    return issuer.issueServiceAccount(row.user, row.workspace);
  }

  /**
   * A fresh access token for the user and workspace a valid one names. Nothing is renewed for a
   * user revoked everywhere, nor for a service account that was deleted.
   */
  async renew(token: string) {
    const issuer = await this.#get();
    const claims = await verifyAccessToken(token, issuer.publicKey, {
      workspace: workspacesOf(this.env),
    });
    this.#refuseRevoked(claims.user);
    if (isServiceAccount(claims.user)) {
      const account = this.#account(claims.user);
      // A service account's tokens always last the issuer's TTL, so their expiry tells when they
      // were signed: one signed before this account was made belongs to a deleted account of the
      // same name, and is not renewed. (An access token carries only user, workspace, issuer and
      // expiry, statewalker/statewalker-root#78.)
      const signed = claims.expires - issuer.ttlMs;
      if (account?.workspace !== claims.workspace || signed < Number(account.created))
        throw codedError("EAUTH", "this service account was deleted");
      return issuer.issueServiceAccount(claims.user, claims.workspace);
    }
    return issuer.issue(claims.user, claims.workspace);
  }

  /** Revokes a user everywhere: no more tokens are signed or renewed for them. */
  async revokeUser(user: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO revoked_users VALUES (?, ?)",
      String(user),
      Date.now(),
    );
  }

  /**
   * The service accounts of a workspace. Only its Workspace DO calls these, once it has checked the
   * caller is the workspace's admin.
   */
  async listServiceAccounts(workspace: string): Promise<ServiceAccountView[]> {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM service_accounts WHERE workspace = ? ORDER BY name", workspace)
      .toArray() as unknown as AccountRow[];
    return rows.map((r) => ({ name: r.name, user: r.user, created: Number(r.created) }));
  }

  async createServiceAccount(workspace: string, name: string): Promise<CreatedServiceAccount> {
    const user = serviceAccountUser(workspace, name);
    if (this.#account(user)) throw codedError("EINVAL", `service account '${name}' exists`);
    const key = newApiKey();
    const created = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO service_accounts VALUES (?, ?, ?, ?, ?)",
      user,
      workspace,
      name,
      await hashApiKey(key),
      created,
    );
    return { name, user, created, key };
  }

  async deleteServiceAccount(workspace: string, name: string): Promise<void> {
    const user = serviceAccountUser(workspace, name);
    const account = this.#account(user);
    if (account?.workspace !== workspace)
      throw codedError("ENOENT", `no service account '${name}'`);
    this.ctx.storage.sql.exec("DELETE FROM service_accounts WHERE user = ?", user);
  }
}
