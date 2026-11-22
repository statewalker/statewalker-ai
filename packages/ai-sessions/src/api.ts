// The session API (statewalker/statewalker-root#83), implemented once as methods. REST
// (./rest.ts) and RPC (./rpc.ts) are thin routers onto these methods; every call is made with the
// caller's access token, checked each time by the caller's User DO (statewalker/statewalker-root#157).
import { type ApprovalRequest, codedError } from "@statewalker/ai-access";

import {
  type FilesRpcMethod,
  LIMIT_LEVELS,
  type Limit,
  type LimitLevel,
  type LimitState,
  type ModelLevel,
  type ModelsConfig,
  type ModelUsage,
  parseLimits,
  USAGE_GROUPS,
  type UsageGroup,
  type UsageGroupBy,
  type UsageRecord,
} from "@statewalker/ai-environment";
import type {
  BatchResult,
  EntryView,
  FileView,
  KindView,
  MemoryAction,
  MemoryCall,
  MemorySnapshot,
  MemoryUsage,
  PrimedEntry,
} from "@statewalker/ai-memory";
import { sessionOfTurn } from "./turns.js";

export type {
  ApprovalRequest,
  BatchResult,
  EntryView,
  FileView,
  KindView,
  Limit,
  LimitState,
  MemoryAction,
  MemoryCall,
  ModelsConfig,
  ModelUsage,
  UsageGroup,
  UsageGroupBy,
  UsageRecord,
};

/** An approval as the session API lists it: the gate's request, and where it stands. */
export interface ApprovalView extends ApprovalRequest {
  workspace: string;
  /** An unanswered approval past its time counts as denied: "expired". */
  /** "blocked": auto mode's risk classifier denied it; approving it retries exactly that action. */
  /** "cancelled": the turn that asked it was rewound (statewalker/statewalker-root#190). */
  status: "pending" | "allowed" | "denied" | "expired" | "blocked" | "cancelled";
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
  /** The session's model usage, totalled over its turns (single-session reads, #181). */
  usage?: UsageTotals;
  /** A fork: the session and turn its history was copied from (statewalker/statewalker-root#190). */
  forked_from?: TurnRef;
}

/** A turn of a session, by both ids. */
export interface TurnRef {
  session: string;
  turn: string;
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
  /** The user's preferences (their active entries). */
  preferences: EntryView[];
  /**
   * The projects the profile holds user memory of, deleted and left ones included: `state` says
   * whether the user is still a member, has left, or the project is gone (known for workspaces
   * the user has a user session in).
   */
  projects: { workspace: string; project: string; state?: "member" | "left" | "gone" }[];
}

/**
 * Which memory a memory API call names (statewalker/statewalker-root#157): `preferences` (no
 * project), or a project's `user`, `project` or `agent:<plugin>/<agent>` memory.
 */
export interface MemoryTarget {
  kind: string;
  project?: string;
}

/** One agent's memory in a project, as `listAgentMemories` lists it. */
export interface AgentMemoryView {
  agent: string;
  usage: MemoryUsage;
}

/** What a `memory_primed` item records: what the session was primed with (#157). */
export interface MemoryPrimedView {
  entries: PrimedEntry[];
  /** Entries the scans at load blocked: flagged to the user, never shown to the agent. */
  flagged: MemorySnapshot["flagged"];
  /** Files changed outside the memory service: skipped and reported, never rewritten. */
  skipped: MemorySnapshot["skipped"];
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
    | "limit_warning"
    | "rewind"
    | "memory_primed";
  role?: "user" | "assistant";
  text?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** A `tool_result` answering an approval the user denied. */
  denied?: true;
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
  /**
   * A `rewind` item (statewalker/statewalker-root#190), the first of the turn after a rewind or a
   * branch switch: where the head was and went, and the turns set aside. Its `text` tells the model.
   */
  rewind?: { previous: string | null; head: string | null; turns: string[] };
  /**
   * A `memory_primed` item (statewalker/statewalker-root#157): the memory the session was primed
   * with at its start or after a compaction, each entry's kind, id, version and tokens.
   */
  memory?: MemoryPrimedView;
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
  /**
   * A file change, a database action (`db`: the path is the database), or a tool call (`tool`: the
   * path is the tool's name, the content its arguments as JSON), or a memory batch (`memory`: the
   * path is the kind, the content its actions as JSON).
   */
  method: "write" | "mkdir" | "remove" | "copy" | "move" | "db" | "tool" | "limit" | "memory";
  path: string;
  /** A copy's or move's target. */
  target?: string;
  /** A write's content, a database action's (its encoded statement) or a tool's arguments, base64. */
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

/**
 * Where a turn comes from (statewalker/statewalker-root#190): run in this session, imported from
 * elsewhere, or copied by a fork.
 */
export type TurnOrigin = "run" | "imported" | "copied";

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
  /** The approval this turn continues the session with: a turn queued by answering it. */
  answers?: string;
  /** The turn's model usage, totalled over its requests (statewalker/statewalker-root#181). */
  usage?: UsageTotals;
  /**
   * The turn it follows in the session's tree (statewalker/statewalker-root#190): null for a first
   * turn, and for a turn not started yet (it follows the head when it starts).
   */
  parent_turn: string | null;
  origin: TurnOrigin;
  /** A copied turn: the turn it is a copy of. */
  copied_from?: TurnRef;
  created: number;
  started?: number;
  ended?: number;
  items: Item[];
}

