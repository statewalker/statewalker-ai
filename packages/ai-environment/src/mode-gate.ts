// Modes and approvals on a file view (statewalker/statewalker-root#79, #89, built by #124). The gate
// wraps an agent session's gated view (roles, membership, system folders and ignore rules already
// applied) with the mode: every operation is decided by the permission rules and the user session's
// mode at that moment, for the path and every entry it touches; deny refuses it, ask stops it until
// the user answers, keyed by the exact action (session, method, paths, content), so a retry waits on
// the same approval and an approval runs only what was asked. `mkdir -p` of an existing folder
// changes nothing and never asks.
//
// "Ask" crosses the files-RPC protocol as an error whose message is `EAPPROVAL: <request JSON>`
// (a structured clone keeps only the message); the holder's side (`approvalAware`) turns it back
// into the request, so the agent session can store the action and end its turn.
import {
  type ApprovalRequest,
  approvalId,
  codedError,
  type FileAction,
} from "@statewalker/ai-access";
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import { normalise } from "./paths.js";

export interface ModeVerdict {
  /** "classify": `auto` mode leaves the action to its risk classifier (ModeGate.classify). */
  verdict: "allow" | "ask" | "deny" | "classify";
  reason: string;
  /**
   * Which step of `auto` decided (statewalker/statewalker-root#137): a verdict with a step is
   * recorded as a decision item when it decides a change.
   */
  step?: GateStep;
}

/** The steps of `auto` a decision item names. */
export type GateStep = "rule" | "safe" | "classifier" | "approval" | "mode";

/** The risk classifier's verdict on one change, already settled for unattended sessions. */
export interface ClassifiedVerdict {
  verdict: "allow" | "ask" | "deny";
  reason: string;
  /** The model that answered, and how long the classifier took. */
  model?: string;
  latency_ms: number;
  /** Set when this denial made the session fall back to that mode. */
  fallback?: string;
  /** Set when the session's running turn stops with this decision, and why. */
  stop?: string;
}

/** One decision of `auto` on a change, as the gate reports it to the agent session (an item). */
export interface GateDecision {
  action: ApprovalRequest["action"];
  step: GateStep;
  verdict: "allow" | "ask" | "deny";
  reason: string;
  model?: string;
  latency_ms?: number;
  fallback?: string;
  stop?: string;
  /** A block's approval id, request and exact call: approving it retries exactly that call. */
  approval?: string;
  request?: ApprovalRequest;
  stored?: StoredCall;
}

/** What the gate knows of one agent session's mode and approvals, read at every call. */
export interface ModeGate {
  session: string;
  project: string;
  /**
   * The verdicts of the rules and the current mode on the actions of one operation (paths in the
   * project), read once for them all.
   */
  decide(checks: readonly [FileAction, string][]): Promise<ModeVerdict[]>;
  /** Uses up the user's grant of this approval to this session; whether there was one. */
  consume(id: string): Promise<boolean>;
  /** `auto` mode's risk classifier on one change no rule and no safe class settles. */
  classify?(request: ApprovalRequest): Promise<ClassifiedVerdict>;
  /** Reports one decision of `auto` on a change, to be kept as an item of the session. */
  record?(decision: GateDecision): Promise<void>;
}

/**
 * The methods an approval can stand for, as the holder stores and runs them again: file changes,
 * a database action (`db`: the path is the database, the content its encoded action), and a tool
 * call (`tool`: the path is the tool's name, the content its arguments as JSON).
 */
/** `limit`: raising a limit that asks (statewalker/statewalker-root#179). */
export type ApprovalMethod =
  | "write"
  | "mkdir"
  | "remove"
  | "copy"
  | "move"
  | "db"
  | "tool"
  | "limit"
  | "memory"
  // Publishing a task or a reply (statewalker/statewalker-root#206): the path is the subject.
  | "tasks"
  // A remote agent session's actions (statewalker/statewalker-root#144): starting its task,
  // answering its harness's question, writing its artifacts back.
  | "remote"
  | "input"
  | "changeset"
  // A sub-agent's approval a turn waits on through `agent.start` (statewalker/statewalker-ai#88):
  // the path is the sub-agent session, the target the approval.
  | "agent";

