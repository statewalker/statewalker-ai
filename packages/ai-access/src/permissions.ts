// The permission language (statewalker/statewalker-root#77; areas added by #157, #158, #160,
// #161): `<area>.<action>[:<target>]`, `*` as a whole area or action segment, targets relative to
// the project. Areas are an open set: the ones below are known, and an unknown area or action is
// reported and ignored, never treated as everything. Permissions are translated to Datalog and
// decided by the Biscuit authorizer; `permits` is the plain matcher the translation is tested
// against.
import { authorize, type Params } from "@statewalker/webrun-biscuit";

export interface Permission {
  area: string;
  action: string;
  /** Without a target, the permission covers the whole project. */
  target?: string;
}

/** One action asked for: its area, its action and, for most areas, its target. */
export interface AccessRequest {
  area: string;
  action: string;
  /** Files: the path relative to the project (`/drafts/a.md`); tasks: the subject; net: `host/path`. */
  target?: string;
}

/**
 * How an area's targets match:
 * - `path`: `/`-separated, relative to the project; `*` within a segment, `**` across segments; a
 *   pattern covers the entries it names and everything under them.
 * - `subject`: `.`-separated tokens; `*` is one token, `>` (last) one or more.
 * - `host`: `<host>[/<path-prefix>]`; the host exact or `*.<domain>` for any subdomain; the path a
 *   segment-wise prefix.
 * - `name`: exact, with `*` matching any characters.
 */
export type TargetKind = "path" | "subject" | "host" | "name";

interface AreaSpec {
  actions: readonly string[];
  target: TargetKind;
  /** Granted only when the area is named: `*` as the area never reaches it. */
  byName?: boolean;
  /** Actions that stand for several (net.fetch: read and write). */
  aliases?: Readonly<Record<string, readonly string[]>>;
}

export const AREAS: Readonly<Record<string, AreaSpec>> = {
  files: { actions: ["read", "list", "write", "delete"], target: "path" },
  comments: { actions: ["read", "write"], target: "path" },
  tools: { actions: ["call"], target: "name" },
  db: { actions: ["read", "write", "admin"], target: "name" },
  models: { actions: ["use"], target: "name" },
  members: { actions: ["read", "manage"], target: "name" },
  memory: { actions: ["write"], target: "name" },
  usage: { actions: ["read"], target: "name" },
  limits: { actions: ["write"], target: "name" },
  triggers: { actions: ["write"], target: "name" },
  tasks: { actions: ["publish", "subscribe", "admin"], target: "subject" },
  // Held by no built-in role (#161, #80-era UHP decision): granted only by name, in custom roles.
  net: {
    actions: ["read", "write"],
    target: "host",
    byName: true,
    aliases: { fetch: ["read", "write"] },
  },
  agents: { actions: ["use"], target: "name", byName: true },
  // Workspace-level: the workspace admin's.
  projects: { actions: ["create"], target: "name", byName: true },
};

const SEGMENT = /^(?:[a-z][a-z0-9_-]*|\*)$/;
// A target is printable and has no whitespace; length bounded so patterns stay cheap.
const TARGET = /^[^\s\p{Cc}]{1,512}$/u;

/**
 * Parses permission texts, expanding `*` and aliases into known area/action pairs. Each text that
 * is not a permission, or names no known area or action, is reported and contributes nothing.
 */
export function parsePermissions(texts: readonly string[]): {
  permissions: Permission[];
  problems: string[];
} {
  const permissions: Permission[] = [];
  const problems: string[] = [];
  for (const text of texts) {
    const found = parseOne(text);
    if (typeof found === "string") problems.push(`'${text}': ${found}`);
    else permissions.push(...found);
  }
  return { permissions, problems };
}

