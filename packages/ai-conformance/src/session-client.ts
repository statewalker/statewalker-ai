// The session API as a client sees it, over REST. Scenarios are written against `SessionClient`,
// so the same scenario runs over every transport (REST here, RPC in ./rpc-client.ts).
import type {
  ChatTransportLike,
  EventsPage,
  EventsQuery,
  ItemsQuery,
  MessageAccepted,
  Metadata,
  SessionEvent,
  SessionsQuery,
  StopReason,
  UIMessageChunk,
} from "@statewalker/ai-sessions";
import { DefaultChatTransport } from "ai";
import type { Deployment } from "./deployment.js";

export type {
  ChatTransportLike,
  EventsPage,
  EventsQuery,
  ItemsQuery,
  MessageAccepted,
  Metadata,
  SessionEvent,
  SessionsQuery,
  StopReason,
  UIMessageChunk,
};

/** An item of a turn, as the session API lists it. */
export interface Item {
  seq: number;
  id: string;
  turn: string;
  kind:
    | "message"
    | "tool_call"
    | "tool_result"
    | "approval"
    | "model_fallback"
    | "mode_decision"
    | "limit_warning"
    | "rewind"
    | "memory_primed"
    | "question";
  role?: "user" | "assistant";
  text?: string;
  callId?: string;
  /** Produced by a remote agent session's external harness: untrusted, never classified. */
  external?: true;
  /** A `tool_result` answering an approval the user denied. */
  denied?: true;
  /** An `approval` or `question` item's request (`input`: a remote harness's question). */
  request?: {
    id: string;
    action: { method: string; path: string };
    permission: string;
    reason: string;
    input?: { kind: string; prompt: string; options?: { id: string; label?: string }[] };
  };
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  /** The approval an `approval` item waits on, or a resumed `tool_result` answers. */
  approval?: string;
  /** The names of the secrets a tool call used (never their values). */
  secrets?: string[];
  /** A user message that steered a running turn. */
  steer?: string;
  /** The partial assistant message of a turn cut short. */
  incomplete?: true;
  /**
   * The model request that produced the item (on the first item of each answer), or that failed
   * (on a `model_fallback` item).
   */
  usage?: ModelUsage;
  /** A `model_fallback` item: the model that failed, the one tried next, and why. */
  from?: string;
  to?: string;
  reason?: string;
  /** A `mode_decision` item (auto mode): the step that decided, and its verdict. */
  step?: "rule" | "safe" | "classifier" | "approval" | "mode";
  verdict?: "allow" | "ask" | "deny";
  /** A `mode_decision` item: the action decided. */
  action?: { method: string; path: string; target?: string; size?: number };
  /** A classifier's decision: its model and how long it took. */
  model?: string;
  latency_ms?: number;
  /** Set on the denial after which the session fell back to this mode. */
  fallback?: string;
  /** A `limit_warning` item: the limit whose warning share usage crossed. */
  warning?: {
    meter: string;
    level: string;
    target: string;
    limit_level: string;
    period: string;
    used: number;
    value: number;
    warn_at: number;
  };
  /** A `memory_primed` item: what the session was primed with (statewalker/statewalker-root#157). */
  memory?: {
    entries: { kind: string; id: string; version: number; tokens: number }[];
    flagged: { kind: string; id: string; reason: string }[];
    skipped: { kind: string; path: string; reason: string }[];
  };
}

/** Who wrote a memory entry: stamped by the server. */
export interface MemoryWriter {
  user: string;
  agent?: string;
  session?: string;
}

/** One memory entry, as the memory API shows it. */
export interface MemoryEntry {
  id: string;
  version: number;
  supersedes?: number | null;
  written_by: MemoryWriter;
  created: string;
  modified: string;
  type: string;
  title?: string;
  status: string;
  body: string;
  forgotten_at?: string;
  forgotten_by?: MemoryWriter;
  blocked?: string;
}

export interface MemoryUsage {
  entries: { used: number; cap: number; count: number };
  files: { used: number; cap: number; file_cap: number; count: number };
}

/** One kind of memory, as the memory API lists it. */
export interface MemoryKindView {
  kind: string;
  entries: MemoryEntry[];
  forgotten: MemoryEntry[];
  files: { id: string; name: string; description?: string; body?: string }[];
  usage: MemoryUsage;
  skipped: { path: string; reason: string }[];
}

