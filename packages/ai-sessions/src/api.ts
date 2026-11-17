// The session API (statewalker/statewalker-root#83), implemented once as methods. REST
// (./rest.ts) and RPC (./rpc.ts) are thin routers onto these methods; every call is made with the
// caller's access token, checked by the Workspace DO each time.
import { codedError } from "@statewalker/ai-access";

export interface UserSessionView {
  id: string;
  user: string;
  workspace: string;
  created: number;
}

export interface AgentSessionView {
  id: string;
  project: string;
  agent: string;
  created: number;
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
}

/** What an agent session DO is told when it starts. It holds the capability, never the token. */
export interface AgentSessionConfig {
  id: string;
  workspace: string;
  project: string;
  agent: string;
  capability: string;
}

/** The Workspace DO's side of the API: everything that needs the token checked. */
export interface WorkspacePort {
  openUserSession(token: string): Promise<UserSessionView>;
  startAgentSession(
    token: string,
    req: StartSessionRequest,
  ): Promise<{ session: AgentSessionView; config: AgentSessionConfig }>;
  /** One of the caller's own agent sessions; ENOENT for any other. */
  ownAgentSession(token: string, id: string): Promise<AgentSessionView>;
}

/** One agent session DO's side of the API. */
export interface AgentPort {
  start(config: AgentSessionConfig): Promise<void>;
  send(content: string): Promise<TurnView>;
  items(): Promise<Item[]>;
}

export interface SessionApiPorts {
  workspace: WorkspacePort;
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

export function createSessionApi(token: string, ports: SessionApiPorts): SessionApi {
  return {
    me: () => ports.workspace.openUserSession(token),
    async startSession(req) {
      const { session, config } = await ports.workspace.startAgentSession(token, startRequest(req));
      await ports.agent(session.id).start(config);
      return session;
    },
    async sendMessage(sessionId, req) {
      const content = (req as Partial<SendMessageRequest> | undefined)?.content;
      if (typeof content !== "string" || !content)
        throw codedError("EINVAL", "content must be a non-empty string");
      const session = await ports.workspace.ownAgentSession(token, String(sessionId));
      return ports.agent(session.id).send(content);
    },
    async listItems(sessionId) {
      const session = await ports.workspace.ownAgentSession(token, String(sessionId));
      return { items: await ports.agent(session.id).items() };
    },
  };
}
