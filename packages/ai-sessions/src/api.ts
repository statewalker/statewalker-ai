// The session API (statewalker/statewalker-root#83), implemented once as methods. REST
// (./rest.ts) and RPC (./rpc.ts) are thin routers onto these methods; every call is made with the
// caller's access token, checked each time by the caller's User DO (statewalker/statewalker-root#157).
import { codedError } from "@statewalker/ai-access";

export interface UserSessionView {
  id: string;
  user: string;
  workspace: string;
  /** The user session's mode (modes and their rules: a later ticket). */
  mode: string;
  created: number;
}

export interface AgentSessionView {
  id: string;
  workspace: string;
  project: string;
  agent: string;
  created: number;
}

/** A user's profile, as the session API shows it. */
export interface ProfileView {
  user: string;
  /** The projects the profile holds user memory of. */
  projects: { workspace: string; project: string }[];
}

/** What a turn adds to its session, in order. */
export interface ItemInput {
  kind: "message" | "tool_call" | "tool_result";
  role?: "user" | "assistant";
  text?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** The names of the secrets a tool call used, never their values. */
  secrets?: string[];
}

/** An item as stored and listed: numbered in its session, and tied to its turn. */
export interface Item extends ItemInput {
  seq: number;
  id: string;
  turn: string;
}

export interface TurnView {
  id: string;
  session: string;
  status: "completed" | "failed";
  /** Why a turn failed. */
  error?: string;
  items: Item[];
}

export interface SendMessageRequest {
  content: string;
}

export interface StartSessionRequest {
  project: string;
  agent: string;
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
  /** The project of a project secret. */
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

export interface DeleteSecretRequest extends SecretScope {
  name: string;
}

/** The session API, as one caller (one access token) sees it. */
export interface SessionApi {
  /** Opens the caller's user session in the workspace, or resumes it. */
  me(): Promise<UserSessionView>;
  /** Starts an agent session in a project the caller is a member of. */
  startSession(req: StartSessionRequest): Promise<AgentSessionView>;
  /** Sends a message to one of the caller's agent sessions: it runs one turn. */
  sendMessage(sessionId: string, req: SendMessageRequest): Promise<TurnView>;
  /** The items of one of the caller's agent sessions, in order. */
  listItems(sessionId: string): Promise<{ items: Item[] }>;
  /** The caller's agent sessions in the workspace their token names, from the session index. */
  listSessions(): Promise<{ sessions: AgentSessionView[] }>;
  /** The caller's profile. */
  profile(): Promise<ProfileView>;
  /** Erases the caller: their profile and everything their User DO holds. */
  eraseUser(): Promise<{ erased: true }>;
  /**
   * The secrets of one level the caller manages (`secrets.write:<level>`; a project's for project
   * secrets): names, levels, bindings and update times, never values.
   */
  listSecrets(scope: SecretScope): Promise<{ secrets: SecretView[] }>;
  /** Sets or replaces one secret; write-only, so the answer never holds its value. */
  setSecret(req: SetSecretRequest): Promise<SecretView>;
  deleteSecret(req: DeleteSecretRequest): Promise<{ deleted: true }>;
}

/** What an agent session DO is told when it starts. It holds the capability, never the token. */
export interface AgentSessionConfig {
  id: string;
  workspace: string;
  project: string;
  agent: string;
  capability: string;
}

/** The caller's User DO's side of the API: everything that needs the token checked. */
export interface UserPort {
  openUserSession(token: string): Promise<UserSessionView>;
  startAgentSession(
    token: string,
    req: StartSessionRequest,
  ): Promise<{ session: AgentSessionView; config: AgentSessionConfig }>;
  /** One of the caller's own agent sessions; ENOENT for any other. */
  ownAgentSession(token: string, id: string): Promise<AgentSessionView>;
  listAgentSessions(token: string): Promise<{ sessions: AgentSessionView[] }>;
  profile(token: string): Promise<ProfileView>;
  eraseUser(token: string): Promise<{ erased: true }>;
  listSecrets(token: string, scope: SecretScope): Promise<{ secrets: SecretView[] }>;
  setSecret(token: string, req: SetSecretRequest): Promise<SecretView>;
  deleteSecret(token: string, req: DeleteSecretRequest): Promise<{ deleted: true }>;
}

/** One agent session DO's side of the API. */
export interface AgentPort {
  start(config: AgentSessionConfig): Promise<void>;
  send(content: string): Promise<TurnView>;
  items(): Promise<Item[]>;
}

export interface SessionApiPorts {
  user: UserPort;
  agent(id: string): AgentPort;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function startRequest(req: unknown): StartSessionRequest {
  const { project, agent } = (req ?? {}) as Record<string, unknown>;
  if (typeof project !== "string" || !NAME.test(project))
    throw codedError("EINVAL", "project must be a project's name");
  if (typeof agent !== "string" || !NAME.test(agent))
    throw codedError("EINVAL", "agent must be an agent's name");
  return { project, agent };
}

const LEVELS: readonly string[] = ["deployment", "workspace", "project", "user"];

function secretScope(req: unknown): SecretScope {
  const { level, project } = (req ?? {}) as Record<string, unknown>;
  if (typeof level !== "string" || !LEVELS.includes(level))
    throw codedError("EINVAL", "level must be deployment, workspace, project or user");
  if (level === "project") {
    if (typeof project !== "string" || !NAME.test(project))
      throw codedError("EINVAL", "project secrets name their project");
    return { level, project };
  }
  if (project !== undefined && project !== "")
    throw codedError("EINVAL", "only project secrets name a project");
  return { level: level as SecretLevel };
}

function secretName(req: unknown): string {
  const { name } = (req ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || !name) throw codedError("EINVAL", "name is required");
  return name;
}

function setSecretRequest(req: unknown): SetSecretRequest {
  const { value, bindings } = (req ?? {}) as Record<string, unknown>;
  if (typeof value !== "string" || !value) throw codedError("EINVAL", "value is required");
  const b = (bindings ?? {}) as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!strings(b.plugins) || !strings(b.hosts))
    throw codedError("EINVAL", "bindings are {plugins: string[], hosts: string[]}");
  return {
    ...secretScope(req),
    name: secretName(req),
    value,
    bindings: { plugins: b.plugins as string[], hosts: b.hosts as string[] },
  };
}

export function createSessionApi(token: string, ports: SessionApiPorts): SessionApi {
  return {
    me: () => ports.user.openUserSession(token),
    async startSession(req) {
      const { session, config } = await ports.user.startAgentSession(token, startRequest(req));
      await ports.agent(session.id).start(config);
      return session;
    },
    async sendMessage(sessionId, req) {
      const content = (req as Partial<SendMessageRequest> | undefined)?.content;
      if (typeof content !== "string" || !content)
        throw codedError("EINVAL", "content must be a non-empty string");
      const session = await ports.user.ownAgentSession(token, String(sessionId));
      return ports.agent(session.id).send(content);
    },
    async listItems(sessionId) {
      const session = await ports.user.ownAgentSession(token, String(sessionId));
      return { items: await ports.agent(session.id).items() };
    },
    listSessions: () => ports.user.listAgentSessions(token),
    profile: () => ports.user.profile(token),
    eraseUser: () => ports.user.eraseUser(token),
    listSecrets: async (scope) => ports.user.listSecrets(token, secretScope(scope)),
    setSecret: async (req) => ports.user.setSecret(token, setSecretRequest(req)),
    deleteSecret: async (req) =>
      ports.user.deleteSecret(token, { ...secretScope(req), name: secretName(req) }),
  };
}
