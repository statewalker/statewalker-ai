// Roles and role sources (statewalker/statewalker-root#77). A role is a set of permissions; a
// role entry is a permission, `role:<name>` (another role's permissions and restrictions), or a
// Datalog `check`, which can only narrow what the role grants. Built-in roles: owner, editor and
// reader in every project, and the workspace admin. Custom roles are defined per project in its
// role source. Roles are resolved at every action, never fixed at a session's start.
import { parseAuthorizer } from "@statewalker/webrun-biscuit";
import { codedError } from "./errors.js";
import { parsePermissions, type RoleGrant } from "./permissions.js";

export const DEFAULT_SYSTEM_FOLDER = ".system";
export const ACCESS_FILE = "access";
export const ROLES_FILE = "roles";

/** A role's entries: an array, or one string of comma-separated permissions and `role:` names. */
export type RoleEntries = string | readonly string[];

/** The built-in roles of every project. */
export const BUILT_IN_ROLES: Readonly<Record<string, readonly string[]>> = {
  owner: ["*.*"],
  editor: [
    "files.read",
    "files.list",
    "files.write",
    "files.delete",
    "comments.*",
    "tools.call",
    "db.*",
    "models.use",
    "memory.write:project",
    "memory.write:agent",
    "triggers.write:own",
    "tasks.publish:>",
    "tasks.subscribe:>",
    // The server-only task prefixes (#160) are the server's to publish and consume.
    'check if operation($a, $c), target($t), $a != "tasks" || !($t.starts_with("hooks.") || $t.starts_with("schedule."));',
  ],
  reader: ["files.read", "files.list", "comments.read"],
};

/** The workspace-level roles: the workspace admin manages projects and members, not files. */
export const WORKSPACE_ROLES: Readonly<Record<string, readonly string[]>> = {
  admin: [
    "projects.create",
    "members.read",
    "members.manage",
    "usage.read:workspace",
    "limits.write:workspace",
    "limits.write:project",
    "limits.write:member",
    "triggers.write:project",
  ],
};

const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const entriesOf = (entries: RoleEntries): string[] =>
  typeof entries === "string"
    ? entries
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
    : [...entries];

