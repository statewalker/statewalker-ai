// The parts of the Unified Harness Protocol a remote agent session uses (version 2026-10-19,
// statewalker/statewalker-root#109, #144): servers as the deployment and workspaces register them,
// responses, their output items, questions and artifacts. Clients ignore what they do not know.
import { codedError, REMOTE_AGENT_PREFIX } from "@statewalker/ai-access";

/** The protocol version every request names (`UHP-Version`), pinned. */
export const UHP_VERSION = "2026-10-19";

/** The plugin name a UHP server's token secret is bound to (beside the server's host). */
export const UHP_PLUGIN = "uhp";

/** A UHP server, registered at deployment level (`UHP_SERVERS`) or workspace level. */
export interface UhpServer {
  id: string;
  /** Its origin (and any path prefix), without a trailing slash. */
  baseUrl: string;
  /** The name of the secret holding its bearer token, bound to plugin `uhp` and its host. */
  secret: string;
  /**
   * The harnesses it may serve here, by our name: `{"<name>": "<UHP harness id>"}`. A harness the
   * server offers but no one listed is off.
   */
  harnesses: Record<string, string>;
  level: "deployment" | "workspace";
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SECRET = /^[A-Z][A-Z0-9_]*$/;

/** Servers from JSON text (`[{id, baseUrl, secret, harnesses}]`); bad entries are reported. */
export function parseUhpServers(
  text: string | undefined,
  level: UhpServer["level"],
): { servers: UhpServer[]; problems: string[] } {
  const servers: UhpServer[] = [];
  const problems: string[] = [];
  if (!text?.trim()) return { servers, problems };
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return { servers, problems: ["not JSON"] };
  }
  if (!Array.isArray(list)) return { servers, problems: ["not a list of servers"] };
  for (const entry of list as Record<string, unknown>[]) {
    const id = String(entry?.id ?? "");
    if (!NAME.test(id)) {
      problems.push(`'${id}': a server's id is a lowercase name`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(String(entry.baseUrl));
    } catch {
      problems.push(`${id}: baseUrl is not a URL`);
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      problems.push(`${id}: baseUrl is not http(s)`);
      continue;
    }
    if (url.username || url.password || url.search || url.hash) {
      problems.push(`${id}: baseUrl holds credentials, a query or a fragment`);
      continue;
    }
    const secret = String(entry.secret ?? "");
    if (!SECRET.test(secret)) {
      problems.push(`${id}: secret names the secret holding its token`);
      continue;
    }
    const harnesses: Record<string, string> = {};
    const listed = entry.harnesses;
    if (Array.isArray(listed)) for (const h of listed) harnesses[String(h)] = String(h);
    else if (listed && typeof listed === "object")
      for (const [k, v] of Object.entries(listed)) harnesses[k] = String(v);
    for (const name of Object.keys(harnesses))
      if (!NAME.test(name) && !/^chrn_[A-Za-z0-9_]+$/.test(name)) {
        problems.push(`${id}: '${name}' is not a harness name`);
        delete harnesses[name];
      }
    servers.push({
      id,
      baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
      secret,
      harnesses,
      level,
    });
  }
  return { servers, problems };
}

/** Folds the levels: a workspace never replaces a deployment server of the same id. */
export function foldUhpServers(levels: UhpServer[][]): UhpServer[] {
  const out: UhpServer[] = [];
  for (const level of levels)
    for (const s of level) if (!out.some((o) => o.id === s.id)) out.push(s);
  return out;
}

/** A remote agent's id: `remote:<server>/<harness>`. */
export const remoteAgentId = (server: string, harness: string) =>
  `${REMOTE_AGENT_PREFIX}${server}/${harness}`;

/** The server and harness a remote agent's id names, or undefined. */
export function parseRemoteAgentId(id: string): { server: string; harness: string } | undefined {
  if (!id.startsWith(REMOTE_AGENT_PREFIX)) return undefined;
  const [server, harness, ...rest] = id.slice(REMOTE_AGENT_PREFIX.length).split("/");
  if (rest.length || !server || !harness) return undefined;
  return { server, harness };
}

/** Every remote agent the servers list, by id. */
export function remoteAgents(servers: readonly UhpServer[]): string[] {
  return servers.flatMap((s) => Object.keys(s.harnesses).map((h) => remoteAgentId(s.id, h)));
}

export type UhpStatus = "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";

export interface UhpItem {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface UhpResponse {
  id: string;
  status: UhpStatus | string;
  output?: UhpItem[];
  metadata?: Record<string, unknown>;
  incomplete_details?: { reason?: string };
  error?: { message?: string; code?: string } | null;
}

export const isTerminal = (status: string) => status !== "in_progress" && status !== "queued";

/** A UHP error envelope as a coded error (`EACCES`, `ENOENT`, `EBUSY`, `EINVAL` or `EIO`). */
export function uhpError(status: number, body: unknown, what: string): Error {
  const e = (body as { error?: { code?: string; message?: string } })?.error;
  const detail = e ? `${e.code ?? ""}${e.message ? `: ${e.message}` : ""}` : "";
  const code =
    status === 401 || status === 403
      ? "EACCES"
      : status === 404
        ? "ENOENT"
        : status === 409
          ? "EBUSY"
          : status === 400 || status === 410 || status === 422
            ? "EINVAL"
            : "EIO";
  return codedError(
    code,
    `the UHP server refused ${what} (${status}${detail ? ` ${detail}` : ""})`,
  );
}

/** A question a harness asked (the response's last `input_request` item). */
export interface UhpInputRequest {
  id: string;
  kind: "choice" | "confirm" | "free_text" | "secret";
  prompt: string;
  options?: { id: string; label?: string }[];
  expires_at?: number;
}

const KINDS = ["choice", "confirm", "free_text", "secret"];

/** The question an `incomplete` response ended on, if it did. */
export function inputRequestOf(response: UhpResponse): UhpInputRequest | undefined {
  if (response.status !== "incomplete") return undefined;
  if (response.incomplete_details?.reason !== "input_required") return undefined;
  const item = [...(response.output ?? [])].reverse().find((i) => i.type === "input_request");
  if (!item || typeof item.id !== "string" || !KINDS.includes(String(item.kind))) return undefined;
  const options = Array.isArray(item.options)
    ? (item.options as Record<string, unknown>[])
        .filter((o) => typeof o?.id === "string")
        .map((o) => ({
          id: String(o.id),
          ...(typeof o.label === "string" ? { label: o.label } : {}),
        }))
    : undefined;
  return {
    id: item.id,
    kind: item.kind as UhpInputRequest["kind"],
    prompt: String(item.prompt ?? ""),
    ...(options?.length ? { options } : {}),
    ...(typeof item.expires_at === "number" ? { expires_at: item.expires_at } : {}),
  };
}

/**
 * The input that answers a question: an `input_response` for an allow (`answer` an option's id for
 * `choice` and `confirm`, any text for `free_text` and `secret`); a denial voids the question
 * with a message saying so. EINVAL when the answer does not fit.
 */
export function answerInput(
  request: UhpInputRequest,
  answer: { decision: "allow" | "deny"; message?: string },
): unknown[] {
  if (answer.decision !== "allow")
    return [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `The user declined to answer${answer.message && request.kind !== "secret" ? `: ${answer.message}` : "."}`,
          },
        ],
      },
    ];
  const options = request.options ?? [];
  let value = answer.message ?? "";
  if (request.kind === "confirm") {
    if (!options.length) value = "yes";
    else value = (options.find((o) => o.id === "yes") ?? options[0])?.id ?? "yes";
  } else if (request.kind === "choice") {
    const picked = options.find((o) => o.id === value || o.label === value);
    if (!picked)
      throw codedError(
        "EINVAL",
        `answer with one of the options as the message: ${options.map((o) => o.id).join(", ")}`,
      );
    value = picked.id;
  } else if (!value) throw codedError("EINVAL", "answer with the text as the message");
  return [{ type: "input_response", input_request_id: request.id, answer: value }];
}

