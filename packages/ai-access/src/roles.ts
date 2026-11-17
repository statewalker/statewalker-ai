// Roles from a project's access file (the default role source, statewalker/statewalker-root#77):
// `<project>/<system folder>/access` holds `{ "<user>": "<role>" }`. Membership is having a role.
import { codedError } from "./errors.js";

export const DEFAULT_SYSTEM_FOLDER = ".system";
export const ACCESS_FILE = "access";

/** Where a project's access file lives in its workspace. */
export const accessFilePath = (project: string, systemFolder = DEFAULT_SYSTEM_FOLDER): string =>
  `/${project}/${systemFolder}/${ACCESS_FILE}`;

/** The members of a project and their roles, from the access file's text. */
export function parseAccessFile(text: string | undefined): Record<string, string> {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw codedError("EIO", "the project's access file is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw codedError("EIO", "the project's access file is not an object of user → role");
  const roles: Record<string, string> = {};
  for (const [user, role] of Object.entries(parsed))
    if (typeof role === "string") roles[user] = role;
  return roles;
}

/** The built-in project roles; a role outside them grants nothing yet. */
export const BUILT_IN_ROLES = ["reader", "editor", "owner"] as const;
