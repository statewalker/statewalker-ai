// One User DO per user per deployment (statewalker/statewalker-root#157): the user's user sessions
// (one per workspace), the index of their agent sessions across workspaces, and their profile, of
// which it serves only `profiles/<user>/` of the deployment's profiles file system. Its name is the
// user. Calls go only from here to a Workspace DO, never the other way.

import { DurableObject } from "cloudflare:workers";
import { codedError } from "@statewalker/ai-access";
import type { FilesRpcMethod, Limit } from "@statewalker/ai-environment";
import { filesOverRpc, type UsageMeta } from "@statewalker/ai-environment";
import {
  type ApprovalAnswer,
  type ApprovalRequest,
  type DatabaseCall,
  type DeleteSecretRequest,
  type Metadata,
  type ModelsQuery,
  type SecretScope,
  type SetSecretRequest,
  type StartSessionRequest,
  type SubAgentRequest,
  UserSessions,
} from "@statewalker/ai-sessions";
import { tryReadText } from "@statewalker/webrun-files";
import {
  approvalTtlMs,
  blockSizeOf,
  deploymentModes,
  type Env,
  nameOf,
  profilesOf,
  verifyToken,
  workspaceOf,
} from "./env.js";
import { LIMITS_FILE, refusal, UserLimits, warningView } from "./limits-host.js";

