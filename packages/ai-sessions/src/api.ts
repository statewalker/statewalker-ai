// The session API (statewalker/statewalker-root#83), implemented once as methods. REST
// (./rest.ts) and RPC (./rpc.ts) are thin routers onto these methods; every call is made with the
// caller's access token, checked each time by the caller's User DO (statewalker/statewalker-root#157).
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";

import {
  type FilesRpcMethod,
  type Limit,
  type ModelLevel,
  type ModelsConfig,
  type ModelUsage,
  parseLimits,
} from "@statewalker/ai-environment";
import { sessionOfTurn } from "./turns.js";

export type { ApprovalRequest, Limit, ModelsConfig, ModelUsage };

/** An approval as the session API lists it: the gate's request, and where it stands. */
export interface ApprovalView extends ApprovalRequest {
  workspace: string;
  /** An unanswered approval past its time counts as denied: "expired". */
  /** "blocked": auto mode's risk classifier denied it; approving it retries exactly that action. */
  status: "pending" | "allowed" | "denied" | "expired" | "blocked";
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
  /**
   * What auto mode's risk classifier blocked recently (until the approval time-out), each to be
   * approved for a retry through the approvals API.
   */
  blocked: ApprovalView[];
}

export interface AgentSessionView {
  id: string;
  workspace: string;
  project: string;
  agent: string;
  created: number;
  /** Started with no one present: every "ask" is a deny with a reason. */
  unattended: boolean;
  /** Revoked: its capability is on the workspace's revocation list, and it takes no message. */
  revoked: boolean;
  metadata: Metadata;
  /** When the session was archived: its history is kept, it takes no more messages. */
  archived?: number;
  /** The session's status (single-session reads; lists filtered by status). */
  status?: SessionStatus;
  /** A sub-agent's parent: the session that started it with `agent.start`. */
  parent?: string;
  /** A sub-agent's root: the session the user started, whose events stream gets its approvals. */
  root?: string;
}

/** A project's database, as the session API lists it to a member who may use it. */
export interface DatabaseView {
  name: string;
  /** What the caller's roles let them do there: write, or read (every call rolled back). */
  access: "read" | "write";
  /** The bytes it takes, as the storage meter counts them. */
  bytes: number;
}

/** One db-rpc call on a project's database (statewalker/statewalker-root#136). */
export interface DatabaseCall {
  project: string;
  database: string;
  method: "query" | "readPage" | "closeQuery" | "exec" | "flush";
  args: unknown[];
}

const DB_METHODS = ["query", "readPage", "closeQuery", "exec", "flush"];

/** A database call as the API takes it: checked, with nothing else carried along. */
function databaseCall(call: unknown): DatabaseCall {
  const c = (call ?? {}) as Record<string, unknown>;
  if (typeof c.project !== "string" || !c.project)
    throw codedError("EINVAL", "project must be a project's name");
  if (typeof c.database !== "string" || !c.database)
    throw codedError("EINVAL", "database must be a database's name");
  if (typeof c.method !== "string" || !DB_METHODS.includes(c.method))
    throw codedError("EINVAL", "method must be a db-rpc method");
  if (!Array.isArray(c.args)) throw codedError("EINVAL", "args must be a list");
  return {
    project: c.project,
    database: c.database,
    method: c.method as DatabaseCall["method"],
    args: c.args,
  };
}

/** A workspace's service account, as the session API lists it: never its API key. */
export interface ServiceAccountView {
  /** Its name in the workspace, as the admin gave it. */
  name: string;
  /** Its user name, which access files and role sources name it by. */
  user: string;
  created: number;
}

/** A service account just created: its API key is shown this once. */
export interface CreatedServiceAccount extends ServiceAccountView {
  key: string;
}

/** A user's profile, as the session API shows it. */
export interface ProfileView {
  user: string;
  /** The projects the profile holds user memory of. */
  projects: { workspace: string; project: string }[];
}