export interface MemoryBatchResult {
  kind: string;
  results: { op: string; id?: string; version?: number; name?: string; body?: string }[];
  usage: MemoryUsage;
}

/** Which memory a call names: `preferences`, or a project's `user`, `project`, `agent:<p>/<a>`. */
export interface MemoryTarget {
  kind: string;
  project?: string;
}

/** One request to a model, metered. */
export interface ModelUsage {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** In the model's price unit, when it has prices. */
  cost?: number;
  latency_ms: number;
  outcome: "ok" | "overloaded" | "rate_limited" | "unavailable" | "error" | "aborted";
  /** Charged to the workspace's budget; false for the user's own provider. */
  charged: boolean;
}

/** An action waiting on the user's answer, as the session API lists it. */
export interface Approval {
  id: string;
  session: string;
  workspace: string;
  project: string;
  /** The stored action: the file method and its normalised path (and the size of a write). */
  action: { method: string; path: string; size?: number };
  /** The permission asked for, with its target relative to the project. */
  permission: string;
  /** Why the mode or a rule asks. */
  reason: string;
  status: "pending" | "allowed" | "denied" | "expired" | "blocked" | "cancelled";
  created: number;
  expires: number;
}

export interface ApprovalAnswer {
  decision: "allow" | "deny";
  scope: "once" | "session";
  message?: string;
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
  /** The pending approvals of the user's agent sessions in this workspace. */
  approvals?: Approval[];
  /** Actions auto mode's risk classifier blocked recently: approving one retries it. */
  blocked?: Approval[];
}

export interface AgentSession {
  id: string;
  project: string;
  agent: string;
  workspace: string;
  unattended: boolean;
  revoked: boolean;
  metadata: Metadata;
  archived?: number;
  status?: "idle" | "running" | "waiting" | "error";
  /** The session that started it with `agent.start` (a sub-agent). */
  parent?: string;
  /** The root of its tree: the session the user started. */
  root?: string;
  /** The session's model usage, totalled over its turns (single-session reads). */
  usage?: UsageTotals;
  /** A fork's source: the session and turn its history was copied from. */
  forked_from?: { session: string; turn: string };
}

/** A rewind's or a branch switch's result. */
export interface RewindResult {
  head: string | null;
  previous: string | null;
  rewound: string[];
  cancelled_turns: string[];
  cancelled_approvals: string[];
  stopped_children: string[];
  memory_writes: { turn: string; item: string; name: string; args?: unknown }[];
  database_changes: { turn: string; item: string; name: string; args?: unknown }[];
  irreversible_effects: { turn: string; item: string; name: string; args?: unknown }[];
}

/** The session's tree of turns. */
export interface Branches {
  head: string | null;
  turns: {
    id: string;
    parent_turn: string | null;
    origin: string;
    status: string;
    created: number;
    active: boolean;
    text?: string;
  }[];
  leaves: string[];
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
  /** The user's preferences. */
  preferences: MemoryEntry[];
  /** The projects the profile holds user memory of, with the user's state there. */
  projects: { workspace: string; project: string; state?: "member" | "left" | "gone" }[];
}

/** A model as the session API lists it for a project (statewalker/statewalker-root#134). */
export interface ModelView {
  /** `<provider>/<model>`. */
  id: string;
  /** The aliases that pick it in the project (the most specific level's). */
  aliases: string[];
  provider: string;
  /** The level that configured it; a discovered model's provider's level. */
  level: "deployment" | "workspace" | "project" | "user";
  /** Configured at some level: discovered models are off until a level lists them. */
  enabled: boolean;
  /** The caller holds its right (`models.use`). */
  allowed: boolean;
  /** Found through the provider's `/models` endpoint. */
  discovered?: true;
}

/** One level's model configuration: providers and models it adds, models it narrows to. */
export interface ModelsConfig {
  providers?: {
    id: string;
    api: string;
    baseUrl: string;
    headers?: Record<string, string>;
    secret?: string;
  }[];
  models?: Record<string, unknown>[];
  allow?: string[];
  default?: string;
}