/** Model usage totalled over requests: a turn's or a session's (statewalker/statewalker-root#181). */
export interface UsageTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** In the models' price unit; 0 when none has prices. */
  cost: number;
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
  /**
   * The items of the path from the first turn to this turn, instead of the active path (from the
   * first turn to the head; statewalker/statewalker-root#190).
   */
  branch?: string;
  /** Every item of the session, on every branch. */
  all?: boolean;
}

/**
 * A rewind (statewalker/statewalker-root#190): the head moves to the end of `to_turn` (null: before
 * the first turn), or before `before_turn` (to its parent).
 */
export interface RewindRequest {
  to_turn?: string | null;
  before_turn?: string;
  /** Cancels the running turn and the queued ones first; without it they refuse the rewind (409). */
  cancel_running?: boolean;
  /** Reverting files comes with statewalker/statewalker-root#191: refused until then. */
  revert_files?: boolean;
}

/** One effect of a rewound turn that a rewind does not revert: the tool call that made it. */
export interface TurnEffect {
  turn: string;
  /** The `tool_call` item. */
  item: string;
  name: string;
  args?: unknown;
}

/** What a rewind or a branch switch did. */
export interface RewindResult {
  head: string | null;
  previous: string | null;
  /** The turns no longer on the active path, oldest first. */
  rewound: string[];
  /** The running and queued turns `cancel_running` cancelled. */
  cancelled_turns: string[];
  /** The pending approvals of the rewound turns, now cancelled. */
  cancelled_approvals: string[];
  /** The sub-agent sessions the rewound turns started: stopped and archived. */
  stopped_children: string[];
  /** Listed, not reverted: the memory history allows a manual revert. */
  memory_writes: TurnEffect[];
  database_changes: TurnEffect[];
  /** Effects outside the harness (outbound requests of tools). */
  irreversible_effects: TurnEffect[];
}

/** One turn of the session's tree. */
export interface BranchTurn {
  id: string;
  parent_turn: string | null;
  origin: TurnOrigin;
  status: TurnStatus;
  created: number;
  /** On the active path (from the first turn to the head). */
  active: boolean;
  /** The turn's user message, shortened. */
  text?: string;
}

/** The session's tree of turns: every turn that ran, oldest first. */
export interface BranchesView {
  head: string | null;
  turns: BranchTurn[];
  /** The turns no other turn follows: where each branch ends. */
  leaves: string[];
}

export interface EditRequest {
  content: string;
  model?: string;
  revert_files?: boolean;
}

export interface RegenerateRequest {
  model?: string;
  revert_files?: boolean;
}

/** An edit or a regenerate: the rewind it recorded, and the message its new turn runs. */
export interface EditAccepted extends MessageAccepted {
  rewind: RewindResult;
}

/** A fork (statewalker/statewalker-root#190): from `at_turn`, with a first message if given. */
export interface ForkRequest {
  at_turn: string;
  message?: string;
  /** Another model the caller may use, for the fork. */
  model?: string;
}

export interface ForkResult {
  session: AgentSessionView;
  /** The first message, when the request carried one. */
  accepted?: MessageAccepted;
}

/** A turn as a fork copies it. */
export interface HistoryTurn {
  id: string;
  parent_turn: string | null;
  status: TurnStatus;
  delivery: Delivery;
  content: string;
  model_requested: string | null;
  stop_reason: string | null;
  error: string | null;
  model: string | null;
  ignored: string;
  created: number;
  started: number | null;
  ended: number | null;
  /** The approval an answer turn continues the session with. */
  answers?: { approval: string; decision: string; message: string | null };
  substitution?: ModelSubstitution;
}

