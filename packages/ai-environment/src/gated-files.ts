// The gated file view (statewalker/statewalker-root#80): what one agent session sees of its
// workspace. Every path is normalised, then every entry an operation touches is authorized. The
// project's system folder is a structural ENOENT: it is not there, under any path form, whatever
// the role. The view is read-only until modes and approvals arrive (a later ticket).
import { codedError } from "@statewalker/ai-access";
import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import { normalise } from "./paths.js";

export interface GatedFilesOptions {
  /** The session's project: a first-level folder of the workspace. */
  project: string;
  /** The project's system folder's name (default `.system`). */
  systemFolder: string;
  /** Throws (EACCES) unless the session may take this action on this normalised path now. */
  authorize(action: "read", path: string): Promise<void>;
}

/** Whether a normalised path is a system folder or under one. */
export const inSystemFolder = (path: string, systemFolder: string): boolean =>
  path.split("/")[2] === systemFolder;

const readOnly = (): never => {
  throw codedError("ENOSYS", "the file view is read-only for now");
};

export function gatedFiles(store: FilesApi, options: GatedFilesOptions): FilesApi {
  const hidden = (path: string) => inSystemFolder(path, options.systemFolder);
  /** The normalised path, after the structural check and authorization. */
  const check = async (raw: string): Promise<string> => {
    const path = normalise(raw);
    if (hidden(path)) throw codedError("ENOENT", `no such file or directory, '${raw}'`);
    await options.authorize("read", path);
    return path;
  };
  return {
    async *read(raw: string, readOptions?: ReadOptions): AsyncIterable<Uint8Array> {
      yield* store.read(await check(raw), readOptions);
    },
    async *list(raw: string, listOptions?: ListOptions): AsyncIterable<FileInfo> {
      for await (const entry of store.list(await check(raw), listOptions))
        if (!hidden(entry.path)) yield entry;
    },
    async stats(raw: string): Promise<FileStats | undefined> {
      return store.stats(await check(raw));
    },
    async exists(raw: string): Promise<boolean> {
      return store.exists(await check(raw));
    },
    write: readOnly,
    mkdir: readOnly,
    remove: readOnly,
    move: readOnly,
    copy: readOnly,
  };
}