/** One limit as it applies to the caller's context now (statewalker/statewalker-root#181). */
export interface LimitState {
  meter: string;
  level: string;
  target: string;
  /** The limit's own level: a deployment ceiling held by a workspace says `deployment`. */
  limit_level: string;
  period: string;
  on_exceed: string;
  warn_at: number;
  value: number;
  used: number;
  reserved: number;
  remaining: number;
  /** When the window resets (ms since the epoch); none for a total. */
  reset?: number;
}

/** What a usage report is asked for (statewalker/statewalker-root#181). */
export interface UsageQuery {
  level?: "user" | "project" | "workspace";
  project?: string;
  period?: "hour" | "day" | "month" | "total";
  group_by?: ("project" | "user" | "agent" | "model" | "day")[];
}

/** Usage totals of one group: what it is keyed by, and each meter's amount. */
export interface UsageGroup {
  key: { project?: string; user?: string; agent?: string; model?: string; day?: string };
  /** None for usage under a user's own key seen by anyone but that user. */
  usage?: Record<string, number>;
  own_key?: true;
}

export interface UsageReport {
  level: string;
  target: string;
  period: string;
  start: number;
  end?: number;
  group_by: string[];
  groups: UsageGroup[];
}

/** One request to a model, as the workspace's budget recorded it (test-only admin route). */
export interface ModelUsageRecord {
  session: string;
  turn?: string;
  user: string;
  project: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost?: number;
  latency_ms: number;
  outcome: string;
  charged: boolean;
}

export interface Turn {
  id: string;
  session: string;
  status: string;
  delivery: string;
  stop_reason?: StopReason;
  error?: string;
  model?: string;
  model_substitution?: { requested: string; used: string; reason: string };
  ignored?: string[];
  /** The approval this turn continues the session with (an answer turn). */
  answers?: string;
  /** The turn's model usage, totalled over its requests. */
  usage?: UsageTotals;
  /** The turn it follows in the session's tree (null: a first turn). */
  parent_turn: string | null;
  origin: "run" | "imported" | "copied";
  copied_from?: { session: string; turn: string };
  items: Item[];
}

/** Model usage totalled over requests (statewalker/statewalker-root#181). */
export interface UsageTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost: number;
}