/** A Datalog entry: accepted only when every statement in it is a check, so it only narrows. */
function checkEntry(text: string): string | { problem: string } {
  const code = text.trim().endsWith(";") ? text.trim() : `${text.trim()};`;
  // A role's checks run joined into one program: a comment left open in one entry would hide
  // the next entry's checks or the policy, so comments are refused.
  if (/\/\*|\*\/|\/\//.test(code)) return { problem: "Datalog in a role may not hold comments" };
  try {
    const parsed = parseAuthorizer(code);
    if (
      parsed.checks.length === 0 ||
      parsed.facts.length > 0 ||
      parsed.rules.length > 0 ||
      parsed.policies.length > 0 ||
      parsed.scopes.length > 0
    )
      return { problem: "Datalog in a role may only hold checks" };
  } catch (e) {
    return { problem: `not valid Datalog (${(e as Error).message})` };
  }
  return code;
}

function joinedChecksHold(checks: readonly string[]): boolean {
  if (checks.length === 0) return true;
  try {
    const each = checks.reduce((n, c) => n + parseAuthorizer(c).checks.length, 0);
    const joined = parseAuthorizer(checks.join("\n"));
    return (
      joined.checks.length === each &&
      joined.facts.length + joined.rules.length + joined.policies.length + joined.scopes.length ===
        0
    );
  } catch {
    return false;
  }
}

const isDatalog = (entry: string) => /[\s(;]/.test(entry) && !entry.startsWith("role:");

/**
 * The grants of the roles a user holds, one per role, each with its permissions (its own and its
 * included roles') and its checks (inherited too). Unknown roles, unknown permissions, Datalog
 * that is not only checks, built-in names redefined, and cycles are reported and grant nothing.
 */
export function resolveRoles(
  held: readonly string[],
  definitions: Readonly<Record<string, RoleEntries>>,
): { grants: RoleGrant[]; problems: string[] } {
  const problems: string[] = [];
  const builtIn = (name: string) =>
    Object.hasOwn(BUILT_IN_ROLES, name)
      ? BUILT_IN_ROLES[name]
      : Object.hasOwn(WORKSPACE_ROLES, name)
        ? WORKSPACE_ROLES[name]
        : undefined;
  for (const name of Object.keys(definitions))
    if (builtIn(name)) problems.push(`role '${name}': a built-in role cannot be redefined`);
  const entriesFor = (name: string): string[] | undefined => {
    const own = builtIn(name);
    if (own) return [...own];
    if (!ROLE_NAME.test(name) || !Object.hasOwn(definitions, name)) return undefined;
    return entriesOf(definitions[name] as RoleEntries);
  };

  const cache = new Map<string, RoleGrant | null>();
  const resolve = (name: string, path: string[]): RoleGrant | null => {
    if (path.includes(name)) throw new Cycle([...path, name]);
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const entries = entriesFor(name);
    if (!entries) {
      problems.push(`role '${name}' is not defined`);
      cache.set(name, null);
      return null;
    }
    const grant: RoleGrant = { role: name, permissions: [], checks: [] };
    const permissionTexts: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith("role:")) {
        const included = resolve(entry.slice(5).trim(), [...path, name]);
        if (included) {
          grant.permissions.push(...included.permissions);
          grant.checks.push(...included.checks);
        }
      } else if (isDatalog(entry)) {
        const check = checkEntry(entry);
        if (typeof check === "string") grant.checks.push(check);
        else problems.push(`role '${name}': ${check.problem}`);
      } else permissionTexts.push(entry);
    }
    const parsed = parsePermissions(permissionTexts);
    grant.permissions.push(...parsed.permissions);
    for (const p of parsed.problems) problems.push(`role '${name}': ${p}`);
    grant.checks = [...new Set(grant.checks)];
    // The checks as they will run, joined: still checks only, as many as accepted; otherwise
    // the role grants nothing rather than lose a restriction.
    if (!joinedChecksHold(grant.checks)) {
      problems.push(`role '${name}': its checks do not hold together`);
      grant.permissions = [];
    }
    cache.set(name, grant);
    return grant;
  };

  const grants: RoleGrant[] = [];
  for (const name of new Set(held)) {
    try {
      const grant = resolve(name, []);
      if (grant) grants.push(grant);
    } catch (e) {
      if (!(e instanceof Cycle)) throw e;
      problems.push(`role '${name}': a cycle of roles (${e.path.join(" → ")})`);
    }
  }
  return { grants, problems };
}

class Cycle extends Error {
  constructor(readonly path: string[]) {
    super("cycle");
  }
}

// --- Role sources -----------------------------------------------------------------------------

/** What a role source holds of one project for one user. */
export interface ProjectAccess {
  /** The roles the user holds in the project (none for a non-member). */
  roles: string[];
  /** The project's custom roles. */
  definitions: Record<string, RoleEntries>;
}

/**
 * A role source answers, per project, who the members are, which roles a user holds, and what
 * each role grants; and which workspace-level roles a user holds. `undefined` means the source
 * knows nothing of the project, so a chain asks the next one.
 */
export interface RoleSource {
  access(project: string, user: string): Promise<ProjectAccess | undefined>;
  members(project: string): Promise<Record<string, string[]> | undefined>;
  workspaceRoles(user: string): Promise<string[]>;
}

/** Where a project's access file lives in its workspace; the workspace's own has no project. */
export const accessFilePath = (project: string, systemFolder = DEFAULT_SYSTEM_FOLDER): string =>
  project ? `/${project}/${systemFolder}/${ACCESS_FILE}` : `/${systemFolder}/${ACCESS_FILE}`;

export const rolesFilePath = (project: string, systemFolder = DEFAULT_SYSTEM_FOLDER): string =>
  `/${project}/${systemFolder}/${ROLES_FILE}`;