export class User extends DurableObject<Env> {
  readonly #sessions: UserSessions;
  /** The user level's limits and counters: spend on the user's own keys (#179). */
  readonly #limits: UserLimits;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const user = nameOf(ctx);
    const profile = filesOverRpc((method, args) => profilesOf(env).files(user, method, args), {
      blockSize: blockSizeOf(env),
    });
    this.#limits = new UserLimits(ctx.storage.sql, env, user, () =>
      tryReadText(profile, `/${LIMITS_FILE}`),
    );
    this.#sessions = new UserSessions({
      sql: ctx.storage.sql,
      user,
      // Only this user's folder of the profiles file system: the Profiles DO roots every call there.
      profile: filesOverRpc((method, args) => profilesOf(env).files(user, method, args), {
        blockSize: blockSizeOf(env),
      }),
      eraseProfile: () => profilesOf(env).erase(user),
      eraseStorage: () => ctx.storage.deleteAll(),
      verifyToken: (token) => verifyToken(env, token),
      workspace: (name) => {
        const ws = workspaceOf(env, name);
        return {
          userCapability: (token) => ws.userCapability(token),
          memberRoles: (capability, project) => ws.memberRoles(capability, project),
          pinDefinitions: (capability, req) => ws.pinDefinitions(capability, req),
          forkDefinitions: (capability, req) => ws.forkDefinitions(capability, req),
          setUserSession: (capability, state) => ws.setUserSession(capability, state),
          grantApproval: (capability, grant) => ws.grantApproval(capability, grant),
          sessionsEnded: (capability, sessions) => ws.sessionsEnded(capability, sessions),
          holdStream: (capability, id) => ws.holdStream(capability, id),
          releaseStream: (capability, id) => ws.releaseStream(capability, id),
          files: (capability, method, args) => ws.files(capability, method, args),
          listDatabases: (capability, project) => ws.listDatabases(capability, project),
          databaseCall: (capability, call) => ws.databaseCall(capability, call),
          listSecrets: (capability, scope) => ws.listSecrets(capability, scope),
          setSecret: (capability, req) => ws.setSecret(capability, req),
          deleteSecret: (capability, req) => ws.deleteSecret(capability, req),
          eraseUserSecrets: (capability) => ws.eraseUserSecrets(capability),
          revoke: (capability, target) => ws.revoke(capability, target),
          delegate: (capability, parent, grant) => ws.delegate(capability, parent, grant),
          listServiceAccounts: (capability) => ws.listServiceAccounts(capability),
          createServiceAccount: (capability, name) => ws.createServiceAccount(capability, name),
          deleteServiceAccount: (capability, name) => ws.deleteServiceAccount(capability, name),
          listModels: (capability, query) => ws.listModels(capability, query),
          getModelConfig: (capability) => ws.getModelConfig(capability),
          setModelConfig: (capability, config) => ws.setModelConfig(capability, config),
        };
      },
      modes: deploymentModes(env),
      approvalTtlMs: approvalTtlMs(env),
      now: () => Date.now() + this.#clockOffset(),
    });
  }

  async holdStream(token: string) {
    await this.#reachable();
    return this.#sessions.holdStream(token);
  }

  async releaseStream(token: string, id: string) {
    await this.#reachable();
    return this.#sessions.releaseStream(token, id);
  }

  /**
   * Reserves the worst case of a model request on the user's own key against the user's limits,
   * told by one of this user's agent sessions' DOs (statewalker/statewalker-root#179): ELIMIT
   * naming the limit when it would cross one.
   */
  async reserveOwnKey(meta: UsageMeta, amounts: Record<string, number>): Promise<string> {
    await this.#reachable();
    if (meta.user !== nameOf(this.ctx)) throw codedError("EACCES", "not this user's session");
    try {
      return this.#limits.ledger.reserve(await this.#limits.scopes(), amounts, meta).id;
    } catch (e) {
      throw refusal(e);
    }
  }

  /** Settles a reservation to what the own-key requests really used; answers warnings. */
  async settleOwnKey(
    id: string,
    used: Record<string, number>,
    meta: UsageMeta,
    detail?: Record<string, unknown>,
  ) {
    return this.#limits.ledger.settle(String(id), used, meta, detail).map(warningView);
  }

  /**
   * Raises a user limit that asked by one increment, once the user allowed that approval here
   * (statewalker/statewalker-root#179); told by the asking session's DO.
   */
  async raiseLimit(session: string, raise: { approval: string; key: string; increment: number }) {
    let ref: unknown[];
    try {
      ref = JSON.parse(String(raise.key)) as unknown[];
    } catch {
      throw codedError("EINVAL", "no such limit");
    }
    if (ref[0] !== "user" || ref[1] !== nameOf(this.ctx))
      throw codedError("EACCES", "not this user's limit");
    if (
      !this.#sessions.approvalAllowed(String(session), String(raise.approval)) ||
      !this.#limits.useApproval(String(raise.approval))
    )
      throw codedError("EACCES", "the user did not approve raising this limit");
    const limit = (await this.#limits.scopes())[0]?.limits.find(
      (l) => l.meter === ref[2] && l.period === ref[3],
    );
    if (!limit) throw codedError("ENOENT", "no such limit");
    this.#limits.ledger.raise(String(raise.key), limit.increment ?? (limit.value || 1));
  }

  /** Test-only: the user's own-key usage records after a seq. */
  async usageRecords(since = 0) {
    return this.#limits.ledger.records(Number(since) || 0);
  }

  /** How far a test moved this User DO's clock forward (`advanceClock`); 0 otherwise. */
  #clockOffset(): number {
    try {
      const row = this.ctx.storage.sql.exec("SELECT ms FROM test_clock").toArray()[0];
      return Number(row?.ms ?? 0);
    } catch {
      return 0;
    }
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

  async forkAgentSession(
    token: string,
    from: string,
    req: { at_turn: string; model?: string; limits?: Limit[] },
  ) {
    await this.#reachable();
    return this.#sessions.forkAgentSession(token, from, req);
  }

  /** Told by an agent session's DO: the pending approvals of turns it rewound are cancelled. */
  async cancelApprovals(session: string, ids: string[]) {
    await this.#reachable();
    return this.#sessions.cancelApprovals(session, ids);
  }

  async ownAgentSession(token: string, id: string) {
    await this.#reachable();
    return this.#sessions.ownAgentSession(token, id);
  }

  async listAgentSessions(token: string) {
    await this.#reachable();
    return this.#sessions.listAgentSessions(token);
  }

  async updateAgentSession(token: string, id: string, metadata: Metadata) {
    await this.#reachable();
    return this.#sessions.updateAgentSession(token, id, metadata);
  }

  async archiveAgentSession(token: string, id: string) {
    await this.#reachable();
    return this.#sessions.archiveAgentSession(token, id);
  }

  async subtree(token: string, id: string) {
    await this.#reachable();
    return this.#sessions.subtree(token, id);
  }

  async deleteAgentSession(token: string, id: string) {
    await this.#reachable();
    return this.#sessions.deleteAgentSession(token, id);
  }

  async profile(token: string) {
    await this.#reachable();
    return this.#sessions.profile(token);
  }

  async eraseUser(token: string) {
    await this.#reachable();
    return this.#sessions.eraseUser(token);
  }

  async setMode(token: string, mode: string) {
    await this.#reachable();
    return this.#sessions.setMode(token, mode);
  }

  /** Told by an agent session's DO: the approvals its waiting turn waits on. */
  async recordApprovals(session: string, requests: ApprovalRequest[]) {
    await this.#reachable();
    return this.#sessions.recordApprovals(session, requests);
  }

  /** Told by an agent session's DO: an action auto mode's risk classifier blocked. */
  async recordBlocked(session: string, request: ApprovalRequest) {
    await this.#reachable();
    return this.#sessions.recordBlocked(session, request);
  }

  /** Told by an agent session's DO: start a sub-agent of it (the harness tool `agent.start`). */
  async startSubAgent(parent: string, capability: string, req: SubAgentRequest) {
    await this.#reachable();
    return this.#sessions.startSubAgent(parent, capability, req);
  }

  async listApprovals(token: string) {
    await this.#reachable();
    return this.#sessions.listApprovals(token);
  }

  async answerApproval(token: string, id: string, answer: ApprovalAnswer) {
    await this.#reachable();
    return this.#sessions.answerApproval(token, id, answer);
  }

  async files(token: string, method: FilesRpcMethod, args: unknown[]) {
    await this.#reachable();
    return this.#sessions.files(token, method, args);
  }

  async listDatabases(token: string, project: string) {
    await this.#reachable();
    return this.#sessions.listDatabases(token, project);
  }

  async databaseCall(token: string, call: DatabaseCall) {
    await this.#reachable();
    return this.#sessions.databaseCall(token, call);
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

  async revokeAgentSession(token: string, id: string) {
    await this.#reachable();
    return this.#sessions.revokeAgentSession(token, id);
  }

  async revokeUserSession(token: string) {
    await this.#reachable();
    return this.#sessions.revokeUserSession(token);
  }

  async listServiceAccounts(token: string) {
    await this.#reachable();
    return this.#sessions.listServiceAccounts(token);
  }

  async createServiceAccount(token: string, name: string) {
    await this.#reachable();
    return this.#sessions.createServiceAccount(token, name);
  }

  async deleteServiceAccount(token: string, name: string) {
    await this.#reachable();
    return this.#sessions.deleteServiceAccount(token, name);
  }

  async listModels(token: string, query: ModelsQuery) {
    await this.#reachable();
    return this.#sessions.listModels(token, query);
  }

  async getModelConfig(token: string) {
    await this.#reachable();
    return this.#sessions.getModelConfig(token);
  }

  async setModelConfig(token: string, config: unknown) {
    await this.#reachable();
    return this.#sessions.setModelConfig(token, config);
  }

  /** Test-only (the Worker admits this only with the ADMIN_KEY): every later call fails. */
  async makeUnreachable(): Promise<void> {
    await this.ctx.storage.put("unreachable", true);
  }

  /**
   * Test-only (the Worker admits this only with the ADMIN_KEY): moves this User DO's clock, which
   * decides when approvals expire, `ms` forward, so a scenario sees a day pass at once.
   */
  async advanceClock(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) throw codedError("EINVAL", "ms must be a number >= 0");
    const offset = this.#clockOffset() + ms;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_clock (ms INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("DELETE FROM test_clock");
    this.ctx.storage.sql.exec("INSERT INTO test_clock VALUES (?)", offset);
    return offset;
  }
}