function parseOne(text: string): Permission[] | string {
  const colon = text.indexOf(":");
  const head = colon < 0 ? text : text.slice(0, colon);
  const target = colon < 0 ? undefined : text.slice(colon + 1);
  const [area, action, ...rest] = head.split(".");
  if (area === undefined || action === undefined || rest.length > 0)
    return "not of the form area.action[:target]";
  if (!SEGMENT.test(area) || !SEGMENT.test(action))
    return "an area or action is a lowercase name or *";
  if (target !== undefined && !TARGET.test(target)) return "an empty or malformed target";
  const areas = area === "*" ? Object.keys(AREAS).filter((a) => !AREAS[a]?.byName) : [area];
  const out: Permission[] = [];
  for (const a of areas) {
    const spec = AREAS[a];
    if (!spec) return `unknown area '${area}'`;
    const actions =
      action === "*"
        ? spec.actions
        : (spec.aliases?.[action] ?? (spec.actions.includes(action) ? [action] : []));
    // Hosts are matched as written, so a pattern's host is kept in lowercase; the egress gateway
    // asks with lowercase hosts.
    const t = target !== undefined && spec.target === "host" ? lowerHost(target) : target;
    for (const c of actions)
      out.push(t === undefined ? { area: a, action: c } : { area: a, action: c, target: t });
  }
  if (out.length === 0) return `unknown action '${action}'`;
  return out;
}

function lowerHost(target: string): string {
  const [h, p] = splitHost(target);
  return h.toLowerCase() + p;
}

const kindOf = (area: string): TargetKind => AREAS[area]?.target ?? "name";

// --- The plain matcher ------------------------------------------------------------------------

function globSegment(pattern: string, text: string): boolean {
  // `*` matches any run of characters within the segment (or within the name, for `name`).
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === text;
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (!text.startsWith(first) || text.length < first.length + last.length || !text.endsWith(last))
    return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    const i = text.indexOf(mid, at);
    if (i < 0 || i + mid.length > end) return false;
    at = i + mid.length;
  }
  return true;
}

const segments = (p: string) => p.split("/").filter(Boolean);

function pathMatches(pattern: string, path: string): boolean {
  if (!path.startsWith("/")) return false;
  const pat = segments(pattern);
  const segs = segments(path);
  // A pattern covers what it names and everything under it.
  const walk = (i: number, j: number): boolean => {
    if (i === pat.length) return true;
    const p = pat[i] as string;
    if (p === "**") {
      for (let k = j; k <= segs.length; k++) if (walk(i + 1, k)) return true;
      return false;
    }
    return j < segs.length && globSegment(p, segs[j] as string) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

function subjectMatches(pattern: string, subject: string): boolean {
  const pat = pattern.split(".");
  const toks = subject.split(".");
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i];
    if (p === ">" && i === pat.length - 1) return toks.slice(i).join(".").length > 0;
    if (i >= toks.length) return false;
    if (p === "*" ? toks[i] === "" : p !== toks[i]) return false;
  }
  return toks.length === pat.length;
}

function splitHost(target: string): [string, string] {
  const slash = target.indexOf("/");
  return slash < 0 ? [target, ""] : [target.slice(0, slash), target.slice(slash)];
}

function hostMatches(pattern: string, target: string): boolean {
  const [ph, pp] = splitHost(pattern);
  const [th, tp] = splitHost(target);
  const hostOk = ph.startsWith("*.")
    ? th.endsWith(ph.slice(1)) && th.length > ph.length - 1
    : ph === th;
  if (!hostOk) return false;
  const prefix = segments(pp);
  const segs = segments(tp);
  return prefix.length <= segs.length && prefix.every((s, i) => s === segs[i]);
}

function targetMatches(kind: TargetKind, pattern: string, target: string): boolean {
  switch (kind) {
    case "path":
      return pathMatches(pattern, target);
    case "subject":
      return subjectMatches(pattern, target);
    case "host":
      return hostMatches(pattern, target);
    default:
      return globSegment(pattern, target);
  }
}

/** Whether these permissions grant the request: the reference for the Datalog translation. */
export function permits(permissions: readonly Permission[], req: AccessRequest): boolean {
  return permissions.some(
    (p) =>
      p.area === req.area &&
      p.action === req.action &&
      (p.target === undefined || targetMatches(kindOf(p.area), p.target, req.target ?? "")),
  );
}

// --- The translation to Datalog ---------------------------------------------------------------