/** What a turn adds to its session, in order. */
export interface ItemInput {
  kind:
    | "message"
    | "tool_call"
    | "tool_result"
    | "approval"
    | "model_fallback"
    | "mode_decision"
    | "limit_warning";
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
  /** The names of the secrets a tool call used, never their values. */
  secrets?: string[];
  /** A user message that steered the running turn: the steer's id. */
  steer?: string;
  /** A `user` message another agent wrote (a sub-agent's task from its parent). */
  origin?: "agent";
  /** Cut short: the partial assistant message of a cancelled or interrupted turn. */
  incomplete?: true;
  /**
   * The metered model request that produced the item (on the first item of each answer), or that
   * failed (on a `model_fallback` item).
   */
  usage?: ModelUsage;
  /** A `model_fallback` item: the model that failed for one request, and the one tried next. */
  from?: string;
  to?: string;
  /** Why it fell back: overloaded, rate_limited or unavailable. */
  reason?: string;
  /** Pinned: never compacted into a summary nor trimmed in the model context. */
  pinned?: true;
  /**
   * A `mode_decision` item (auto mode, statewalker/statewalker-root#137): the step that decided an
   * action (a rule, a safe class, the risk classifier, the user's approval, or the mode itself),
   * its verdict and reason (`reason`); a block also holds `approval`, `request` and `stored`.
   */
  step?: "rule" | "safe" | "classifier" | "approval" | "mode";
  verdict?: "allow" | "ask" | "deny";
  /** A `mode_decision` item's action: the file method, its path (and target, a write's size). */
  action?: ApprovalRequest["action"];
  /** A classifier decision's model and latency. */
  model?: string;
  latency_ms?: number;
  /** Set on the denial after which the session fell back to this mode. */
  fallback?: string;
  /**
   * A `limit_warning` item (statewalker/statewalker-root#179): the limit whose `warn_at` share the
   * turn's usage crossed, `{meter, level, target, limit_level, period, used, value, warn_at}`.
   */
  warning?: LimitWarningView;
}

/** A limit whose warning share usage crossed (statewalker/statewalker-root#179). */
export interface LimitWarningView {
  meter: string;
  level: string;
  target: string;
  /** The limit's own level: a deployment ceiling held by a workspace says `deployment`. */
  limit_level: string;
  period: string;
  used: number;
  value: number;
  warn_at: number;
}

/** One decision of auto mode on a change, as the gate reports it to the agent session. */
export interface GateDecisionInput {
  action: ApprovalRequest["action"];
  step: NonNullable<ItemInput["step"]>;
  verdict: "allow" | "ask" | "deny";
  reason: string;
  model?: string;
  latency_ms?: number;
  fallback?: string;
  /** Why the running turn stops with this decision (an unattended session that fell back). */
  stop?: string;
  approval?: string;
  request?: ApprovalRequest;
  /** The exact call of a block (a write's content as bytes). */
  stored?: { method: StoredAction["method"]; path: string; target?: string; content?: Uint8Array };
}

/** The exact file call an approval runs, as the agent session stores it in its items. */
export interface StoredAction {
  /** A file change, or a database action (`db`: the path is the database). */
  method: "write" | "mkdir" | "remove" | "copy" | "move" | "db";
  path: string;
  /** A copy's or move's target. */
  target?: string;
  /** A write's content, or a database action's (its encoded statement), base64. */
  content?: string;
}

/** An item as stored and listed: numbered in its session, and tied to its turn. */
export interface Item extends ItemInput {
  seq: number;
  id: string;
  turn: string;
}

/** How a message reaches the session (statewalker/statewalker-root#83). */
export type Delivery = "next" | "steer" | "interrupt";

export type TurnStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  /** Ended before its answer was complete, by a limit (statewalker/statewalker-root#179). */
  | "incomplete";

/** The limit a turn stopped at (statewalker/statewalker-root#179). */
export interface StopLimit {
  meter: string;
  level: string;
  target: string;
  value: number;
  period: string;
  used: number;
}

/**
 * Why a turn stopped. A turn that ended without completing (`cancelled`, `interrupted`,
 * `failed`, `incomplete`) always carries one: its incomplete reason (statewalker/statewalker-root#108).
 */
export interface StopReason {
  type: "end_turn" | "cancelled" | "interrupted" | "error" | "restart" | "approval" | "budget";
  /** What went wrong, for `error`; which limit, for `budget`. */
  message?: string;
  /** The approvals a `waiting` turn waits on. */
  approval_ids?: string[];
  /** The model spend limit a `budget` stop names. */
  limit?: StopLimit;
}