function jsonObject(text: string | undefined, what: string): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw codedError("EIO", `${what} is not JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw codedError("EIO", `${what} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/**
 * The members of a project and their roles, from the access file's text: `{ "<user>": "<role>" }`
 * or `{ "<user>": ["<role>", …] }`. Entries of any other shape are skipped.
 */
export function parseAccessFile(text: string | undefined): Record<string, string[]> {
  const members: Record<string, string[]> = {};
  for (const [user, roles] of Object.entries(jsonObject(text, "the access file") ?? {})) {
    if (typeof roles === "string") members[user] = [roles];
    else if (Array.isArray(roles)) members[user] = roles.filter((r) => typeof r === "string");
  }
  return members;
}

/** A project's custom roles, from the roles file's text: `{ "<role>": entries }`. */
export function parseRolesFile(text: string | undefined): Record<string, RoleEntries> {
  const roles: Record<string, RoleEntries> = {};
  for (const [name, entries] of Object.entries(jsonObject(text, "the roles file") ?? {})) {
    if (typeof entries === "string") roles[name] = entries;
    else if (Array.isArray(entries)) roles[name] = entries.filter((e) => typeof e === "string");
  }
  return roles;
}

/**
 * The access file role source: each project's `<system folder>/access` (members and their roles)
 * and `<system folder>/roles` (custom roles) beside it; the workspace's own `/<system
 * folder>/access` names workspace-level roles. A project is known when its access file exists.
 */
export function fileRoleSource(
  readText: (path: string) => Promise<string | undefined>,
  systemFolder = DEFAULT_SYSTEM_FOLDER,
): RoleSource {
  const members = async (project: string) => {
    const text = await readText(accessFilePath(project, systemFolder));
    return text === undefined ? undefined : parseAccessFile(text);
  };
  return {
    members,
    async access(project, user) {
      const all = await members(project);
      if (!all) return undefined;
      const roles = Object.hasOwn(all, user) ? (all[user] ?? []) : [];
      const definitions =
        roles.length === 0
          ? {}
          : parseRolesFile(await readText(rolesFilePath(project, systemFolder)));
      return { roles, definitions };
    },
    async workspaceRoles(user) {
      const all = parseAccessFile(await readText(accessFilePath("", systemFolder)));
      return Object.hasOwn(all, user) ? (all[user] ?? []) : [];
    },
  };
}

/**
 * Several role sources as one: each project is answered by the first source that knows it, so a
 * project has one authority; workspace-level roles are the union of every source's.
 */
export function chainRoleSources(sources: readonly RoleSource[]): RoleSource {
  return {
    async access(project, user) {
      for (const s of sources) {
        const found = await s.access(project, user);
        if (found) return found;
      }
      return undefined;
    },
    async members(project) {
      for (const s of sources) {
        const found = await s.members(project);
        if (found) return found;
      }
      return undefined;
    },
    async workspaceRoles(user) {
      const all = await Promise.all(sources.map((s) => s.workspaceRoles(user)));
      return [...new Set(all.flat())];
    },
  };
}

/** A user's access to a project now: whether they are a member, and what their roles grant. */
export interface UserAccess {
  /** A member holds at least one project role that resolves; membership gives visibility. */
  member: boolean;
  /** The project roles' grants, then the workspace-level roles'. */
  grants: RoleGrant[];
  problems: string[];
}

export async function accessOf(
  source: RoleSource,
  project: string,
  user: string,
): Promise<UserAccess> {
  const [found, wsRoles] = await Promise.all([
    source.access(project, user),
    source.workspaceRoles(user),
  ]);
  // Workspace-level roles are only those; project roles only project ones.
  const projectHeld = (found?.roles ?? []).filter((r) => !Object.hasOwn(WORKSPACE_ROLES, r));
  const inProject = resolveRoles(projectHeld, found?.definitions ?? {});
  const ws = resolveRoles(
    wsRoles.filter((r) => Object.hasOwn(WORKSPACE_ROLES, r)),
    {},
  );
  return {
    member: inProject.grants.length > 0,
    grants: [...inProject.grants, ...ws.grants],
    problems: [...inProject.problems, ...ws.problems],
  };
}
