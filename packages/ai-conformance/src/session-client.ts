// The session API as a client sees it, over REST. Scenarios are written against `SessionClient`,
// so the same scenario runs over every transport (REST here, RPC in ./rpc-client.ts).
import type { Deployment } from "./deployment.js";

/** An item of a turn, as the session API lists it. */
export interface Item {
  seq: number;
  id: string;
  turn: string;
  kind: "message" | "tool_call" | "tool_result";
  role?: "user" | "assistant";
  text?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** The names of the secrets a tool call used (never their values). */
  secrets?: string[];
}

export type SecretLevel = "deployment" | "workspace" | "project" | "user";

/** Which plugins may use a secret, and which hosts it may be sent to. */
export interface SecretBinding {
  plugins: string[];
  hosts: string[];
}

/** A secret as the session API lists it: never its value. */
export interface SecretView {
  name: string;
  level: SecretLevel;
  project?: string;
  bindings: SecretBinding;
  updated: number;
}

/** Which secrets a call names: a level, and the project for project secrets. */
export interface SecretScope {
  level: SecretLevel;
  project?: string;
}

export interface SetSecretRequest extends SecretScope {
  name: string;
  value: string;
  bindings: SecretBinding;
}

export interface UserSession {
  id: string;
  user: string;
  workspace: string;
  mode: string;
}

export interface AgentSession {
  id: string;
  project: string;
  agent: string;
  workspace: string;
  unattended: boolean;
  revoked: boolean;
}

/** A workspace's service account, as the session API lists it (never its key). */
export interface ServiceAccount {
  name: string;
  user: string;
  created: number;
}

/** The caller's profile, as the session API shows it. */
export interface Profile {
  user: string;
  /** The projects the profile holds user memory of. */
  projects: { workspace: string; project: string }[];
}

export interface Turn {
  id: string;
  session: string;
  status: string;
  items: Item[];
}

export interface SessionClient {
  me(): Promise<UserSession>;
  startSession(req: {
    project: string;
    agent: string;
    unattended?: boolean;
  }): Promise<AgentSession>;
  sendMessage(sessionId: string, req: { content: string }): Promise<Turn>;
  listItems(sessionId: string): Promise<{ items: Item[] }>;
  /** The caller's agent sessions in the workspace their token names, from the session index. */
  listSessions(): Promise<{ sessions: AgentSession[] }>;
  profile(): Promise<Profile>;
  /** Erases the caller: their profile and their User DO's storage. */
  eraseUser(): Promise<{ erased: true }>;
  /** The secrets of one level (and project) the caller manages: names, bindings, update times. */
  listSecrets(scope: SecretScope): Promise<{ secrets: SecretView[] }>;
  /** Sets or replaces a secret; the answer never holds its value. */
  setSecret(req: SetSecretRequest): Promise<SecretView>;
  deleteSecret(req: SecretScope & { name: string }): Promise<{ deleted: true }>;
  /** Revokes one of the caller's agent sessions. */
  revokeSession(sessionId: string): Promise<{ revoked: true }>;
  /** Revokes the caller's user session in the token's workspace, and every agent session in it. */
  revokeUserSession(): Promise<{ revoked: true }>;
  /** The workspace's service accounts (a workspace admin's). */
  listServiceAccounts(): Promise<{ accounts: ServiceAccount[] }>;
  /** Creates a service account; its API key is in the answer, this once. */
  createServiceAccount(req: { name: string }): Promise<ServiceAccount & { key: string }>;
  deleteServiceAccount(name: string): Promise<{ deleted: true }>;
}

/** A refusal by the session API; `status` is the HTTP status REST answers with. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function answer<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? res.statusText));
  return body as T;
}

export function restClient(deployment: Deployment, token: string): SessionClient {
  const call = <T>(method: string, path: string, body?: unknown) =>
    deployment
      .fetch(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      .then((res) => answer<T>(res));
  return {
    me: () => call("GET", "/v1/me"),
    startSession: (req) => call("POST", "/v1/sessions", req),
    sendMessage: (id, req) => call("POST", `/v1/sessions/${encodeURIComponent(id)}/messages`, req),
    listItems: (id) => call("GET", `/v1/sessions/${encodeURIComponent(id)}/items`),
    listSessions: () => call("GET", "/v1/sessions"),
    profile: () => call("GET", "/v1/me/profile"),
    eraseUser: () => call("DELETE", "/v1/me"),
    listSecrets: ({ level, project }) =>
      call("GET", `/v1/secrets?${new URLSearchParams({ level, ...(project ? { project } : {}) })}`),
    setSecret: ({ level, name, ...rest }) =>
      call("PUT", `/v1/secrets/${encodeURIComponent(level)}/${encodeURIComponent(name)}`, rest),
    deleteSecret: ({ level, name, project }) =>
      call(
        "DELETE",
        `/v1/secrets/${encodeURIComponent(level)}/${encodeURIComponent(name)}${project ? `?project=${encodeURIComponent(project)}` : ""}`,
      ),
    revokeSession: (id) => call("POST", `/v1/sessions/${encodeURIComponent(id)}/revoke`),
    revokeUserSession: () => call("DELETE", "/v1/me/session"),
    listServiceAccounts: () => call("GET", "/v1/service-accounts"),
    createServiceAccount: (req) => call("POST", "/v1/service-accounts", req),
    deleteServiceAccount: (name) =>
      call("DELETE", `/v1/service-accounts/${encodeURIComponent(name)}`),
  };
}

/**
 * An access token from the deployment's issuer, through its test-only login route (it stands in
 * for an identity provider and exists only where the deployment's `DEV_LOGIN` var is set).
 */