export interface ItemsPage {
  items: Item[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

/** A message request; any other field is reported as ignored. */
export type MessageRequest = {
  content: string;
  delivery?: "next" | "steer" | "interrupt";
  model?: string;
} & Record<string, unknown>;

/** The event types a turn ends with; the event carries the full turn. */
export const TERMINAL_EVENTS = [
  "turn.waiting",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.incomplete",
];

/** A JSON-RPC 2.0 message of MCP (a request or a notification). */
export interface McpMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 response of MCP. */
export interface McpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface SessionClient {
  me(): Promise<UserSession>;
  startSession(req: {
    project: string;
    agent?: string;
    metadata?: Metadata;
    unattended?: boolean;
    /** A model (an id or an alias) the session runs on instead of the agent's, within rights. */
    model?: string;
    /** The session's own limits (session level). */
    limits?: Record<string, unknown>[];
  }): Promise<AgentSession>;
  getSession(id: string): Promise<AgentSession>;
  updateSession(id: string, req: { metadata: Metadata }): Promise<AgentSession>;
  archiveSession(id: string): Promise<AgentSession>;
  deleteSession(id: string): Promise<{ deleted: true }>;
  /** The caller's agent sessions in the workspace their token names, from the session index. */
  listSessions(query?: SessionsQuery): Promise<{ sessions: AgentSession[] }>;
  /** Posts a message: accepted (REST `202`), the turn runs on its own. */
  postMessage(sessionId: string, req: MessageRequest): Promise<MessageAccepted>;
  /** Posts a message and follows its turn's events to the terminal one: the full turn. */
  sendMessage(sessionId: string, req: MessageRequest): Promise<Turn>;
  /** Follows an accepted message's turn to its terminal event, and returns the full turn. */
  waitTurn(accepted: MessageAccepted): Promise<Turn>;
  getTurn(turnId: string): Promise<Turn>;
  cancelTurn(turnId: string): Promise<Turn>;
  listItems(sessionId: string, query?: ItemsQuery): Promise<ItemsPage>;
  getItem(sessionId: string, itemId: string): Promise<Item>;
  /** Reads the event log after `since` up to its end. */
  readEvents(sessionId: string, query?: EventsQuery): Promise<EventsPage>;
  profile(): Promise<Profile>;
  /** Erases the caller: their profile and their User DO's storage. */
  eraseUser(): Promise<{ erased: true }>;
  /** Switches the user session's mode; it reaches running agent sessions at their next action. */
  setMode(req: { mode: string }): Promise<UserSession>;
  /** The approvals of the caller's agent sessions in the workspace, pending or answered. */
  listApprovals(): Promise<{ approvals: Approval[] }>;
  /**
   * Answers an approval: the answer continues the agent session as a turn (the stored action runs
   * again, re-checked, or the denial is told), accepted like a message.
   */
  answerApproval(
    id: string,
    answer: ApprovalAnswer,
  ): Promise<{ approval: Approval; accepted: MessageAccepted }>;
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
  /** The models of a project as the caller sees them; `discover` asks each provider's `/models`. */
  listModels(query: { project: string; discover?: boolean }): Promise<{ models: ModelView[] }>;
  /** The caller's own model configuration (user level) in the token's workspace. */
  getModelConfig(): Promise<ModelsConfig>;
  /** Replaces the caller's own model configuration (user level). */
  setModelConfig(config: ModelsConfig): Promise<ModelsConfig>;
  /**
   * A chat transport (the AI SDK's `ChatTransport`) on one agent session's UI message stream: over
   * REST the AI SDK's own HTTP transport at `/v1/sessions/<id>/chat` (chat id: the session id),
   * over RPC the session API's transport.
   */
  chat(sessionId: string): ChatTransportLike;
  /**
   * Resumes a session's UI message stream (REST: `GET /v1/sessions/<id>/chat/stream`): a turn's
   * message replayed from the log, or what follows a cursor; null when there is nothing to follow.
   */
  replayChat(
    sessionId: string,
    from?: { turn?: string; since?: number },
  ): Promise<ReadableStream<UIMessageChunk> | null>;
  /**
   * What an OpenAI client takes to drive an agent through the OpenAI projection
   * (statewalker/statewalker-root#138): the agent's base URL (`/v1/projects/<p>/agents/<a>/`), the
   * key (the access token) and a fetch: over REST the deployment's, over RPC the projection run
   * here over the session API's methods.
   */
  openai(project: string, agent?: string): OpenAiClientOptions;
  /**
   * What a UHP client takes to drive harness agents through the UHP projection
   * (statewalker/statewalker-root#139): the base URL (`/uhp`, the suite appends `/v1/...`), the
   * key (the access token) and a fetch: over REST the deployment's, over RPC the projection run
   * here over the session API's methods.
   */
  uhp(): OpenAiClientOptions;
  /**
   * One message to an agent session's own MCP endpoint (`POST /v1/sessions/{id}/mcp`, JSON
   * responses): its answer, or null for a notification.
   */
  mcp(sessionId: string, message: McpMessage): Promise<McpResponse | null>;
  /** The turn tree: `POST /v1/sessions/{id}/rewind`. */
  rewind(
    sessionId: string,
    req: { to_turn?: string | null; before_turn?: string; cancel_running?: boolean },
  ): Promise<RewindResult>;
  /** `PUT /v1/sessions/{id}/head`. */
  setHead(sessionId: string, req: { turn: string | null }): Promise<RewindResult>;
  /** `POST /v1/turns/{id}/edit` (REST `202`). */
  editTurn(
    turnId: string,
    req: { content: string; model?: string },
  ): Promise<MessageAccepted & { rewind: RewindResult }>;
  /** `POST /v1/turns/{id}/regenerate` (REST `202`). */
  regenerateTurn(
    turnId: string,
    req?: { model?: string },
  ): Promise<MessageAccepted & { rewind: RewindResult }>;
  /** `GET /v1/sessions/{id}/branches`. */
  listBranches(sessionId: string): Promise<Branches>;
  /** `DELETE /v1/sessions/{id}/branches/{turn}`. */
  eraseBranch(sessionId: string, turnId: string): Promise<{ erased: string[] }>;
  /** `POST /v1/sessions/{id}/fork` (REST `201`). */
  forkSession(
    sessionId: string,
    req: { at_turn: string; message?: string; model?: string },
  ): Promise<{ session: AgentSession; accepted?: MessageAccepted }>;
  /** One kind of memory (`/v1/me/preferences`, `/v1/projects/{p}/memory/{kind}`). */
  listMemory(target: MemoryTarget): Promise<MemoryKindView>;
  memoryEntry(target: MemoryTarget, id: string): Promise<MemoryEntry & { history: MemoryEntry[] }>;
  memoryFile(target: MemoryTarget, name: string): Promise<{ name: string; body?: string }>;
  /** The memory tool's atomic batch, through the memory API. */
  memoryBatch(target: MemoryTarget, actions: Record<string, unknown>[]): Promise<MemoryBatchResult>;
  eraseMemory(
    target: MemoryTarget,
    which: { id?: string; name?: string },
  ): Promise<{ erased: true }>;
  listAgentMemories(project: string): Promise<{ agents: { agent: string; usage: MemoryUsage }[] }>;
  /** `GET /v1/me/profile/export`: a ZIP of the profile's Markdown files. */
  exportProfile(): Promise<Uint8Array>;
  /** `DELETE /v1/me/profile`. */
  eraseProfile(): Promise<{ erased: true }>;
  /** `GET /v1/limits/effective`: each limit of the caller's context, with what is left. */
  effectiveLimits(query?: {
    project?: string;
    session?: string;
  }): Promise<{ limits: LimitState[] }>;
  /** `GET /v1/usage?level&project&period&group_by`: usage totals the caller may see. */
  usage(query?: UsageQuery): Promise<UsageReport>;
  /** `GET /v1/limits/{level}/{target}`: the limits the caller manages there. */
  getLimits(level: string, target: string): Promise<LimitsView>;
  /** `PUT /v1/limits/{level}/{target}`: replaces them. */
  setLimits(
    level: string,
    target: string,
    req: { limits: Record<string, unknown>[] },
  ): Promise<LimitsView>;
  /** `GET /v1/usage/records?since` (NDJSON): the workspace's usage records, for its admin. */
  usageRecords(query?: { since?: number }): Promise<UsageRecordView[]>;
  /** `DELETE /v1/limits/{level}/{target}`: removes them. */
  deleteLimits(level: string, target: string): Promise<{ deleted: true }>;
}

/** One usage record, as the export has it. */
export interface UsageRecordView {
  seq: number;
  workspace: string;
  project: string;
  user: string;
  session?: string;
  turn?: string;
  meter: string;
  amount: number;
  detail?: Record<string, unknown>;
  created: number;
}

/** The limits one manager set at one level and target. */
export interface LimitsView {
  level: string;
  target: string;
  limits: (Record<string, unknown> & { meter: string; value: number; level: string })[];
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

/** Checks a response is the AI SDK's UI message stream, by its headers. */
export function expectUiStream(res: Response): void {
  if (
    res.headers.get("x-vercel-ai-ui-message-stream") !== "v1" ||
    !res.headers.get("content-type")?.startsWith("text/event-stream")
  )
    throw new ApiError(500, "not an AI SDK UI message stream");
}

/** The chunks of a UI message stream's SSE body (`data: <json>` frames up to `data: [DONE]`). */
export function uiChunks(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const frames = sseFrames(body);
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        const { value, done } = await frames.next();
        if (done || value.data === "[DONE]") {
          controller.close();
          return;
        }
        if (value.data !== undefined) {
          controller.enqueue(JSON.parse(value.data) as UIMessageChunk);
          return;
        }
      }
    },
    async cancel() {
      await frames.return(undefined);
    },
  });
}