const PREFIX = "EAPPROVAL: ";

/** The error a call the mode asks about fails with, carrying the approval request. */
export function approvalError(request: ApprovalRequest): Error {
  return new Error(`${PREFIX}${JSON.stringify(request)}`);
}

/** The approval request an error carries, if it is one. */
export function approvalOf(e: unknown): ApprovalRequest | undefined {
  const message = String((e as Error)?.message ?? "");
  const at = message.indexOf(PREFIX);
  if (at < 0) return undefined;
  try {
    return JSON.parse(message.slice(at + PREFIX.length)) as ApprovalRequest;
  } catch {
    return undefined;
  }
}

/** Thrown in the holder when a call waits on an approval. */
export class ApprovalPending extends Error {
  constructor(readonly request: ApprovalRequest) {
    super(`waiting on the user's approval ${request.id}: ${request.reason}`);
    this.name = "ApprovalPending";
  }
}

async function bytesOf(content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of content) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const RANK = { allow: 0, classify: 1, ask: 2, deny: 3 } as const;

/** The gate's side: the agent session's gated view, with every operation decided by the mode. */
export function modeGated(view: FilesApi, gate: ModeGate): FilesApi {
  const relative = (path: string) => {
    const root = `/${gate.project}`;
    return path === root ? "/" : path.startsWith(`${root}/`) ? path.slice(root.length) : path;
  };
  /** The strictest verdict over the actions, deny first. */
  const strictest = async (checks: [FileAction, string][]) => {
    let worst: (ModeVerdict & { action: FileAction; path: string }) | undefined;
    const verdicts = await gate.decide(checks);
    checks.forEach(([action, path], i) => {
      const v = verdicts[i] as ModeVerdict;
      if (!worst || RANK[v.verdict] > RANK[worst.verdict]) worst = { ...v, action, path };
    });
    return worst;
  };
  /**
   * Allowed, EACCES, or the approval error (unless the user granted exactly this action). In
   * `auto`, an action the rules and safe classes leave open goes to the risk classifier, and every
   * decision on a change is recorded; a classifier's block keeps the exact call, so the user can
   * approve a retry.
   */
  const settle = async (
    checks: [FileAction, string][],
    method: ApprovalMethod,
    path: string,
    extra: { target?: string; content?: () => Promise<Uint8Array> } = {},
  ) => {
    const worst = await strictest(checks);
    if (!worst) return undefined;
    const inside = worst.path === path ? "" : ` (on ${worst.path}, inside)`;
    const target = extra.target !== undefined ? { target: extra.target } : {};
    const record = async (d: Omit<GateDecision, "action">, size?: number) => {
      if (!gate.record) return;
      await gate.record({
        action: { method, path, ...target, ...(size !== undefined ? { size } : {}) },
        ...d,
      });
    };
    if (worst.verdict === "allow") {
      if (worst.step) await record({ step: worst.step, verdict: "allow", reason: worst.reason });
      return undefined;
    }
    if (worst.verdict === "deny") {
      if (worst.step) await record({ step: worst.step, verdict: "deny", reason: worst.reason });
      throw codedError("EACCES", `may not ${worst.action} '${path}': ${worst.reason}${inside}`);
    }
    const content = await extra.content?.();
    const key = extra.target === undefined ? path : `${path}\n${extra.target}`;
    const id = await approvalId(gate.session, method, key, content);
    const [first] = checks;
    const request: ApprovalRequest = {
      id,
      session: gate.session,
      project: gate.project,
      action: { method, path, ...target, ...(content ? { size: content.length } : {}) },
      permission: `files.${first?.[0] ?? worst.action}:${relative(first?.[1] ?? path)}`,
      reason: `${worst.reason}${inside}`,
    };
    if (await gate.consume(id)) {
      if (worst.step)
        await record(
          { step: "approval", verdict: "allow", reason: "the user approved this action" },
          content?.length,
        );
      return content;
    }
    if (worst.verdict === "classify") {
      const c: ClassifiedVerdict = gate.classify
        ? await gate.classify(request)
        : { verdict: "deny", reason: "no risk classifier runs here", latency_ms: 0 };
      const decided = { ...request, reason: c.reason };
      await record(
        {
          step: "classifier",
          verdict: c.verdict,
          reason: c.reason,
          ...(c.model ? { model: c.model } : {}),
          latency_ms: c.latency_ms,
          ...(c.fallback ? { fallback: c.fallback } : {}),
          ...(c.stop ? { stop: c.stop } : {}),
          ...(c.verdict === "deny"
            ? {
                approval: id,
                request: decided,
                stored: { method, path, ...target, ...(content ? { content } : {}) },
              }
            : {}),
        },
        content?.length,
      );
      if (c.verdict === "allow") return content;
      if (c.verdict === "deny")
        throw codedError(
          "EACCES",
          `may not ${worst.action} '${path}': the risk classifier denied it: ${c.reason} (blocked: the user may approve a retry, ${id})`,
        );
      throw approvalError(decided);
    }
    if (worst.step) await record({ step: worst.step, verdict: "ask", reason: request.reason });
    throw approvalError(request);
  };
  /** An agent never removes, moves or replaces its project's folder itself, whatever the mode. */
  const changeable = (path: string) => {
    if (path === "/" || path === `/${gate.project}`)
      throw codedError("EACCES", `may not change the project's folder '${path}'`);
  };
  /** A read action that asks cannot wait on an approval: it is refused. */
  const readable = async (action: FileAction, path: string) => {
    const [v] = await gate.decide([[action, path]]);
    if (v?.verdict !== "allow")
      throw codedError("EACCES", `may not ${action} '${path}': ${v?.reason}`);
  };
  /** The entries under a path the holder sees (none for a file or nothing). */
  const under = async (path: string): Promise<FileInfo[]> => {
    if ((await view.stats(path))?.kind !== "directory") return [];
    const out: FileInfo[] = [];
    for await (const e of view.list(path, { recursive: true })) out.push(e);
    return out;
  };

  return {
    async *read(raw, options) {
      await readable("read", normalise(raw));
      yield* view.read(raw, options);
    },
    async *list(raw, options) {
      const path = normalise(raw);
      if (path !== "/") await readable("list", path);
      yield* view.list(raw, options);
    },
    async stats(raw) {
      const path = normalise(raw);
      if (path !== "/") await readable("read", path);
      return view.stats(raw);
    },
    async exists(raw) {
      return (await this.stats(raw)) !== undefined;
    },
    async write(raw, content) {
      const path = normalise(raw);
      changeable(path);
      let bytes: Uint8Array | undefined;
      const read = async () => {
        bytes ??= await bytesOf(content);
        return bytes;
      };
      await settle([["write", path]], "write", path, { content: read });
      await view.write(raw, bytes ? [bytes] : content);
    },
    async mkdir(raw) {
      const path = normalise(raw);
      // Nothing changes: no decision to make, never an ask.
      if ((await view.stats(path))?.kind === "directory") return;
      await settle([["write", path]], "mkdir", path);
      await view.mkdir(raw);
    },
    async remove(raw) {
      const path = normalise(raw);
      changeable(path);
      if (!(await view.stats(path))) return false;
      const entries = await under(path);
      await settle(
        [["delete", path], ...entries.map((e): [FileAction, string] => ["delete", e.path])],
        "remove",
        path,
      );
      return view.remove(raw);
    },
    copy: (source, target) => transfer(source, target, false),
    move: (source, target) => transfer(source, target, true),
  };

  async function transfer(source: string, target: string, move: boolean): Promise<boolean> {
    const from = normalise(source);
    const to = normalise(target);
    if (move) changeable(from);
    changeable(to);
    if (!(await view.stats(from))) return false;
    const entries = await under(from);
    const replaced = await under(to);
    const checks: [FileAction, string][] = [["write", to]];
    if (move) checks.push(["delete", from]);
    for (const e of entries) {
      checks.push(["write", `${to}${e.path.slice(from.length)}`]);
      if (move) checks.push(["delete", e.path]);
    }
    if (await view.stats(to)) checks.push(["delete", to]);
    for (const e of replaced) checks.push(["delete", e.path]);
    await settle(checks, move ? "move" : "copy", from, { target: to });
    return move ? view.move(source, target) : view.copy(source, target);
  }
}