export async function login(
  deployment: Deployment,
  user: string,
  options: { ttlMs?: number; workspace?: string } = {},
): Promise<string> {
  const res = await deployment.fetch("/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, ...options }),
  });
  return (await answer<{ token: string }>(res)).token;
}

/** A service account's access token, for its API key, from the issuer (`POST /v1/token`). */
export async function serviceAccountToken(deployment: Deployment, key: string): Promise<string> {
  const res = await deployment.fetch("/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  return (await answer<{ token: string }>(res)).token;
}

/** A fresh access token for a valid one, from the issuer (`POST /v1/token/renew`). */
export async function renewToken(deployment: Deployment, token: string): Promise<string> {
  const res = await deployment.fetch("/v1/token/renew", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  return (await answer<{ token: string }>(res)).token;
}

const admin = async <T>(deployment: Deployment, adminKey: string, path: string, body: unknown) =>
  answer<T>(
    await deployment.fetch(path, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * Writes fixture files into one of the deployment's workspaces, the default one unless named
 * (test-only, behind `ADMIN_KEY`).
 */
export async function seed(
  deployment: Deployment,
  adminKey: string,
  files: Record<string, string>,
  workspace?: string,
): Promise<void> {
  await admin(deployment, adminKey, "/admin/seed", { files, workspace });
}

/**
 * Writes fixture files into the deployment's profiles file system, at paths such as
 * `/profiles/<user>/...` (test-only, behind `ADMIN_KEY`).
 */
export async function seedProfiles(
  deployment: Deployment,
  adminKey: string,
  files: Record<string, string>,
): Promise<void> {
  await admin(deployment, adminKey, "/admin/profiles", { files });
}

/**
 * Makes a user's User DO refuse every call from now on, so a scenario can show what keeps working
 * without it (test-only, behind `ADMIN_KEY`).
 */
export async function makeUserUnreachable(
  deployment: Deployment,
  adminKey: string,
  user: string,
): Promise<void> {
  await admin(deployment, adminKey, `/admin/users/${encodeURIComponent(user)}/unreachable`, {});
}

/**
 * Sends a message straight to an agent session's DO, past the user's User DO (test-only, behind
 * `ADMIN_KEY`): the turn's file calls still go to the Workspace DO's gate.
 */
export async function sendPastUser(
  deployment: Deployment,
  adminKey: string,
  sessionId: string,
  content: string,
): Promise<Turn> {
  return admin(deployment, adminKey, `/admin/sessions/${encodeURIComponent(sessionId)}/messages`, {
    content,
  });
}

/**
 * Revokes a user everywhere, at the issuer, as the deployment's operator does (test-only, behind
 * `ADMIN_KEY`).
 */
export async function revokeUserEverywhere(
  deployment: Deployment,
  adminKey: string,
  user: string,
): Promise<void> {
  await admin(deployment, adminKey, `/admin/users/${encodeURIComponent(user)}/revoke`, {});
}

/**
 * Hands an access token straight to one workspace's DO, past the routing by the token's workspace,
 * to see whether it opens a user session there (test-only, behind `ADMIN_KEY`).
 */
export async function openUserSessionAt(
  deployment: Deployment,
  adminKey: string,
  workspace: string,
  token: string,
): Promise<{ opened: true }> {
  return admin(
    deployment,
    adminKey,
    `/admin/workspaces/${encodeURIComponent(workspace)}/user-session`,
    { token },
  );
}

/** What the workspace's SQL role source is told to hold (see `setAccess`). */
export interface AccessFixture {
  /** The workspace, the deployment's default unless named. */
  workspace?: string;
  project?: string;
  /** Members' roles in `project`; an empty list removes the member. */
  members?: Record<string, string[]>;
  /** Custom roles of `project`; `null` removes one. */
  roles?: Record<string, string | string[] | null>;
  /** Workspace-level roles; an empty list removes them. */
  workspaceRoles?: Record<string, string[]>;
}

/**
 * Writes members, custom roles and workspace-level roles into a workspace's SQL role source
 * (test-only, behind `ADMIN_KEY`); harness tools for owners replace this in a later ticket.
 */
export async function setAccess(
  deployment: Deployment,
  adminKey: string,
  fixture: AccessFixture,
): Promise<void> {
  await admin(deployment, adminKey, "/admin/access", fixture);
}