// Any character, newlines included, as the plain matcher counts them.
const ANY_CHAR = "[\\s\\S]";
const ANY = `${ANY_CHAR}*`;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const globRegex = (s: string, any: string) => s.split("*").map(escapeRegex).join(any);

/** The anchored regular expression a target pattern compiles to. */
export function targetRegex(kind: TargetKind, pattern: string): string {
  switch (kind) {
    case "path": {
      const body = segments(pattern)
        .map((s) => (s === "**" ? "(?:/[^/]+)*" : `/(?=[^/])${globRegex(s, "[^/]*")}`))
        .join("");
      return `^${body}(?:/${ANY})?$`;
    }
    case "subject": {
      const toks = pattern.split(".");
      const body = toks
        .map((t, i) =>
          t === ">" && i === toks.length - 1
            ? `${ANY_CHAR}+`
            : t === "*"
              ? "[^.]+"
              : escapeRegex(t),
        )
        .join("\\.");
      return `^${body}$`;
    }
    case "host": {
      const [h, p] = splitHost(pattern);
      const host = h.startsWith("*.") ? `[^/]+${escapeRegex(h.slice(1))}` : escapeRegex(h);
      const path = segments(p)
        .map((s) => `/${escapeRegex(s)}`)
        .join("");
      return `^${host}${path}(?:/${ANY})?$`;
    }
    default:
      return `^${globRegex(pattern, ANY)}$`;
  }
}

/**
 * Permissions as Datalog facts: `grant_any(area, action)` for a permission without a target, and
 * `grant_target(area, action, regex)` for one with a target, the target compiled to an anchored
 * regular expression the policy matches `target($t)` against. Strings travel as parameters.
 */
export function permissionsToDatalog(permissions: readonly Permission[]): {
  code: string;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  const lines: string[] = [];
  permissions.forEach((p, i) => {
    params[`a${i}`] = p.area;
    params[`c${i}`] = p.action;
    if (p.target === undefined) lines.push(`grant_any({a${i}}, {c${i}});`);
    else {
      params[`t${i}`] = targetRegex(kindOf(p.area), p.target);
      lines.push(`grant_target({a${i}}, {c${i}}, {t${i}});`);
    }
  });
  return { code: lines.join("\n"), params };
}

/** One role's contribution: what it grants, and the checks that narrow it. */
export interface RoleGrant {
  role: string;
  permissions: Permission[];
  /** Datalog `check` statements, validated: they can only narrow. */
  checks: string[];
}

/** The policy every role is decided by: a grant matching the operation, and nothing else. */
export const ROLE_POLICY = `allow if operation($a, $c), grant_any($a, $c);
allow if operation($a, $c), grant_target($a, $c, $re), target($t), $t.matches($re);
deny if true;`;

/** The request as authorizer facts (`operation(area, action)`, `target(t)`), and their parameters. */
export function requestFacts(req: AccessRequest): { code: string; params: Params } {
  return {
    code: "operation({req_area}, {req_action});\ntarget({req_target});",
    params: { req_area: req.area, req_action: req.action, req_target: req.target ?? "" },
  };
}

/** One role's authorizer code for a request: facts, grants, its checks and the policy. */
export function roleAuthorizer(
  grant: RoleGrant,
  req: AccessRequest,
  extra: { code: string; params: Params } = { code: "", params: {} },
): { code: string; params: Params } {
  const facts = requestFacts(req);
  const grants = permissionsToDatalog(grant.permissions);
  return {
    code: [extra.code, facts.code, grants.code, ...grant.checks, ROLE_POLICY].join("\n"),
    params: { ...extra.params, ...facts.params, ...grants.params },
  };
}

/**
 * Decides a request with no capability: allowed when any of the roles' authorizers allows it.
 * The gate decides the same way, under the session's capability (`WorkspaceAuthority`).
 */
export function decide(grants: readonly RoleGrant[], req: AccessRequest): boolean {
  return grants.some((g) => {
    try {
      const { code, params } = roleAuthorizer(g, req);
      return authorize(null, code, { params }).kind === "ok";
    } catch {
      return false;
    }
  });
}
