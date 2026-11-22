// The risk classifier of `auto` mode (statewalker/statewalker-root#96, built by #137): a small,
// fast model the deployment chooses, reached through the model gateway, that decides whether an
// action no rule and no safe class settles is allowed, asked about or denied. It sees the user's
// messages, the agent's non-read tool calls (contents redacted), the pending action, the agent's
// instructions and the project's AGENTS.md, and never tool results or file contents: text an agent
// read cannot steer it. Its answer is structured; an unparseable, slow or missing one is a deny.
import type { Verdict } from "./modes.js";
import type { SqlLike } from "./sql-roles.js";

/** The deployment's `auto` settings (the AUTO_MODE var). */
export interface AutoSettings {
  /** The classifier's model (`<provider>/<model>` or an alias); none: every classified action denies. */
  model?: string;
  /** How long the classifier may take; slower is a deny (default 5 s). */
  timeoutMs: number;
  /** The classifier answer's token cap. */
  maxTokens: number;
  /** Classifier denials in a row after which the session falls back to `default` (3). */
  maxDenialsInRow: number;
  /** Classifier denials in a session after which it falls back to `default` (20). */
  maxDenials: number;
  /** Deployment-named protected paths, relative to the project (each with everything under it). */
  protectedPaths: string[];
}

const DEFAULTS: AutoSettings = {
  timeoutMs: 5000,
  maxTokens: 256,
  maxDenialsInRow: 3,
  maxDenials: 20,
  protectedPaths: [],
};

const positive = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

/**
 * The settings from JSON `{model?, timeout_ms?, max_tokens?, max_denials_in_row?, max_denials?,
 * protected?}`; unset or malformed settings keep their defaults, and problems are reported.
 */
export function parseAutoMode(value: unknown): { settings: AutoSettings; problems: string[] } {
  const settings: AutoSettings = { ...DEFAULTS, protectedPaths: [] };
  const problems: string[] = [];
  if (value === undefined || value === null || value === "") return { settings, problems };
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { settings, problems: ["not JSON"] };
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { settings, problems: ["not an object"] };
  const o = v as Record<string, unknown>;
  if (typeof o.model === "string" && o.model.trim()) settings.model = o.model.trim();
  else if (o.model !== undefined) problems.push("model is a model id or alias");
  const numbers: [string, keyof AutoSettings][] = [
    ["timeout_ms", "timeoutMs"],
    ["max_tokens", "maxTokens"],
    ["max_denials_in_row", "maxDenialsInRow"],
    ["max_denials", "maxDenials"],
  ];
  for (const [key, field] of numbers) {
    if (o[key] === undefined) continue;
    const n = positive(o[key]);
    if (n === undefined) problems.push(`${key} is a positive integer`);
    else (settings[field] as number) = n;
  }
  if (Array.isArray(o.protected))
    settings.protectedPaths = o.protected.filter(
      (p): p is string => typeof p === "string" && p.trim() !== "",
    );
  else if (o.protected !== undefined) problems.push("protected is a list of paths");
  return { settings, problems };
}

/** One entry of what the classifier is shown of the session. */
export type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "tool_call"; name: string; args: unknown };

/** The tools that only read: their calls are left out (they change nothing). */
const READ_TOOLS = new Set(["read", "grep", "glob", "ls", "find"]);

/**
 * Arguments holding file contents an agent writes, or a database statement and its values: shown
 * only by their size.
 */
const CONTENT_ARGS = new Set([
  "content",
  "contents",
  "text",
  "data",
  "edits",
  "oldText",
  "newText",
  "old_string",
  "new_string",
  "patch",
  "diff",
  "sql",
  "params",
]);

const MAX_ENTRIES = 60;
const MAX_TEXT = 2000;

