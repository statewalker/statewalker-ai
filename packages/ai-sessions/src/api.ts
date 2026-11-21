// The session API (statewalker/statewalker-root#83), implemented once as methods. REST
// (./rest.ts) and RPC (./rpc.ts) are thin routers onto these methods; every call is made with the
// caller's access token, checked each time by the caller's User DO (statewalker/statewalker-root#157).
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";

export type { ApprovalRequest };

/** An approval as the session API lists it: the gate's request, and where it stands. */
export interface ApprovalView extends ApprovalRequest {
  workspace: string;
  /** An unanswered approval past its time counts as denied: "expired". */
  status: "pending" | "allowed" | "denied" | "expired";
  created: number;
  expires: number;
}

/** The user's answer to an approval (statewalker/statewalker-root#79). */
export interface ApprovalAnswer {
  decision: "allow" | "deny";
  /** "session": the same permission on the same target, for the rest of the agent session. */
  scope: "once" | "session";
  /** Returned to the model with a denial. */
  message?: string;
}

export interface UserSessionView {
  id: string;
  user: string;
  workspace: string;
  /** The user session's mode: it decides every action of the user's agent sessions. */
  mode: string;
  created: number;
  /** The pending approvals of the user's agent sessions in this workspace. */
  approvals: ApprovalView[];
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
  kind: "message" | "tool_call" | "tool_result" | "approval";
  role?: "user" | "assistant";
  text?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** The approval an `approval` item waits on, or a resumed `tool_result` answers. */
  approval?: string;
  /** An `approval` item's request (the gate's). */
  request?: ApprovalRequest;
  /** An `approval` item's stored action: the exact file call, a write's content in base64. */
  stored?: StoredAction;
}

/** The exact file call an approval runs, as the agent session stores it in its items. */
export interface StoredAction {
  method: "write" | "mkdir" | "remove";
  path: string;
  /** A write's content, base64. */
  content?: string;
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
  /** "pending": the turn ended waiting on the user's approvals. */
  status: "completed" | "failed" | "pending";
  /** Why a turn failed. */
  error?: string;
  items: Item[];
  /** The approvals a pending turn waits on. */
  approvals?: ApprovalView[];
}

/** A turn as the agent session reports it: a pending one names the gate's requests. */
export interface AgentTurn extends Omit<TurnView, "approvals"> {
  requests?: ApprovalRequest[];
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
  /** The caller's agent sessions in the workspace their token names, from the session index. */
  listSessions(): Promise<{ sessions: AgentSessionView[] }>;
  /** The caller's profile. */
  profile(): Promise<ProfileView>;
  /** Erases the caller: their profile and everything their User DO holds. */
  eraseUser(): Promise<{ erased: true }>;
  /** Switches the user session's mode; running agent sessions follow at their next action. */
  setMode(req: { mode: string }): Promise<UserSessionView>;
  /** The approvals of the caller's agent sessions in the workspace, pending or answered. */
  listApprovals(): Promise<{ approvals: ApprovalView[] }>;
  /** Answers one of the caller's approvals; allowing re-checks and runs the stored action. */
  answerApproval(
    id: string,
    answer: ApprovalAnswer,
  ): Promise<{ approval: ApprovalView; turn: TurnView }>;
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
  setMode(token: string, mode: string): Promise<UserSessionView>;
  /** Records what a pending turn of one of the caller's agent sessions waits on. */
  recordApprovals(
    token: string,
    session: string,
    requests: ApprovalRequest[],
  ): Promise<ApprovalView[]>;
  listApprovals(token: string): Promise<{ approvals: ApprovalView[] }>;
  /** Answers one of the caller's pending approvals; an allow is granted at the gate first. */
  answerApproval(token: string, id: string, answer: ApprovalAnswer): Promise<ApprovalView>;
}

/** One agent session DO's side of the API. */
export interface AgentPort {
  start(config: AgentSessionConfig): Promise<void>;
  send(content: string): Promise<AgentTurn>;
  items(): Promise<Item[]>;
  /** Continues the session with the user's answer: the stored action runs, or the denial is told. */
  answer(approval: string, answer: ApprovalAnswer): Promise<AgentTurn>;
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

function approvalAnswer(answer: unknown): ApprovalAnswer {
  const { decision, scope, message } = (answer ?? {}) as Record<string, unknown>;
  if (decision !== "allow" && decision !== "deny")
    throw codedError("EINVAL", "decision is allow or deny");
  if (scope !== undefined && scope !== "once" && scope !== "session")
    throw codedError("EINVAL", "scope is once or session");
  if (message !== undefined && (typeof message !== "string" || message.length > 4000))
    throw codedError("EINVAL", "message is a string of at most 4000 characters");
  return { decision, scope: scope ?? "once", ...(message ? { message } : {}) };
}

export function createSessionApi(token: string, ports: SessionApiPorts): SessionApi {
  /** A turn as the caller sees it: a pending turn's requests recorded as the user's approvals. */
  const view = async (session: string, turn: AgentTurn): Promise<TurnView> => {
    const { requests, ...rest } = turn;
    if (turn.status !== "pending" || !requests?.length) return rest;
    return { ...rest, approvals: await ports.user.recordApprovals(token, session, requests) };
  };
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
      return view(session.id, await ports.agent(session.id).send(content));
    },
    async listItems(sessionId) {
      const session = await ports.user.ownAgentSession(token, String(sessionId));
      return { items: await ports.agent(session.id).items() };
    },
    listSessions: () => ports.user.listAgentSessions(token),
    profile: () => ports.user.profile(token),
    eraseUser: () => ports.user.eraseUser(token),
    setMode(req) {
      const mode = (req as { mode?: unknown } | undefined)?.mode;
      if (typeof mode !== "string") throw codedError("EINVAL", "mode must be a mode's name");
      return ports.user.setMode(token, mode);
    },
    listApprovals: () => ports.user.listApprovals(token),
    async answerApproval(id, answer) {
      const checked = approvalAnswer(answer);
      const approval = await ports.user.answerApproval(token, String(id), checked);
      const turn = await ports.agent(approval.session).answer(approval.id, checked);
      return { approval, turn: await view(approval.session, turn) };
    },
  };
}