/**
 * The holder's side: a file view whose changes the gate may stop for an approval. Such a change is
 * reported to `onApproval` with the exact call (to store) and fails with `ApprovalPending`; every
 * later change through this view then fails the same way without reaching the gate, since the
 * turn ends at the pending call (Flue's write tool otherwise retries after `mkdir -p` of the parent,
 * which would ask about a folder nobody asked to create).
 */
export function approvalAware(
  files: FilesApi,
  onApproval: (request: ApprovalRequest, call: StoredCall) => void,
): FilesApi {
  let waitingOn: ApprovalRequest | undefined;
  /** The approval each change asked waits on: a change tried again names its own. */
  const asked = new Map<string, ApprovalRequest>();
  const keyOf = (call: StoredCall) => `${call.method} ${call.path} ${call.target ?? ""}`;
  const change = async <T>(call: StoredCall, run: () => Promise<T>): Promise<T> => {
    if (waitingOn) throw new ApprovalPending(asked.get(keyOf(call)) ?? waitingOn);
    try {
      return await run();
    } catch (e) {
      const request = approvalOf(e);
      if (!request) throw e;
      // Concurrent changes (a batch of tool calls) may each wait on their own approval.
      waitingOn ??= request;
      asked.set(keyOf(call), request);
      onApproval(request, call);
      throw new ApprovalPending(request);
    }
  };
  return {
    read: (p, o) => files.read(p, o),
    list: (p, o) => files.list(p, o),
    stats: (p) => files.stats(p),
    exists: (p) => files.exists(p),
    async write(path, content) {
      const bytes = await bytesOf(content);
      await change({ method: "write", path, content: bytes }, () => files.write(path, [bytes]));
    },
    mkdir: (path) => change({ method: "mkdir", path }, () => files.mkdir(path)),
    remove: (path) => change({ method: "remove", path }, () => files.remove(path)),
    copy: (path, target) =>
      change({ method: "copy", path, target }, () => files.copy(path, target)),
    move: (path, target) =>
      change({ method: "move", path, target }, () => files.move(path, target)),
  };
}