/** A model the turn ran on other than the one asked for (statewalker/statewalker-root#108). */
export interface ModelSubstitution {
  requested: string;
  used: string;
  reason: string;
}

export interface TurnView {
  id: string;
  session: string;
  status: TurnStatus;
  delivery: Delivery;
  /** Set once the turn ended. */
  stop_reason?: StopReason;
  /** Why a turn failed. */
  error?: string;
  /** The model the turn ran on, once it ran. */
  model?: string;
  model_substitution?: ModelSubstitution;
  /** Fields of the message request the API did not use. */
  ignored?: string[];
  created: number;
  started?: number;
  ended?: number;
  items: Item[];
}

/** The statuses a turn ends in. */
export const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = [
  // A turn that ends waiting on the user's approvals has ended: the answer continues the session.
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "incomplete",
];

export interface SendMessageRequest {
  content: string;
  delivery?: Delivery;
  /** A model to run the turn on; the agent's own unless the caller holds its right. */
  model?: string;
}

/** A message the session accepted (REST: `202`). For `steer`, accepted is not yet applied. */
export interface MessageAccepted {
  turn_id: string;
  session_id: string;
  delivery: Delivery;
  /** The turn's events: an SSE stream ending with the turn's terminal event. */
  stream_url: string;
  /** The event log's offset before the message: read the events after it. */
  offset: number;
  /** Fields of the request the API did not use. */
  ignored?: string[];
}

/** Items, paged: `after` / `before` are item ids. */
export interface ItemsQuery {
  after?: string;
  before?: string;
  limit?: number;
  order?: "asc" | "desc";
  types?: ItemInput["kind"][];
}