/** One frame of an SSE stream: an event (with its id, if any), or a comment (a keep-alive). */
export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** The frames of an SSE response body, as they arrive. Cancel the reader to disconnect. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const frame: SseFrame = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) frame.comment = line.slice(1).trim();
          else {
            const i = line.indexOf(":");
            const field = i < 0 ? line : line.slice(0, i);
            const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
            if (field === "data")
              frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
            else if (field === "id" || field === "event") frame[field] = value;
          }
        }
        yield frame;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** An SSE frame as a logged event (frames without an id are markers or keep-alives). */
export const eventOf = (frame: SseFrame): SessionEvent | undefined =>
  frame.id && frame.event
    ? {
        seq: Number(frame.id),
        type: frame.event,
        data: JSON.parse(frame.data ?? "null"),
        created: 0,
      }
    : undefined;

const itemsSearch = (q: ItemsQuery = {}) => {
  const p = new URLSearchParams();
  for (const k of ["after", "before", "limit", "order"] as const)
    if (q[k] !== undefined) p.set(k, String(q[k]));
  for (const t of q.types ?? []) p.append("types[]", t);
  if (q.branch) p.set("branch", q.branch);
  if (q.all) p.set("all", "true");
  const s = p.toString();
  return s ? `?${s}` : "";
};