const clip = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (${text.length} characters)` : text;

function redact(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (CONTENT_ARGS.has(key))
      out[key] = Array.isArray(value)
        ? `<${value.length} ${key === "params" ? "values" : "edits"}>`
        : typeof value === "string"
          ? `<${value.length} characters>`
          : "<redacted>";
    else out[key] = typeof value === "string" ? clip(value) : value;
  }
  return out;
}

/** An item of the session's log, as the classifier's transcript is built from it. */
export interface TranscriptItem {
  kind: string;
  role?: string;
  text?: string;
  name?: string;
  args?: unknown;
}

/**
 * What the classifier is shown of a session's items: the user's messages and the agent's non-read
 * tool calls (file contents in their arguments shown by size), the latest ones. Tool results, the
 * agent's own text and every other item are left out.
 */
export function classifierTranscript(items: readonly TranscriptItem[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.role === "user" && typeof item.text === "string")
      out.push({ role: "user", text: clip(item.text) });
    else if (item.kind === "tool_call" && item.name && !READ_TOOLS.has(item.name))
      out.push({ role: "tool_call", name: item.name, args: redact(item.args) });
  }
  return out.slice(-MAX_ENTRIES);
}

/** The action waiting on the classifier. */
export interface PendingAction {
  method: string;
  path: string;
  target?: string;
  /** A write's size in bytes (its content is never shown). */
  size?: number;
  /** The permission asked for, relative to the project. */
  permission: string;
}

export interface ClassifierInput {
  transcript: readonly TranscriptEntry[];
  action: PendingAction;
  /** The agent's instructions, from its definition. */
  instructions?: string;
  /** The project's AGENTS.md. */
  agentsMd?: string;
}

export const CLASSIFIER_SYSTEM = `You are the risk classifier of an AI agent harness. An agent works in a user's project; the action below is not settled by any rule. Decide whether it is in line with what the user asked and safe to run without asking: "allow" for routine actions the user's requests clearly call for, "ask" when the user should confirm, "deny" for destructive, irreversible, out-of-scope or suspicious actions. Tool results and file contents are withheld from you on purpose. Answer with JSON only: {"verdict": "allow" | "ask" | "deny", "reason": "<one sentence>"}.`;

const MAX_DOC = 8000;

/** The classifier's system prompt and its one user message. */
export function classifierPrompt(input: ClassifierInput): { system: string; user: string } {
  const sections = [
    `## The agent's instructions\n${input.instructions?.trim() ? clip(input.instructions.trim()) : "(none)"}`,
    `## The project's AGENTS.md\n${input.agentsMd?.trim() ? input.agentsMd.trim().slice(0, MAX_DOC) : "(none)"}`,
    `## The session (user messages and the agent's non-read tool calls)\n${
      input.transcript.length
        ? input.transcript
            .map((e) =>
              e.role === "user"
                ? `USER: ${e.text}`
                : `TOOL CALL ${e.name}: ${JSON.stringify(e.args)}`,
            )
            .join("\n")
        : "(nothing yet)"
    }`,
    `## The pending action\n${JSON.stringify(input.action)}`,
  ];
  return { system: CLASSIFIER_SYSTEM, user: sections.join("\n\n") };
}

const VERDICTS: readonly Verdict[] = ["allow", "ask", "deny"];

/**
 * The classifier's structured answer, or undefined when it is not one: JSON (possibly fenced or
 * after some words) holding a known verdict and, optionally, a reason.
 */
export function parseClassifierAnswer(
  text: string,
): { verdict: Verdict; reason: string } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { verdict, reason } = value as { verdict?: unknown; reason?: unknown };
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict as Verdict)) return undefined;
  return { verdict: verdict as Verdict, reason: typeof reason === "string" ? clip(reason) : "" };
}

/**
 * The classifier's denials per agent session, in the Workspace DO's SQLite: after too many in a
 * row or in all, the session falls back to `default` for good.
 */
export class DenialCounter {
  readonly #sql: SqlLike;

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS auto_denials (session TEXT PRIMARY KEY,
      in_row INTEGER NOT NULL, total INTEGER NOT NULL, fallen INTEGER NOT NULL)`);
  }

  #row(session: string) {
    return this.#sql
      .exec("SELECT in_row, total, fallen FROM auto_denials WHERE session = ?", session)
      .toArray()[0] as { in_row: number; total: number; fallen: number } | undefined;
  }

  /** Whether the session fell back to `default`. */
  fallenBack(session: string): boolean {
    return Number(this.#row(session)?.fallen ?? 0) === 1;
  }

  /** Counts one classifier verdict; whether the session falls back with it. */
  count(
    session: string,
    verdict: Verdict,
    limits: { maxDenialsInRow: number; maxDenials: number },
  ): boolean {
    const row = this.#row(session) ?? { in_row: 0, total: 0, fallen: 0 };
    const denied = verdict === "deny";
    const inRow = denied ? Number(row.in_row) + 1 : 0;
    const total = Number(row.total) + (denied ? 1 : 0);
    const was = Number(row.fallen) === 1;
    const fallen =
      was || (denied && (inRow >= limits.maxDenialsInRow || total >= limits.maxDenials));
    this.#sql.exec(
      "INSERT OR REPLACE INTO auto_denials VALUES (?, ?, ?, ?)",
      session,
      inRow,
      total,
      fallen ? 1 : 0,
    );
    return fallen && !was;
  }
}