/** A turn and its ancestors with their items and summaries: what a fork copies. */
export interface SessionHistory {
  session: string;
  at_turn: string;
  turns: HistoryTurn[];
  items: { seq: number; id: string; turn: string; kind: string; body: string }[];
  summaries: {
    id: string;
    depth: number;
    from_seq: number;
    to_seq: number;
    parent_id: string | null;
    content: string;
    sections: string | null;
    tokens: number;
    through_turn: string;
    created: number;
  }[];
  /** The source session's limits, which the fork keeps (counted afresh). */
  limits?: Limit[];
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
  /**
   * The names of the plugins pinned, broadest level first (deployment, workspace, project): the
   * order in which a skill name two plugins share goes to the first.
   */
  plugins?: string[];
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
  /**
   * Holds one concurrent stream of the caller (an SSE stream, a long poll) against the limits on
   * streams: its id, or ELIMIT (429) over one (statewalker/statewalker-root#179). Not served over
   * RPC: the API's own streams hold and release.
   */
  holdStream(): Promise<string>;
  /** Releases a held stream. */
  releaseStream(id: string): Promise<void>;
  /** `readEvents` for a stream that holds its own slot (an SSE stream): its long polls hold none. */
  readHeldEvents(sessionId: string, query?: EventsQuery): Promise<EventsPage>;
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
  /**
   * Moves the session's head (statewalker/statewalker-root#190): to the end of `to_turn` (null:
   * before the first turn) or before `before_turn`. The rewound turns stay as an inactive branch;
   * their pending approvals are cancelled and the sub-agents they started are stopped and archived.
   * A running turn refuses it (409) unless `cancel_running`. Owner only.
   */
  rewind(sessionId: string, req: RewindRequest): Promise<RewindResult>;
  /** Switches branch: the head moves to `turn` (null: before the first turn); 409 while a turn runs. */
  setHead(sessionId: string, req: { turn: string | null }): Promise<RewindResult>;
  /** Edits a turn's message: a rewind before it, then the edited message, a sibling turn. */
  editTurn(turnId: string, req: EditRequest): Promise<EditAccepted>;
  /** Runs a turn's message again, on another allowed model if given: a rewind plus a sibling turn. */
  regenerateTurn(turnId: string, req?: RegenerateRequest): Promise<EditAccepted>;
  /** The session's tree of turns. */
  listBranches(sessionId: string): Promise<BranchesView>;
  /** Erases an inactive branch: the turn and every turn after it (never the active path). */
  eraseBranch(sessionId: string, turnId: string): Promise<{ erased: string[] }>;
  /**
   * Forks one of the caller's top-level sessions at a turn of any branch: a new session with a
   * copy of that turn and its ancestors, the same agent, project and pinned definitions, and a
   * capability derived afresh. With `message`, fork and send are one step: a refused message
   * leaves no session.
   */
  forkSession(sessionId: string, req: ForkRequest): Promise<ForkResult>;
  /**
   * One JSON-RPC message to the session's own MCP endpoint (statewalker/statewalker-root#129): it
   * lists and calls exactly the tools the session's model is offered. Null for a notification.
   */
  mcp(sessionId: string, message: McpMessage): Promise<McpResponse | null>;
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
  /**
   * One kind of memory (statewalker/statewalker-root#157), as a person sees it: its entries (the
   * ones the scans block flagged), tombstones, attachments, usage and the files changed outside
   * the memory service. A kind or project the caller cannot reach answers ENOENT.
   */
  listMemory(target: MemoryTarget): Promise<KindView>;
  /** One entry with its earlier versions. */
  memoryEntry(target: MemoryTarget, id: string): Promise<EntryView & { history: EntryView[] }>;
  /** One attachment with its body. */
  memoryFile(target: MemoryTarget, name: string): Promise<FileView>;
  /** The memory tool's atomic batch, with the same rules, written by the caller. */
  memoryBatch(target: MemoryTarget, actions: MemoryAction[]): Promise<BatchResult>;
  /** Erases an entry (its history and tombstone too) or an attachment: only people erase. */
  eraseMemory(
    target: MemoryTarget,
    which: { id?: string; name?: string },
  ): Promise<{ erased: true }>;
  /** A project's agent memories. */
  listAgentMemories(project: string): Promise<{ agents: AgentMemoryView[] }>;
  /** The caller's whole profile as a ZIP of its Markdown files. */
  exportProfile(): Promise<Uint8Array>;
  /** Erases the caller's profile: their preferences and their user memory of every project. */
  eraseProfile(): Promise<{ erased: true }>;
  /**
   * Each limit that applies in the caller's context (statewalker/statewalker-root#181): the
   * workspace's, the member's and the user's own (their keys), a project's when one is named (the
   * caller must be a member), and one of the caller's sessions' when named (its project too), each
   * with what is used, reserved and left, and when it resets.
   */
  effectiveLimits(query?: EffectiveLimitsQuery): Promise<{ limits: LimitState[] }>;
  /**
   * Usage totals (statewalker/statewalker-root#181): the caller's own, a project's with
   * `usage.read:project`, the workspace's with `usage.read:workspace`, grouped by project, user,
   * agent, model or day. Usage under a user's own key shows its amounts to that user alone.
   */
  usage(query?: UsageQuery): Promise<UsageReport>;
  /**
   * The limits the caller manages at a level and target (statewalker/statewalker-root#181), with
   * `limits.write:<level>`: the workspace admin the workspace's, projects' and members'; a
   * project's owners its own and its sessions' defaults (target: the project); users their own
   * sessions' (target: the session) and their own keys' (`user`, target: themselves). Each only
   * adds to the broader levels': the tightest applies, and no one removes another's.
   */
  getLimits(level: string, target: string): Promise<LimitsView>;
  /** Replaces the limits the caller manages there: `{limits: [{meter, value, period?, …}]}`. */
  setLimits(level: string, target: string, req: { limits: unknown[] }): Promise<LimitsView>;
  deleteLimits(level: string, target: string): Promise<{ deleted: true }>;
  /**
   * A page of the token's workspace's usage records, for its admin (`usage.read:workspace`):
   * REST exports every page as NDJSON. Usage under users' own keys is never among them.
   */
  usageRecords(query?: UsageRecordsQuery): Promise<UsageRecordsPage>;
}