/** An artifact a response cites: where to download it and the path it names. */
export interface UhpArtifact {
  container: string;
  file: string;
  filename: string;
}

/** The artifacts a response's messages cite (`container_file_citation` annotations). */
export function artifactsOf(response: UhpResponse): UhpArtifact[] {
  const out: UhpArtifact[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Record<string, unknown>[])
      for (const a of (Array.isArray(part?.annotations) ? part.annotations : []) as Record<
        string,
        unknown
      >[])
        if (
          a?.type === "container_file_citation" &&
          typeof a.container_id === "string" &&
          typeof a.file_id === "string" &&
          typeof a.filename === "string" &&
          !out.some((o) => o.file === a.file_id)
        )
          out.push({ container: a.container_id, file: a.file_id, filename: a.filename });
  }
  return out;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Whether a UHP object id is safe to put in a path. */
export const isUhpId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

/**
 * The project path an artifact's filename names, or undefined when it would leave the project's
 * working copy: absolute, `..`, backslashes or empty segments.
 */
export function projectPathOf(project: string, filename: string): string | undefined {
  if (!filename || filename.startsWith("/") || filename.includes("\\")) return undefined;
  const segments = filename.split("/");
  if (segments.some((s) => !s || s === "." || s === ".." || /[\p{Cc}]/u.test(s))) return undefined;
  return `/${project}/${segments.join("/")}`;
}
