// Profiles (statewalker/statewalker-root#157): the deployment has one profiles file system, mounted
// when it starts, with one top-level folder per user: `profiles/<user>/`. A user's User DO sees only
// its user's folder, as a FilesApi rooted there: every path is normalised inside that root, so no
// path form reaches another user's folder, and a user name must be one path segment.
import { codedError } from "@statewalker/ai-access";
import type { Db } from "@statewalker/db-api";
import type { FileInfo, FilesApi, ListOptions } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { normalise } from "./paths.js";

/** The folder of the profiles file system that holds every user's profile. */
export const PROFILES_ROOT = "/profiles";

/** A user name that is one path segment, never "." or "..". */
const USER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

/** Where a user's profile lives in the profiles file system. */
export function profilePath(user: string): string {
  if (!USER.test(user)) throw codedError("EINVAL", "a user name must be one path segment");
  return `${PROFILES_ROOT}/${user}`;
}

/** A FilesApi showing `root` of `files` as its own `/`; nothing outside it is reachable. */
export function rootedFiles(files: FilesApi, root: string): FilesApi {
  const base = normalise(root);
  const inside = (p: string) => {
    const rel = normalise(p);
    return rel === "/" ? base : `${base}${rel}`;
  };
  const outside = (p: string) => (p === base ? "/" : p.slice(base.length));
  return {
    read: (p, options) => files.read(inside(p), options),
    write: (p, content) => files.write(inside(p), content),
    mkdir: (p) => files.mkdir(inside(p)),
    async *list(p, options?: ListOptions): AsyncIterable<FileInfo> {
      const opts =
        options?.after === undefined ? options : { ...options, after: inside(options.after) };
      for await (const e of files.list(inside(p), opts))
        if (e.path.startsWith(`${base}/`)) yield { ...e, path: outside(e.path) };
    },
    stats: (p) => files.stats(inside(p)),
    exists: (p) => files.exists(inside(p)),
    remove: (p) => {
      // The root itself stays: removing "/" empties it.
      if (inside(p) === base) throw codedError("EINVAL", "cannot remove the root");
      return files.remove(inside(p));
    },
    move: (s, t) => files.move(inside(s), inside(t)),
    copy: (s, t) => files.copy(inside(s), inside(t)),
  };
}

/** One user's profile: their folder of the profiles file system, as its own root. */
export function profileFiles(profiles: FilesApi, user: string): FilesApi {
  return rootedFiles(profiles, profilePath(user));
}

/** The backends the profiles file system can be mounted from (deployment configuration). */
export type ProfilesBackend = "sql" | "memory";

/**
 * The profiles file system from the deployment's configuration: SqlFs (webrun-files-sqlite) on the
 * hosting Durable Object's SQLite (the default), or memory, which a restart empties. `db` opens the
 * database, only for the SQL backend.
 */
export async function mountProfiles(backend: string | undefined, db: () => Db): Promise<FilesApi> {
  if (backend === undefined || backend === "" || backend === "sql") {
    const files = new SqliteFilesApi(db(), { tablePrefix: "profiles_" });
    await files.init();
    return files;
  }
  if (backend === "memory") return new MemFilesApi();
  throw codedError("EINVAL", `unknown profiles backend '${backend}'`);
}