/** What a usage report is asked for (statewalker/statewalker-root#181). */
export interface UsageQuery {
  /**
   * `user` (the default): the caller's own usage in the token's workspace; `project`: a project's
   * (`usage.read:project`, or the workspace's); `workspace`: the workspace's (`usage.read:workspace`).
   */
  level?: "user" | "project" | "workspace";
  /** The project of a `project` report. */
  project?: string;
  /** The current window it sums (calendar days and months in the deployment's zone): month. */
  period?: "hour" | "day" | "month" | "total";
  group_by?: UsageGroupBy[];
}

/** Usage totals for one level and target over the period's current window, by group. */
export interface UsageReport {
  level: "user" | "project" | "workspace";
  /** The user, project or workspace reported on. */
  target: string;
  period: string;
  /** The window's start (ms since the epoch). */
  start: number;
  /** When the window ends; none for a total. */
  end?: number;
  group_by: UsageGroupBy[];
  /**
   * The totals of each group. Usage under a user's own key is its own group (`own_key`): with its
   * amounts for that user alone, without them for anyone else.
   */
  groups: UsageGroup[];
}

/** The limits one manager set at one level and target (statewalker/statewalker-root#181). */
export interface LimitsView {
  level: LimitLevel;
  target: string;
  limits: Limit[];
}

/**
 * One call managing the limits at a level and target: the workspace's (`workspace`, its name),
 * a project's (`project`; `session` for its sessions' defaults), a member's (`member`, the user)
 * or the caller's own keys (`user`, themselves). `set` replaces what the caller manages there.
 */
export interface LimitsCall {
  op: "get" | "set" | "delete";
  level: LimitLevel;
  target: string;
  /** For `set`: each with that level and target. */
  limits?: Limit[];
}

/** A page of the usage records export: created at or after `since` (ms), past seq `after`. */
export interface UsageRecordsQuery {
  since?: number;
  after?: number;
  /** At most 1000 (the default). */
  limit?: number;
}

export interface UsageRecordsPage {
  records: UsageRecord[];
  /** The `after` of the next page; none when this one is the last. */
  next?: number;
}