/** One change a holder made, exactly, as an approval stores it and runs it again. */
export interface StoredCall {
  method: ApprovalMethod;
  path: string;
  target?: string;
  content?: Uint8Array;
}

/**
 * Runs a stored change again through a file view (the gate re-checks it against the current mode
 * and roles): its answer, or `{$approval}` when the gate still asks.
 */
export async function runStoredCall(files: FilesApi, call: StoredCall): Promise<unknown> {
  try {
    switch (call.method) {
      case "write":
        await files.write(call.path, [call.content ?? new Uint8Array()]);
        return null;
      case "mkdir":
        await files.mkdir(call.path);
        return null;
      case "remove":
        return files.remove(call.path);
      case "copy":
        return files.copy(call.path, String(call.target));
      case "move":
        return files.move(call.path, String(call.target));
      case "db":
        throw codedError("EINVAL", "a database action runs through the database gate");
      case "tool":
        throw codedError("EINVAL", "a tool call runs through the workspace's tools");
      case "limit":
        throw codedError("EINVAL", "a limit is raised by the DO that counts it");
      case "memory":
        throw codedError("EINVAL", "a memory batch runs through the memory service");
      case "tasks":
        throw codedError("EINVAL", "a task is published through the task queue");
      default:
        throw codedError("EINVAL", `a ${call.method} action runs through its remote agent session`);
    }
  } catch (e) {
    const request = approvalOf(e);
    if (request) return { $approval: request };
    throw e;
  }
}