export interface ItemsPage {
  items: Item[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

/** One entry of a session's durable, numbered event log. */
export interface SessionEvent {
  seq: number;
  type: string;
  turn?: string;
  data: unknown;
  created: number;
}

export interface EventsQuery {
  /** The offset to read after (an event's `seq`; 0 from the start). */
  since?: number;
  limit?: number;
  /** Milliseconds to wait for a new event when there is none after `since`. */
  wait?: number;
}

export interface EventsPage {
  events: SessionEvent[];
  /** The offset to read after next time. */
  offset: number;
  /** True when nothing is logged past `offset` yet. */
  up_to_date: boolean;
}

export type SessionStatus = "idle" | "running" | "waiting" | "error";

/** Free key/value strings on a session, for search. */
export type Metadata = Record<string, string>;

export interface SessionsQuery {
  status?: SessionStatus | "archived";
  /** Exact matches, all of them. */
  metadata?: Metadata;
}

export interface StartSessionRequest {
  project: string;
  /**
   * `<plugin>/<agent>`, one the caller may use in the project; without it, the project's default
   * agent (its `.system/settings`), then the deployment's (statewalker/statewalker-root#82).
   */
  agent?: string;
  /**
   * No one is present to answer approvals (a scheduled agent, a service account): every "ask" is
   * a deny with a reason, and the agent carries on.
   */
  unattended?: boolean;
  metadata?: Metadata;
  /**
   * A model (an id or an alias) to run the session on instead of the agent's: configured, and one
   * the caller may use (statewalker/statewalker-root#105).
   */
  model?: string;
  /**
   * The session's own limits (statewalker/statewalker-root#179): `[{meter, value, period?,
   * on_exceed?, warn_at?, increment?}]`, at session level. They only add to the limits of every
   * broader level, so the tightest applies.
   */
  limits?: Limit[];
}

/** A model as the session API lists it for a project and a user. */
export interface ModelView {
  /** `<provider>/<model>`. */
  id: string;
  /** The aliases that pick it in the project (each the most specific level's). */
  aliases: string[];
  provider: string;
  /** The level that configured it (a discovered model: its provider's level). */
  level: ModelLevel;
  /** Configured at some level: a discovered model stays off until a level lists it. */
  enabled: boolean;
  /** The caller holds its right (`models.use`). */
  allowed: boolean;
  /** Found through the provider's `/models` endpoint. */
  discovered?: true;
}

export interface ModelsQuery {
  project: string;
  /** Asks each provider's `/models` endpoint too. */
  discover?: boolean;
}

/**
 * The agent an agent session runs, pinned at its start: its definition with every list already
 * narrowed by the user's permissions (statewalker/statewalker-root#82, #128).
 */
export interface AgentRun {
  /** `<plugin>/<agent>`. */
  id: string;
  description?: string;
  /** The always-on instructions, for the system prompt. */
  instructions: string;
  /** The models the user may use, in the agent's order of preference. */
  models: string[];
  /** The skills, tools and sub-agents (`<plugin>/<name>`) it asked for that the user may use. */
  skills: string[];
  tools: string[];
  agents: string[];
  /** A mode it asks for, which may only be stricter than the session's. */
  mode?: string;
  requires?: unknown;
}

/** What starting an agent session pinned: the agent it runs (none: the generic agent). */
export interface PinnedDefinitions {
  /** `<plugin>/<agent>`, or "default" for the generic agent when no agent is defined anywhere. */
  agent: string;
  run?: AgentRun;
  /** The session's model (an id), pinned with its fallbacks by the workspace. */
  model?: string;
  /** The session limits of the deployment, the workspace and the project (#179). */
  limits?: Limit[];
  /** Whether the session's models include a user's own provider (their own key, #179). */
  ownKeys?: boolean;
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
  /** One of the caller's agent sessions, with its status. */
  getSession(sessionId: string): Promise<AgentSessionView>;
  /** Replaces a session's metadata. */
  updateSession(sessionId: string, req: { metadata: Metadata }): Promise<AgentSessionView>;
  /** Archives a session: its running and queued turns end, its history is kept. */
  archiveSession(sessionId: string): Promise<AgentSessionView>;
  /** Purges a session and its history; refused (EBUSY) while it runs. */
  deleteSession(sessionId: string): Promise<{ deleted: true }>;
  /**
   * The caller's agent sessions in the workspace their token names, from the session index,
   * filtered by status and metadata; archived ones only when asked for.
   */
  listSessions(query?: SessionsQuery): Promise<{ sessions: AgentSessionView[] }>;
  /** Sends a message to one of the caller's agent sessions; the turn runs on its own. */
  sendMessage(sessionId: string, req: SendMessageRequest): Promise<MessageAccepted>;
  /** One turn of the caller's sessions, by id. */
  getTurn(turnId: string): Promise<TurnView>;
  /** Cancels that turn only (running or queued); the session's other queued turns stay. */
  cancelTurn(turnId: string): Promise<TurnView>;
  /** The items of one of the caller's agent sessions, paged and filtered. */
  listItems(sessionId: string, query?: ItemsQuery): Promise<ItemsPage>;
  /** One item of one of the caller's agent sessions. */
  getItem(sessionId: string, itemId: string): Promise<Item>;
  /** A cursor read of the session's event log. */
  readEvents(sessionId: string, query?: EventsQuery): Promise<EventsPage>;
  /** The caller's profile. */
  profile(): Promise<ProfileView>;
  /** Erases the caller: their profile and everything their User DO holds. */
  eraseUser(): Promise<{ erased: true }>;
  /** Switches the user session's mode; running agent sessions follow at their next action. */
  setMode(req: { mode: string }): Promise<UserSessionView>;
  /** The approvals of the caller's agent sessions in the workspace, pending or answered. */
  listApprovals(): Promise<{ approvals: ApprovalView[] }>;
  /**
   * Answers one of the caller's approvals. The answer continues the agent session as a turn
   * (allowing re-checks and runs the stored action), accepted like a message.
   */
  answerApproval(
    id: string,
    answer: ApprovalAnswer,
  ): Promise<{ approval: ApprovalView; accepted: MessageAccepted }>;
  /** One call of the files-RPC protocol on the caller's own file view of the token's workspace. */
  files(method: FilesRpcMethod, args: unknown[]): Promise<unknown>;
  /** A project's databases the caller may use (`db.read` or `db.write`), with their sizes. */
  listDatabases(project: string): Promise<{ databases: DatabaseView[] }>;
  /**
   * One db-rpc call on a project's database, decided at the workspace's gate: with only
   * `db.read` it runs in a transaction that is always rolled back.
   */
  database(call: DatabaseCall): Promise<unknown>;
  /**
   * The secrets of one level the caller manages (`secrets.write:<level>`; a project's for project
   * secrets): names, levels, bindings and update times, never values.
   */
  listSecrets(scope: SecretScope): Promise<{ secrets: SecretView[] }>;
  /** Sets or replaces one secret; write-only, so the answer never holds its value. */
  setSecret(req: SetSecretRequest): Promise<SecretView>;
  deleteSecret(req: DeleteSecretRequest): Promise<{ deleted: true }>;
  /**
   * Revokes one of the caller's agent sessions: its capability goes on the workspace's revocation
   * list, so it, and everything narrowed from it, is refused at its next operation.
   */
  revokeSession(sessionId: string): Promise<{ revoked: true }>;
  /**
   * Revokes the caller's user session in the token's workspace: every agent session it started
   * stops at its next operation, and the next call opens a new user session.
   */
  revokeUserSession(): Promise<{ revoked: true }>;
  /** The workspace's service accounts (a workspace admin's: `members.manage`). */
  listServiceAccounts(): Promise<{ accounts: ServiceAccountView[] }>;
  /** Creates a service account; the answer holds its API key, shown this once. */
  createServiceAccount(req: { name: string }): Promise<CreatedServiceAccount>;
  /** Deletes a service account: its key is refused and its tokens are no longer renewed. */
  deleteServiceAccount(name: string): Promise<{ deleted: true }>;
  /** A project's models as the caller sees them; `discover` asks each provider's `/models`. */
  listModels(query: ModelsQuery): Promise<{ models: ModelView[] }>;
  /** The caller's own model configuration (user level) in the token's workspace. */
  getModelConfig(): Promise<ModelsConfig>;
  /** Replaces the caller's own model configuration: their providers (keys are user secrets). */
  setModelConfig(config: ModelsConfig): Promise<ModelsConfig>;
}

/** What an agent session DO is told when it starts. It holds the capability, never the token. */
export interface AgentSessionConfig {
  id: string;
  /** The session's user: its User DO is told the approvals a turn waits on. */
  user: string;
  workspace: string;
  project: string;
  agent: string;
  capability: string;
  /** The agent's definition, pinned at start (none: the generic agent). */
  run?: AgentRun;
  /** The session's model (an id), pinned at start. */
  model?: string;
  /** A sub-agent's parent session. */
  parent?: string;
  /** A sub-agent's root session (statewalker/statewalker-root#126). */
  root?: string;
  /**
   * The names of the tools the session may be offered (none: every tool). A sub-agent's are
   * always among its parent's.
   */
  tools?: string[];
  /** A sub-agent's own mode, beside the user session's: the gate applies the stricter. */
  mode?: string;
  /**
   * The session's limits (statewalker/statewalker-root#179): the broader levels' session
   * defaults and the start request's own, all counted in the agent session's DO.
   */
  limits?: Limit[];
  /** Whether its models include the user's own provider: own-key spend is reserved with the user. */
  ownKeys?: boolean;
  /** No one answers approvals: a limit's ask denies. */
  unattended?: boolean;
}

/** What the harness tool `agent.start` asks for: a child session of the calling session. */
export interface SubAgentRequest {
  agent: string;
  /** A mode for the child: it may only make the gate stricter. */
  mode?: string;
  /** The tools the child is offered: already within the parent's. */
  tools?: string[];
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
  /** The caller's agent sessions in the token's workspace, archived ones included. */
  listAgentSessions(token: string): Promise<{ sessions: AgentSessionView[] }>;
  updateAgentSession(token: string, id: string, metadata: Metadata): Promise<AgentSessionView>;
  /** Archives a session and its descendants, revoking its capability (so theirs). */
  archiveAgentSession(token: string, id: string): Promise<AgentSessionView>;
  /** A session of the caller and its descendants, the session first. */
  subtree(token: string, id: string): Promise<string[]>;
  /** Removes one of the caller's agent sessions from the index. */
  deleteAgentSession(token: string, id: string): Promise<void>;
  profile(token: string): Promise<ProfileView>;
  eraseUser(token: string): Promise<{ erased: true }>;
  setMode(token: string, mode: string): Promise<UserSessionView>;
  listApprovals(token: string): Promise<{ approvals: ApprovalView[] }>;
  /** Answers one of the caller's pending approvals; an allow is granted at the gate first. */
  answerApproval(token: string, id: string, answer: ApprovalAnswer): Promise<ApprovalView>;
  /** One files-RPC call on the user's own file view of the token's workspace. */
  files(token: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown>;
  listDatabases(token: string, project: string): Promise<{ databases: DatabaseView[] }>;
  databaseCall(token: string, call: DatabaseCall): Promise<unknown>;
  listSecrets(token: string, scope: SecretScope): Promise<{ secrets: SecretView[] }>;
  setSecret(token: string, req: SetSecretRequest): Promise<SecretView>;
  deleteSecret(token: string, req: DeleteSecretRequest): Promise<{ deleted: true }>;
  revokeAgentSession(token: string, id: string): Promise<{ revoked: true }>;
  revokeUserSession(token: string): Promise<{ revoked: true }>;
  listServiceAccounts(token: string): Promise<{ accounts: ServiceAccountView[] }>;
  createServiceAccount(token: string, name: string): Promise<CreatedServiceAccount>;
  deleteServiceAccount(token: string, name: string): Promise<{ deleted: true }>;
  listModels(token: string, query: ModelsQuery): Promise<{ models: ModelView[] }>;
  getModelConfig(token: string): Promise<ModelsConfig>;
  /** The configuration is checked by the workspace (EINVAL). */
  setModelConfig(token: string, config: unknown): Promise<ModelsConfig>;
}

/** A message as an agent session DO takes it: checked, with the fields the API ignored. */
export interface AgentMessage {
  content: string;
  delivery: Delivery;
  model?: string;
  ignored: string[];
  /**
   * "agent": written by another agent (a sub-agent's task from its parent), not by the user; auto
   * mode's risk classifier never takes it as the user's words.
   */
  origin?: "agent";
}

/** One agent session DO's side of the API. */
export interface AgentPort {
  start(config: AgentSessionConfig): Promise<void>;
  send(message: AgentMessage): Promise<Omit<MessageAccepted, "stream_url">>;
  turn(turnId: string): Promise<TurnView>;
  cancel(turnId: string): Promise<TurnView>;
  items(query?: ItemsQuery): Promise<ItemsPage>;
  item(itemId: string): Promise<Item>;
  events(query?: EventsQuery): Promise<EventsPage>;
  status(): Promise<SessionStatus>;
  /** Ends the running and queued turns, and takes no more messages. */
  archive(): Promise<void>;
  /** Erases the session's storage; EBUSY while a turn runs or is queued. */
  purge(): Promise<void>;
  /**
   * Continues the session with the user's answer to an approval it waits on: a turn that runs the
   * stored action again (re-checked at the gate), or tells the model the denial.
   */
  answer(approval: string, answer: ApprovalAnswer): Promise<Omit<MessageAccepted, "stream_url">>;
}

export interface SessionApiPorts {
  user: UserPort;
  agent(id: string): AgentPort;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const META_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_META_KEYS = 16;
const MAX_META_VALUE = 512;

/** Metadata: at most 16 keys (letters, digits, `_.-`, up to 64), string values up to 512. */
export function metadataOf(value: unknown): Metadata {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw codedError("EINVAL", "metadata is an object of strings");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_META_KEYS)
    throw codedError("EINVAL", `metadata holds at most ${MAX_META_KEYS} keys`);
  for (const [k, v] of entries) {
    if (!META_KEY.test(k)) throw codedError("EINVAL", `'${k}' is not a metadata key`);
    if (typeof v !== "string" || v.length > MAX_META_VALUE)
      throw codedError("EINVAL", `metadata values are strings of up to ${MAX_META_VALUE}`);
  }
  return Object.fromEntries(entries) as Metadata;
}

/** `<plugin>/<agent>`: a plugin name, then an agent name (ai-definitions). */
const AGENT_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function modelName(model: unknown): string {
  if (typeof model !== "string" || !model || model.length > 320)
    throw codedError("EINVAL", "model must be a model's id or alias");
  return model;
}

function startRequest(req: unknown): StartSessionRequest {
  const { project, agent, metadata, unattended, model, limits } = (req ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof project !== "string" || !NAME.test(project))
    throw codedError("EINVAL", "project must be a project's name");
  if (agent !== undefined && (typeof agent !== "string" || !AGENT_ID.test(agent)))
    throw codedError("EINVAL", "agent must be '<plugin>/<agent>'");
  if (unattended !== undefined && typeof unattended !== "boolean")
    throw codedError("EINVAL", "unattended is true or false");
  return {
    project,
    ...(agent !== undefined ? { agent } : {}),
    metadata: metadataOf(metadata),
    ...(unattended ? { unattended: true } : {}),
    ...(model !== undefined ? { model: modelName(model) } : {}),
    ...(limits !== undefined ? { limits: sessionLimits(limits) } : {}),
  };
}

/** A start request's limits: session level, each checked (EINVAL names the first problem). */
function sessionLimits(limits: unknown): Limit[] {
  if (!Array.isArray(limits) || limits.length > 32)
    throw codedError("EINVAL", "limits is a list of at most 32 limits");
  const parsed = parseLimits(limits.map((l) => ({ ...(l ?? {}), level: "session" })));
  const problem = parsed.problems.find((p) => !p.includes("its period is total"));
  if (problem) throw codedError("EINVAL", problem);
  return parsed.limits.map(({ target: _t, ...l }) => l);
}

function modelsQuery(query: unknown): ModelsQuery {
  const { project, discover } = (query ?? {}) as Record<string, unknown>;
  if (typeof project !== "string" || !NAME.test(project))
    throw codedError("EINVAL", "project must be a project's name");
  return { project, ...(discover === true || discover === "true" ? { discover: true } : {}) };
}

function accountName(name: unknown): string {
  if (typeof name !== "string" || !name) throw codedError("EINVAL", "name is required");
  return name;
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

const MESSAGE_FIELDS = ["content", "delivery", "model"];
const DELIVERIES: readonly string[] = ["next", "steer", "interrupt"];

/** A message request, checked; the fields it holds that the API does not use are reported. */
function messageOf(req: unknown): AgentMessage {
  const body = (req ?? {}) as Record<string, unknown>;
  const { content, delivery = "next", model } = body;
  if (typeof content !== "string" || !content)
    throw codedError("EINVAL", "content must be a non-empty string");
  if (typeof delivery !== "string" || !DELIVERIES.includes(delivery))
    throw codedError("EINVAL", "delivery is next, steer or interrupt");
  if (model !== undefined && (typeof model !== "string" || !model))
    throw codedError("EINVAL", "model must be a model's name");
  return {
    content,
    delivery: delivery as Delivery,
    ...(model ? { model: model as string } : {}),
    ignored: Object.keys(body)
      .filter((k) => !MESSAGE_FIELDS.includes(k))
      .sort(),
  };
}

const STATUSES: readonly string[] = ["idle", "running", "waiting", "error", "archived"];

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

/** Where an accepted message's turn is followed: its events, ending with the terminal one. */
const streamUrl = (session: string, turn: string, offset: number) =>
  `/v1/sessions/${encodeURIComponent(session)}/events?since=${offset}&turn=${encodeURIComponent(turn)}`;

export function createSessionApi(token: string, ports: SessionApiPorts): SessionApi {
  const own = (id: unknown) => ports.user.ownAgentSession(token, String(id));
  const withStatus = async (session: AgentSessionView): Promise<AgentSessionView> => ({
    ...session,
    status: await ports.agent(session.id).status(),
  });
  return {
    me: () => ports.user.openUserSession(token),
    async startSession(req) {
      const { session, config } = await ports.user.startAgentSession(token, startRequest(req));
      await ports.agent(session.id).start(config);
      return session;
    },
    getSession: async (id) => withStatus(await own(id)),
    async updateSession(id, req) {
      const metadata = metadataOf((req as { metadata?: unknown } | undefined)?.metadata ?? {});
      const session = await own(id);
      return ports.user.updateAgentSession(token, session.id, metadata);
    },
    async archiveSession(id) {
      const session = await own(id);
      // Revoked first, so no new sub-agent joins the tree; then every session of it stops.
      const archived = await ports.user.archiveAgentSession(token, session.id);
      const [, ...descendants] = await ports.user.subtree(token, session.id);
      await ports.agent(session.id).archive();
      for (const sid of descendants)
        await ports
          .agent(sid)
          .archive()
          // A sub-agent whose DO never started has nothing to stop.
          .catch(() => {});
      return withStatus(archived);
    },
    async deleteSession(id) {
      const session = await own(id);
      await ports.agent(session.id).purge();
      await ports.user.deleteAgentSession(token, session.id);
      return { deleted: true };
    },
    async listSessions(query) {
      const q = (query ?? {}) as SessionsQuery;
      if (q.status !== undefined && !STATUSES.includes(q.status))
        throw codedError("EINVAL", `status is one of ${STATUSES.join(", ")}`);
      const metadata = metadataOf(q.metadata);
      const { sessions } = await ports.user.listAgentSessions(token);
      const found: AgentSessionView[] = [];
      for (const s of sessions) {
        if ((q.status === "archived") !== !!s.archived) continue;
        if (!Object.entries(metadata).every(([k, v]) => s.metadata?.[k] === v)) continue;
        if (q.status && q.status !== "archived") {
          const status = await ports.agent(s.id).status();
          if (status !== q.status) continue;
          found.push({ ...s, status });
        } else found.push(s);
      }
      return { sessions: found };
    },
    async sendMessage(sessionId, req) {
      const message = messageOf(req);
      const session = await own(sessionId);
      // Archiving revokes too: an archived session says so first (409, as before revocation).
      if (session.archived) throw codedError("EBUSY", "the agent session is archived");
      if (session.revoked) throw codedError("EACCES", "the agent session is revoked");
      const accepted = await ports.agent(session.id).send(message);
      return {
        ...accepted,
        stream_url: streamUrl(session.id, accepted.turn_id, accepted.offset),
      };
    },
    async getTurn(turnId) {
      const session = await own(sessionOfTurn(String(turnId)));
      return ports.agent(session.id).turn(String(turnId));
    },
    async cancelTurn(turnId) {
      const session = await own(sessionOfTurn(String(turnId)));
      return ports.agent(session.id).cancel(String(turnId));
    },
    async listItems(sessionId, query) {
      const session = await own(sessionId);
      return ports.agent(session.id).items((query ?? {}) as ItemsQuery);
    },
    async getItem(sessionId, itemId) {
      const session = await own(sessionId);
      return ports.agent(session.id).item(String(itemId));
    },
    async readEvents(sessionId, query) {
      const session = await own(sessionId);
      return ports.agent(session.id).events((query ?? {}) as EventsQuery);
    },
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
      const accepted = await ports.agent(approval.session).answer(approval.id, checked);
      return {
        approval,
        accepted: {
          ...accepted,
          stream_url: streamUrl(approval.session, accepted.turn_id, accepted.offset),
        },
      };
    },
    files: (method, args) => ports.user.files(token, method, args),
    listDatabases: async (project) => {
      if (typeof project !== "string" || !project)
        throw codedError("EINVAL", "project must be a project's name");
      return ports.user.listDatabases(token, project);
    },
    database: async (call) => ports.user.databaseCall(token, databaseCall(call)),
    listSecrets: async (scope) => ports.user.listSecrets(token, secretScope(scope)),
    setSecret: async (req) => ports.user.setSecret(token, setSecretRequest(req)),
    deleteSecret: async (req) =>
      ports.user.deleteSecret(token, { ...secretScope(req), name: secretName(req) }),
    revokeSession: (sessionId) => ports.user.revokeAgentSession(token, String(sessionId)),
    revokeUserSession: () => ports.user.revokeUserSession(token),
    listServiceAccounts: () => ports.user.listServiceAccounts(token),
    createServiceAccount: async (req) =>
      ports.user.createServiceAccount(token, accountName(req?.name)),
    deleteServiceAccount: async (name) => ports.user.deleteServiceAccount(token, accountName(name)),
    listModels: async (query) => ports.user.listModels(token, modelsQuery(query)),
    getModelConfig: () => ports.user.getModelConfig(token),
    setModelConfig: async (config) => ports.user.setModelConfig(token, config),
  };
}