export interface EffectiveLimitsQuery {
  project?: string;
  session?: string;
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
  /** The plugins pinned at start, broadest level first (`PinnedDefinitions.plugins`). */
  plugins?: string[];
  /** A sub-agent's parent session. */
  parent?: string;
  /** A sub-agent's root session (statewalker/statewalker-root#126). */
  root?: string;
  /** A fork's source: the session and turn its history was copied from. */
  forked_from?: TurnRef;
  /**
   * The names of the tools the session may be offered (none: every tool). A sub-agent's are
   * always among its parent's.
   */
  tools?: string[];
  /** A sub-agent's own mode, beside the user session's: the gate applies the stricter. */
  mode?: string;
  /**
   * The session's limits (statewalker/statewalker-root#179): the broader levels' session
   * defaults (with a session started before #181, the start request's own too), all counted in
   * the agent session's DO.
   */
  limits?: Limit[];
  /**
   * The session's own limits from its start request (statewalker/statewalker-root#181): its
   * user replaces them later through the limits API, which leaves `limits` as they are.
   */
  ownLimits?: Limit[];
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
  /**
   * Starts a fork of one of the caller's top-level sessions (statewalker/statewalker-root#190): the
   * same agent, project and pinned definitions (and model, or another the caller may use), a
   * capability derived now, and the source's limits, counted afresh.
   */
  forkAgentSession(
    token: string,
    from: string,
    req: { at_turn: string; model?: string; limits?: Limit[] },
  ): Promise<{ session: AgentSessionView; config: AgentSessionConfig }>;
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
  holdStream(token: string): Promise<string>;
  releaseStream(token: string, id: string): Promise<void>;
  /** One memory call of the caller, on the kind it names (statewalker/statewalker-root#157). */
  memory(token: string, call: MemoryCall): Promise<unknown>;
  exportProfile(token: string): Promise<Uint8Array>;
  eraseProfile(token: string): Promise<{ erased: true }>;
  /** The limits on the caller's usage in the token's workspace (and a project), and their own. */
  effectiveLimits(token: string, query: { project?: string }): Promise<{ limits: LimitState[] }>;
  /** A usage report the caller may see; their own-key usage with its amounts at user level. */
  usage(token: string, query: UsageQuery): Promise<UsageReport>;
  /** One call on the limits the caller manages (a session's own are its agent session's). */
  manageLimits(token: string, call: LimitsCall): Promise<LimitsView>;
  /** A page of the workspace's usage records; EACCES unless the caller is its admin. */
  usageRecords(token: string, query: UsageRecordsQuery): Promise<UsageRecordsPage>;
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

/** A JSON-RPC 2.0 message to an MCP endpoint: a request (with an id) or a notification. */
export interface McpMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC 2.0 response of an MCP endpoint. */
export interface McpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A message as the MCP endpoint takes it: a JSON-RPC 2.0 envelope (EINVAL otherwise). */
export function mcpMessage(value: unknown): McpMessage {
  const m = (value ?? {}) as Record<string, unknown>;
  const id = m.id;
  if (
    m.jsonrpc !== "2.0" ||
    typeof m.method !== "string" ||
    !m.method ||
    (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") ||
    (m.params !== undefined &&
      (m.params === null || typeof m.params !== "object" || Array.isArray(m.params)))
  )
    throw codedError("EINVAL", "an MCP message is a JSON-RPC 2.0 request or notification");
  return {
    jsonrpc: "2.0",
    ...(id !== undefined ? { id: id as McpMessage["id"] } : {}),
    method: m.method,
    ...(m.params !== undefined ? { params: m.params as Record<string, unknown> } : {}),
  };
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
  /** The session's MCP endpoint: one JSON-RPC message, its answer (null for a notification). */
  mcp(message: McpMessage): Promise<McpResponse | null>;
  /** The session level's limits now, with what is used, reserved and left of each. */
  limits(): Promise<LimitState[]>;
  /** The session's model usage, totalled; none before its first request. */
  usage(): Promise<UsageTotals | undefined>;
  /** The session's own limits, which its user set: undefined reads them, a list replaces them. */
  ownLimits(limits?: Limit[]): Promise<Limit[]>;
  /** The turn tree (statewalker/statewalker-root#190). */
  rewind(req: RewindRequest): Promise<RewindResult>;
  setHead(turn: string | null): Promise<RewindResult>;
  edit(
    turnId: string,
    req: EditRequest,
  ): Promise<Omit<MessageAccepted, "stream_url"> & { rewind: RewindResult }>;
  regenerate(
    turnId: string,
    req?: RegenerateRequest,
  ): Promise<Omit<MessageAccepted, "stream_url"> & { rewind: RewindResult }>;
  branches(): Promise<BranchesView>;
  eraseBranch(turnId: string): Promise<{ erased: string[] }>;
  /** A turn and its ancestors with their items: what a fork copies. 409 while the turn runs. */
  exportPath(atTurn: string): Promise<SessionHistory>;
  /** Copies a history into this new session: its turns `copied`, the copy of `at_turn` the head. */
  importHistory(history: SessionHistory): Promise<{ head: string | null }>;
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

/** Where limits are managed (EINVAL otherwise; the deployment's are its LIMITS, set by no one). */
function limitsPlace(level: unknown, target: unknown): { level: LimitLevel; target: string } {
  if (!(LIMIT_LEVELS as readonly unknown[]).includes(level))
    throw codedError("EINVAL", `level is one of ${LIMIT_LEVELS.join(", ")}`);
  if (level === "deployment")
    throw codedError("EACCES", "the deployment's limits are its configuration (LIMITS)");
  if (typeof target !== "string" || !NAME.test(target))
    throw codedError("EINVAL", "target must be a name");
  return { level: level as LimitLevel, target };
}

/** The limits of a `set`, each at the place's level and target (EINVAL names the first problem). */
function limitsOfRequest(raw: unknown, place: { level: LimitLevel; target: string }): Limit[] {
  if (!Array.isArray(raw) || raw.length > 32)
    throw codedError("EINVAL", "limits is a list of at most 32 limits");
  const parsed = parseLimits(
    raw.map((l) => ({ ...((l ?? {}) as object), level: place.level, target: place.target })),
  );
  const problem = parsed.problems.find((p) => !p.includes("its period is total"));
  if (problem) throw codedError("EINVAL", problem);
  return parsed.limits;
}

/** A usage query as the API takes it (EINVAL otherwise); `group_by` may be a comma list. */
function usageQuery(query: unknown): UsageQuery {
  const q = (query ?? {}) as Record<string, unknown>;
  const level = q.level ?? "user";
  if (level !== "user" && level !== "project" && level !== "workspace")
    throw codedError("EINVAL", "level is user, project or workspace");
  const period = q.period ?? "month";
  if (!["hour", "day", "month", "total"].includes(String(period)))
    throw codedError("EINVAL", "period is hour, day, month or total");
  if (level === "project" && (typeof q.project !== "string" || !NAME.test(q.project)))
    throw codedError("EINVAL", "a project report names its project");
  const raw = q.group_by ?? [];
  const list = typeof raw === "string" ? raw.split(",").filter(Boolean) : raw;
  if (!Array.isArray(list) || list.some((g) => !(USAGE_GROUPS as readonly unknown[]).includes(g)))
    throw codedError("EINVAL", `group_by is a list of ${USAGE_GROUPS.join(", ")}`);
  return {
    level,
    ...(level === "project" ? { project: q.project as string } : {}),
    period: period as UsageQuery["period"],
    group_by: [...new Set(list as UsageGroupBy[])],
  };
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

const optionalBoolean = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw codedError("EINVAL", `${name} must be true or false`);
  return value;
};

const optionalModel = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value)
    throw codedError("EINVAL", "model must be a model's name");
  return value;
};

/** `{to_turn | before_turn, cancel_running?, revert_files?}`. */
function rewindRequest(req: unknown): RewindRequest {
  const { to_turn, before_turn, cancel_running, revert_files } = (req ?? {}) as Record<
    string,
    unknown
  >;
  if (to_turn !== undefined && to_turn !== null && (typeof to_turn !== "string" || !to_turn))
    throw codedError("EINVAL", "to_turn must be a turn's id, or null");
  if (before_turn !== undefined && (typeof before_turn !== "string" || !before_turn))
    throw codedError("EINVAL", "before_turn must be a turn's id");
  const cancel = optionalBoolean(cancel_running, "cancel_running");
  const revert = optionalBoolean(revert_files, "revert_files");
  return {
    ...(to_turn !== undefined ? { to_turn: to_turn as string | null } : {}),
    ...(before_turn !== undefined ? { before_turn: before_turn as string } : {}),
    ...(cancel !== undefined ? { cancel_running: cancel } : {}),
    ...(revert !== undefined ? { revert_files: revert } : {}),
  };
}

function editRequest(req: unknown): EditRequest {
  const { content, model, revert_files } = (req ?? {}) as Record<string, unknown>;
  if (typeof content !== "string" || !content)
    throw codedError("EINVAL", "content must be a non-empty string");
  const m = optionalModel(model);
  const revert = optionalBoolean(revert_files, "revert_files");
  return {
    content,
    ...(m ? { model: m } : {}),
    ...(revert !== undefined ? { revert_files: revert } : {}),
  };
}

function regenerateRequest(req: unknown): RegenerateRequest {
  const { model, revert_files } = (req ?? {}) as Record<string, unknown>;
  const m = optionalModel(model);
  const revert = optionalBoolean(revert_files, "revert_files");
  return { ...(m ? { model: m } : {}), ...(revert !== undefined ? { revert_files: revert } : {}) };
}

function forkRequest(req: unknown): ForkRequest {
  const { at_turn, message, model } = (req ?? {}) as Record<string, unknown>;
  if (typeof at_turn !== "string" || !at_turn)
    throw codedError("EINVAL", "at_turn must be a turn's id");
  if (message !== undefined && (typeof message !== "string" || !message))
    throw codedError("EINVAL", "message must be a non-empty string");
  const m = optionalModel(model);
  return {
    at_turn,
    ...(message !== undefined ? { message: message as string } : {}),
    ...(m ? { model: m } : {}),
  };
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

/** Where an accepted message's turn is followed: its events, ending with the terminal one. */
const streamUrl = (session: string, turn: string, offset: number) =>
  `/v1/sessions/${encodeURIComponent(session)}/events?since=${offset}&turn=${encodeURIComponent(turn)}`;

export function createSessionApi(token: string, ports: SessionApiPorts): SessionApi {
  const own = (id: unknown) => ports.user.ownAgentSession(token, String(id));
  /** A session's own limits are its agent session's; every other place is managed by the user's DO. */
  const manage = async (call: LimitsCall): Promise<LimitsView> => {
    if (call.level !== "session" || !call.target.startsWith("as-"))
      return ports.user.manageLimits(token, call);
    const session = await own(call.target);
    const agent = ports.agent(session.id);
    const limits =
      call.op === "get" ? await agent.ownLimits() : await agent.ownLimits(call.limits ?? []);
    return { level: "session", target: session.id, limits };
  };
  /** Archives a session and its sub-agents: revoked first, so no new sub-agent joins the tree. */
  const archiveTree = async (id: string): Promise<AgentSessionView> => {
    const archived = await ports.user.archiveAgentSession(token, id);
    const [, ...descendants] = await ports.user.subtree(token, id);
    await ports.agent(id).archive();
    for (const sid of descendants)
      await ports
        .agent(sid)
        .archive()
        // A sub-agent whose DO never started has nothing to stop.
        .catch(() => {});
    return archived;
  };
  /** The sub-agents rewound turns started are stopped and archived (statewalker/statewalker-root#190). */
  const stopChildren = async <T extends { stopped_children: string[] }>(result: T): Promise<T> => {
    for (const child of result.stopped_children) await archiveTree(child).catch(() => {});
    return result;
  };
  /** A session that may take a message: archived 409 (before revoked), revoked 403. */
  const open = (session: AgentSessionView) => {
    if (session.archived) throw codedError("EBUSY", "the agent session is archived");
    if (session.revoked) throw codedError("EACCES", "the agent session is revoked");
    return session;
  };
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
    async getSession(id) {
      const session = await withStatus(await own(id));
      const usage = await ports.agent(session.id).usage();
      return usage ? { ...session, usage } : session;
    },
    async updateSession(id, req) {
      const metadata = metadataOf((req as { metadata?: unknown } | undefined)?.metadata ?? {});
      const session = await own(id);
      return ports.user.updateAgentSession(token, session.id, metadata);
    },
    async archiveSession(id) {
      const session = await own(id);
      // Revoked first, so no new sub-agent joins the tree; then every session of it stops.
      return withStatus(await archiveTree(session.id));
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
      const q = (query ?? {}) as EventsQuery;
      // A long poll is a stream while it waits (#179).
      if (!(Number(q.wait) > 0)) return ports.agent(session.id).events(q);
      const held = await ports.user.holdStream(token);
      try {
        return await ports.agent(session.id).events(q);
      } finally {
        await ports.user.releaseStream(token, held).catch(() => {});
      }
    },
    async readHeldEvents(sessionId, query) {
      const session = await own(sessionId);
      return ports.agent(session.id).events((query ?? {}) as EventsQuery);
    },
    holdStream: () => ports.user.holdStream(token),
    releaseStream: async (id) => ports.user.releaseStream(token, String(id)),
    async rewind(sessionId, req) {
      const r = rewindRequest(req);
      const session = await own(sessionId);
      return stopChildren(await ports.agent(session.id).rewind(r));
    },
    async setHead(sessionId, req) {
      const turn = (req as { turn?: unknown } | undefined)?.turn;
      if (turn !== null && (typeof turn !== "string" || !turn))
        throw codedError("EINVAL", "turn must be a turn's id, or null");
      const session = await own(sessionId);
      return stopChildren(await ports.agent(session.id).setHead(turn));
    },
    async editTurn(turnId, req) {
      const r = editRequest(req);
      const session = open(await own(sessionOfTurn(String(turnId))));
      const accepted = await ports.agent(session.id).edit(String(turnId), r);
      await stopChildren(accepted.rewind);
      return { ...accepted, stream_url: streamUrl(session.id, accepted.turn_id, accepted.offset) };
    },
    async regenerateTurn(turnId, req) {
      const r = regenerateRequest(req);
      const session = open(await own(sessionOfTurn(String(turnId))));
      const accepted = await ports.agent(session.id).regenerate(String(turnId), r);
      await stopChildren(accepted.rewind);
      return { ...accepted, stream_url: streamUrl(session.id, accepted.turn_id, accepted.offset) };
    },
    async listBranches(sessionId) {
      const session = await own(sessionId);
      return ports.agent(session.id).branches();
    },
    async eraseBranch(sessionId, turnId) {
      const session = await own(sessionId);
      return ports.agent(session.id).eraseBranch(String(turnId));
    },
    async forkSession(sessionId, req) {
      const r = forkRequest(req);
      const message = r.message === undefined ? undefined : messageOf({ content: r.message });
      const source = await own(sessionId);
      if (source.parent) throw codedError("EINVAL", "only a top-level session can be forked");
      const history = await ports.agent(source.id).exportPath(r.at_turn);
      const { session, config } = await ports.user.forkAgentSession(token, source.id, {
        at_turn: history.at_turn,
        ...(r.model ? { model: r.model } : {}),
        ...(history.limits?.length ? { limits: history.limits } : {}),
      });
      const agent = ports.agent(session.id);
      try {
        await agent.start(config);
        await agent.importHistory(history);
        if (!message) return { session };
        const accepted = await agent.send(message);
        return {
          session,
          accepted: {
            ...accepted,
            stream_url: streamUrl(session.id, accepted.turn_id, accepted.offset),
          },
        };
      } catch (e) {
        // Fork and send are one step: a refused message leaves no session behind.
        await agent.purge().catch(() => {});
        await ports.user.deleteAgentSession(token, session.id).catch(() => {});
        throw e;
      }
    },
    async mcp(sessionId, message) {
      const checked = mcpMessage(message);
      const session = await own(sessionId);
      if (session.archived) throw codedError("EBUSY", "the agent session is archived");
      if (session.revoked) throw codedError("EACCES", "the agent session is revoked");
      return ports.agent(session.id).mcp(checked);
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
    listMemory: async (target) =>
      ports.user.memory(token, { op: "list", ...memoryTarget(target) }) as Promise<KindView>,
    memoryEntry: async (target, id) =>
      ports.user.memory(token, {
        op: "entry",
        ...memoryTarget(target),
        id: String(id),
      }) as Promise<EntryView & { history: EntryView[] }>,
    memoryFile: async (target, name) =>
      ports.user.memory(token, {
        op: "file",
        ...memoryTarget(target),
        name: String(name),
      }) as Promise<FileView>,
    memoryBatch: async (target, actions) => {
      if (!Array.isArray(actions) || actions.length === 0)
        throw codedError("EINVAL", "actions is a non-empty list");
      return ports.user.memory(token, {
        op: "batch",
        ...memoryTarget(target),
        actions,
      }) as Promise<BatchResult>;
    },
    eraseMemory: async (target, which) => {
      const w = (which ?? {}) as { id?: unknown; name?: unknown };
      if (typeof w.id !== "string" && typeof w.name !== "string")
        throw codedError("EINVAL", "erase names an entry (id) or an attachment (name)");
      return ports.user.memory(token, {
        op: "erase",
        ...memoryTarget(target),
        ...(typeof w.id === "string" ? { id: w.id } : { name: String(w.name) }),
      }) as Promise<{ erased: true }>;
    },
    listAgentMemories: async (project) => {
      if (typeof project !== "string" || !project)
        throw codedError("EINVAL", "project must be a project's name");
      return ports.user.memory(token, { op: "agents", project }) as Promise<{
        agents: AgentMemoryView[];
      }>;
    },
    exportProfile: () => ports.user.exportProfile(token),
    eraseProfile: () => ports.user.eraseProfile(token),
    usage: async (query) => ports.user.usage(token, usageQuery(query)),
    async usageRecords(query) {
      const q = (query ?? {}) as Record<string, unknown>;
      const num = (k: string) => {
        if (q[k] === undefined || q[k] === "") return undefined;
        const n = Number(q[k]);
        if (!Number.isFinite(n) || n < 0) throw codedError("EINVAL", `${k} is a number`);
        return n;
      };
      const since = num("since");
      const after = num("after");
      const limit = num("limit");
      return ports.user.usageRecords(token, {
        ...(since !== undefined ? { since } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    },
    async getLimits(level, target) {
      return manage({ op: "get", ...limitsPlace(level, target) });
    },
    async setLimits(level, target, req) {
      const place = limitsPlace(level, target);
      const raw = (req as { limits?: unknown } | undefined)?.limits;
      return manage({ op: "set", ...place, limits: limitsOfRequest(raw, place) });
    },
    async deleteLimits(level, target) {
      await manage({ op: "delete", ...limitsPlace(level, target) });
      return { deleted: true as const };
    },
    async effectiveLimits(query) {
      const q = (query ?? {}) as Record<string, unknown>;
      for (const k of ["project", "session"] as const)
        if (q[k] !== undefined && (typeof q[k] !== "string" || !NAME.test(q[k] as string)))
          throw codedError("EINVAL", `${k} must be a ${k}'s name`);
      const session = typeof q.session === "string" ? await own(q.session) : undefined;
      const project = session?.project ?? (q.project as string | undefined);
      if (session && q.project !== undefined && q.project !== session.project)
        throw codedError("EINVAL", "the session is in another project");
      const { limits } = await ports.user.effectiveLimits(token, project ? { project } : {});
      return {
        limits: session ? [...limits, ...(await ports.agent(session.id).limits())] : limits,
      };
    },
  };
}

/** A memory target as the API takes it (EINVAL otherwise). */
function memoryTarget(target: unknown): MemoryTarget {
  const t = (target ?? {}) as Record<string, unknown>;
  if (typeof t.kind !== "string" || !t.kind) throw codedError("EINVAL", "kind is required");
  if (t.project !== undefined && typeof t.project !== "string")
    throw codedError("EINVAL", "project must be a project's name");
  return { kind: t.kind, ...(typeof t.project === "string" ? { project: t.project } : {}) };
}