const limitsPath = (level: string, target: string) =>
  `/v1/limits/${encodeURIComponent(level)}/${encodeURIComponent(target)}`;

/** A query string of the defined values. */
const search = (q: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const sessionsSearch = (q: SessionsQuery = {}) => {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  for (const [k, v] of Object.entries(q.metadata ?? {})) p.set(`metadata.${k}`, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

/**
 * Where a memory target is over REST: `/v1/me/preferences/entries`, or
 * `/v1/projects/{p}/memory/{kind}` (an agent's kind `agent:<plugin>/<agent>` as two segments).
 */
function memoryPath(target: MemoryTarget): string {
  if (target.kind === "preferences" && target.project === undefined) return "/v1/me/preferences";
  const kind = target.kind
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/v1/projects/${encodeURIComponent(target.project ?? "")}/memory/${kind}`;
}

/** Where a kind's entries are listed and batched: preferences at `/v1/me/preferences/entries`. */
const memoryCollection = (target: MemoryTarget): string =>
  target.kind === "preferences" && target.project === undefined
    ? "/v1/me/preferences/entries"
    : memoryPath(target);

/** An OpenAI SDK client's options for one agent's base URL. */
export interface OpenAiClientOptions {
  baseURL: string;
  apiKey: string;
  fetch: typeof fetch;
}

/** An agent's base URL in the OpenAI projection; a `<plugin>/<agent>` id spans two segments. */
export const openAiBaseUrl = (project: string, agent = "default") =>
  `http://localhost/v1/projects/${encodeURIComponent(project)}/agents/${agent
    .split("/")
    .map(encodeURIComponent)
    .join("/")}/`;

/** The UHP projection's base URL: its routes are `<base>/v1/...`. */
export const UHP_BASE_URL = "http://localhost/uhp";

export function restClient(deployment: Deployment, token: string): SessionClient {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = <T>(method: string, path: string, body?: unknown) =>
    deployment
      .fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      .then((res) => answer<T>(res));
  const stream = async (path: string) => {
    const res = await deployment.fetch(path, { headers });
    if (!res.ok || !res.body) await answer(res);
    return sseFrames(res.body as ReadableStream<Uint8Array>);
  };
  const s = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;
  const client: SessionClient = {
    openai: (project, agent) => ({
      baseURL: openAiBaseUrl(project, agent),
      apiKey: token,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        input instanceof Request
          ? deployment.fetch(input.url, input)
          : deployment.fetch(String(input), init)) as typeof fetch,
    }),
    uhp: () => ({
      baseURL: UHP_BASE_URL,
      apiKey: token,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        input instanceof Request
          ? deployment.fetch(input.url, input)
          : deployment.fetch(String(input), init)) as typeof fetch,
    }),
    chat: (id) =>
      new DefaultChatTransport({
        api: `${s(id)}/chat`,
        headers: { authorization: `Bearer ${token}` },
        fetch: ((input: string | URL | Request, init?: RequestInit) =>
          deployment.fetch(String(input), init)) as typeof fetch,
      }) as unknown as ChatTransportLike,
    async replayChat(id, from = {}) {
      const p = new URLSearchParams();
      if (from.turn) p.set("turn", from.turn);
      if (from.since !== undefined) p.set("since", String(from.since));
      const res = await deployment.fetch(`${s(id)}/chat/stream?${p}`, { headers });
      if (res.status === 204) return null;
      if (!res.ok || !res.body) await answer(res);
      expectUiStream(res);
      return uiChunks(res.body as ReadableStream<Uint8Array>);
    },
    me: () => call("GET", "/v1/me"),
    startSession: (req) => call("POST", "/v1/sessions", req),
    getSession: (id) => call("GET", s(id)),
    updateSession: (id, req) => call("PATCH", s(id), req),
    archiveSession: (id) => call("POST", `${s(id)}/archive`),
    deleteSession: (id) => call("DELETE", s(id)),
    listSessions: (q) => call("GET", `/v1/sessions${sessionsSearch(q)}`),
    postMessage: (id, req) => call("POST", `${s(id)}/messages`, req),
    sendMessage: async (id, req) => client.waitTurn(await client.postMessage(id, req)),
    async waitTurn(accepted) {
      for await (const frame of await stream(accepted.stream_url)) {
        // A turn that ended before the stream's offset ends it with an unnumbered terminal event.
        if (frame.event && TERMINAL_EVENTS.includes(frame.event)) {
          const turn = JSON.parse(frame.data ?? "null") as Turn;
          if (turn.id === accepted.turn_id) return turn;
        }
      }
      throw new ApiError(500, "the stream ended before the turn's terminal event");
    },
    getTurn: (id) => call("GET", `/v1/turns/${encodeURIComponent(id)}`),
    cancelTurn: (id) => call("POST", `/v1/turns/${encodeURIComponent(id)}/cancel`),
    listItems: (id, q) => call("GET", `${s(id)}/items${itemsSearch(q)}`),
    getItem: (id, itemId) => call("GET", `${s(id)}/items/${encodeURIComponent(itemId)}`),
    async readEvents(id, q = {}) {
      const events: SessionEvent[] = [];
      let offset = q.since ?? 0;
      for await (const frame of await stream(`${s(id)}/events?since=${offset}`)) {
        const event = eventOf(frame);
        if (event) {
          events.push(event);
          offset = event.seq;
        }
        if (frame.event === "up-to-date") break;
      }
      return { events, offset, up_to_date: true };
    },
    profile: () => call("GET", "/v1/me/profile"),
    eraseUser: () => call("DELETE", "/v1/me"),
    setMode: (req) => call("PUT", "/v1/me/mode", req),
    listApprovals: () => call("GET", "/v1/approvals"),
    answerApproval: (id, answer) => call("POST", `/v1/approvals/${encodeURIComponent(id)}`, answer),
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
    listModels: ({ project, discover }) =>
      call(
        "GET",
        `/v1/models?${new URLSearchParams({ project, ...(discover ? { discover: "true" } : {}) })}`,
      ),
    getModelConfig: () => call("GET", "/v1/me/models"),
    usage: ({ group_by, ...q } = {}) =>
      call(
        "GET",
        `/v1/usage${search({ ...q, ...(group_by ? { group_by: group_by.join(",") } : {}) })}`,
      ),
    async usageRecords(q = {}) {
      const res = await deployment.fetch(`/v1/usage/records${search(q)}`, { headers });
      if (!res.ok) await answer(res);
      return (await res.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as UsageRecordView);
    },
    getLimits: (level, target) => call("GET", limitsPath(level, target)),
    setLimits: (level, target, req) => call("PUT", limitsPath(level, target), req),
    deleteLimits: (level, target) => call("DELETE", limitsPath(level, target)),
    effectiveLimits: (q = {}) =>
      call("GET", `/v1/limits/effective${search(q as Record<string, unknown>)}`),
    setModelConfig: (config) => call("PUT", "/v1/me/models", config),
    rewind: (id, req) => call("POST", `${s(id)}/rewind`, req),
    setHead: (id, req) => call("PUT", `${s(id)}/head`, req),
    editTurn: (id, req) => call("POST", `/v1/turns/${encodeURIComponent(id)}/edit`, req),
    regenerateTurn: (id, req) =>
      call("POST", `/v1/turns/${encodeURIComponent(id)}/regenerate`, req ?? {}),
    listBranches: (id) => call("GET", `${s(id)}/branches`),
    eraseBranch: (id, turn) => call("DELETE", `${s(id)}/branches/${encodeURIComponent(turn)}`),
    forkSession: (id, req) => call("POST", `${s(id)}/fork`, req),
    listMemory: (target) => call("GET", memoryCollection(target)),
    memoryEntry: (target, id) =>
      call("GET", `${memoryPath(target)}/entries/${encodeURIComponent(id)}`),
    memoryFile: (target, name) =>
      call("GET", `${memoryPath(target)}/files/${encodeURIComponent(name)}`),
    memoryBatch: (target, actions) => call("POST", memoryCollection(target), { actions }),
    eraseMemory: (target, which) =>
      call(
        "DELETE",
        which.id !== undefined
          ? `${memoryPath(target)}/entries/${encodeURIComponent(which.id)}`
          : `${memoryPath(target)}/files/${encodeURIComponent(String(which.name))}`,
      ),
    listAgentMemories: (project) =>
      call("GET", `/v1/projects/${encodeURIComponent(project)}/memory/agents`),
    async exportProfile() {
      const res = await deployment.fetch("/v1/me/profile/export", { headers });
      if (!res.ok) await answer(res);
      if (res.headers.get("content-type") !== "application/zip")
        throw new ApiError(500, "the export is not a ZIP");
      return new Uint8Array(await res.arrayBuffer());
    },
    eraseProfile: () => call("DELETE", "/v1/me/profile"),
    async mcp(id, message) {
      const res = await deployment.fetch(`${s(id)}/mcp`, {
        method: "POST",
        headers: { ...headers, accept: "application/json, text/event-stream" },
        body: JSON.stringify(message),
      });
      if (res.status === 202) return null;
      return answer(res);
    },
  };
  return client;
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
 * The rows of Flue's tables in an agent session's DO (test-only admin route), by table. With
 * `forget`, the DO first drops its in-memory Flue session, as a fresh DO instance has none.
 */
export async function flueStorage(
  deployment: Deployment,
  adminKey: string,
  sessionId: string,
  options: { forget?: boolean } = {},
): Promise<Record<string, number>> {
  const { tables } = await admin<{ tables: Record<string, number> }>(
    deployment,
    adminKey,
    `/admin/sessions/${encodeURIComponent(sessionId)}/flue-storage`,
    options,
  );
  return tables;
}

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
 * Deletes a project from one of the deployment's workspaces, its system folder included
 * (test-only, behind `ADMIN_KEY`): the operator's action until projects are managed through the
 * session API.
 */
export async function deleteProject(
  deployment: Deployment,
  adminKey: string,
  project: string,
  workspace = "default",
): Promise<void> {
  await admin(
    deployment,
    adminKey,
    `/admin/workspaces/${encodeURIComponent(workspace)}/delete-project`,
    {
      project,
    },
  );
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
 * Moves a user's clock `ms` forward: the clock their User DO decides approval expiry by (test-only,
 * behind `ADMIN_KEY`). Answers the total offset.
 */
export async function advanceUserClock(
  deployment: Deployment,
  adminKey: string,
  user: string,
  ms: number,
): Promise<number> {
  const { offset } = await admin<{ offset: number }>(
    deployment,
    adminKey,
    `/admin/users/${encodeURIComponent(user)}/clock`,
    { advance_ms: ms },
  );
  return offset;
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
  // The route waits for the turn to end, and answers the full turn.
  return admin(deployment, adminKey, `/admin/sessions/${encodeURIComponent(sessionId)}/messages`, {
    content,
  });
}

/**
 * The operator's export of usage records (`GET /v1/usage/records` with the operator token): every
 * workspace's, or one's, created at or after `since`.
 */
export async function exportUsage(
  deployment: Deployment,
  operatorKey: string,
  query: { since?: number; workspace?: string } = {},
): Promise<UsageRecordView[]> {
  const res = await deployment.fetch(`/v1/usage/records${search(query)}`, {
    headers: { authorization: `Bearer ${operatorKey}` },
  });
  if (!res.ok) await answer(res);
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UsageRecordView);
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

/**
 * The model requests a workspace's budget recorded, oldest first (test-only, behind `ADMIN_KEY`;
 * usage reports are a later ticket's).
 */
export async function modelUsage(
  deployment: Deployment,
  adminKey: string,
  workspace = "default",
): Promise<ModelUsageRecord[]> {
  const { usage } = await admin<{ usage: ModelUsageRecord[] }>(
    deployment,
    adminKey,
    `/admin/workspaces/${encodeURIComponent(workspace)}/model-usage`,
    {},
  );
  return usage;
}
