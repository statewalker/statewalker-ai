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
}

/** One agent session DO's side of the API. */
export interface AgentPort {
  start(config: AgentSessionConfig): Promise<void>;
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
  };
}
