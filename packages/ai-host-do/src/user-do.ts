// One User DO per user per deployment (statewalker/statewalker-root#157): the user's user sessions
// (one per workspace), the index of their agent sessions across workspaces, and their profile, of
// which it serves only `profiles/<user>/` of the deployment's profiles file system. Its name is the
// user. Calls go only from here to a Workspace DO, never the other way.

import { DurableObject } from "cloudflare:workers";
import { codedError } from "@statewalker/ai-access";
import { filesOverCalls } from "@statewalker/ai-environment";
import {
  type DeleteSecretRequest,
  type SecretScope,
  type SetSecretRequest,
  type StartSessionRequest,
  UserSessions,
} from "@statewalker/ai-sessions";
import { type Env, nameOf, profilesOf, verifyToken, workspaceOf } from "./env.js";

export class User extends DurableObject<Env> {
  readonly #sessions: UserSessions;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const user = nameOf(ctx);
    this.#sessions = new UserSessions({
      sql: ctx.storage.sql,
      user,
      // Only this user's folder of the profiles file system: the Profiles DO roots every call there.
      profile: filesOverCalls((call) => profilesOf(env).fileCall(user, call)),
      eraseProfile: () => profilesOf(env).erase(user),
      eraseStorage: () => ctx.storage.deleteAll(),
      verifyToken: (token) => verifyToken(env, token),
      workspace: (name) => {
        const ws = workspaceOf(env, name);
        return {
          userCapability: (token) => ws.userCapability(token),
          memberRole: (capability, project) => ws.memberRole(capability, project),
          listSecrets: (capability, scope) => ws.listSecrets(capability, scope),
          setSecret: (capability, req) => ws.setSecret(capability, req),
          deleteSecret: (capability, req) => ws.deleteSecret(capability, req),
          eraseUserSecrets: (capability) => ws.eraseUserSecrets(capability),
        };
      },
    });
  }

  /** Refuses every call once a test made this User DO unreachable. */
  async #reachable(): Promise<void> {
    if (await this.ctx.storage.get("unreachable"))
      throw codedError("EIO", "this User DO is unreachable");
  }

  async openUserSession(token: string) {
    await this.#reachable();
    return this.#sessions.openUserSession(token);
  }

  async startAgentSession(token: string, req: StartSessionRequest) {
    await this.#reachable();
    return this.#sessions.startAgentSession(token, req);
  }

  async ownAgentSession(token: string, id: string) {
    await this.#reachable();
    return this.#sessions.ownAgentSession(token, id);
  }

  async listAgentSessions(token: string) {
    await this.#reachable();
    return this.#sessions.listAgentSessions(token);
  }

  async profile(token: string) {
    await this.#reachable();
    return this.#sessions.profile(token);
  }

  async eraseUser(token: string) {
    await this.#reachable();
    return this.#sessions.eraseUser(token);
  }

  async listSecrets(token: string, scope: SecretScope) {
    await this.#reachable();
    return this.#sessions.listSecrets(token, scope);
  }

  async setSecret(token: string, req: SetSecretRequest) {
    await this.#reachable();
    return this.#sessions.setSecret(token, req);
  }

  async deleteSecret(token: string, req: DeleteSecretRequest) {
    await this.#reachable();
    return this.#sessions.deleteSecret(token, req);
  }

  /** Test-only (the Worker admits this only with the ADMIN_KEY): every later call fails. */
  async makeUnreachable(): Promise<void> {
    await this.ctx.storage.put("unreachable", true);
  }
}
