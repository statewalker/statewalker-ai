// The gated file view (statewalker/statewalker-root#80): what one agent session sees of its
// workspace. Every path is normalised, then every entry an operation touches is authorized. The
// project's system folder is a structural ENOENT: it is not there, under any path form, whatever
// the role. Writes, folders and deletes are authorized as `files.write` and `files.delete`, with the
// method and content, so the gate can ask the mode and key an approval by the exact action
// (statewalker/statewalker-root#124). `mkdir -p` of an existing folder changes nothing, so it is
// authorized as a read, and never asks. Move and copy wait for a later ticket.
import { codedError, type FileAction } from "@statewalker/ai-access";
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
  /**
   * Throws (EACCES, or the gate's own "needs approval") unless the session may take this action on
   * this normalised path now. `op` names the file method and, for a write, its content.
   */
  authorize(action: FileAction, path: string, op: FileOp): Promise<void>;
}

/** The file method an authorization is for, and a write's content. */
export interface FileOp {
  method: "read" | "list" | "stats" | "exists" | "write" | "mkdir" | "remove";
  content?: Uint8Array;
}

async function collect(content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
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

/** Whether a normalised path is a system folder or under one. */
export const inSystemFolder = (path: string, systemFolder: string): boolean =>
  path.split("/")[2] === systemFolder;

const notYet = (): never => {
  throw codedError("ENOSYS", "move and copy are not in the file view yet");
};

export function gatedFiles(store: FilesApi, options: GatedFilesOptions): FilesApi {
  const hidden = (path: string) => inSystemFolder(path, options.systemFolder);
  /** The normalised path, after the structural check and authorization. */
  const check = async (raw: string, action: FileAction, op: FileOp): Promise<string> => {
    const path = normalise(raw);
    if (hidden(path)) throw codedError("ENOENT", `no such file or directory, '${raw}'`);
    await options.authorize(action, path, op);
    return path;
  };
  /** A path an agent may change: inside a project, never a project's folder itself. */
  const changeable = (raw: string): string => {
    const path = normalise(raw);
    if (path.split("/").length < 3) throw codedError("EACCES", `may not change '${raw}'`);
    return path;
  };
  return {
    async *read(raw: string, readOptions?: ReadOptions): AsyncIterable<Uint8Array> {
      yield* store.read(await check(raw, "read", { method: "read" }), readOptions);
    },
    async *list(raw: string, listOptions?: ListOptions): AsyncIterable<FileInfo> {
      for await (const entry of store.list(
        await check(raw, "list", { method: "list" }),
        listOptions,
      ))
        if (!hidden(entry.path)) yield entry;
    },
    async stats(raw: string): Promise<FileStats | undefined> {
      return store.stats(await check(raw, "read", { method: "stats" }));
    },
    async exists(raw: string): Promise<boolean> {
      return store.exists(await check(raw, "read", { method: "exists" }));
    },
    async write(raw, content) {
      const bytes = await collect(content);
      changeable(raw);
      await store.write(await check(raw, "write", { method: "write", content: bytes }), [bytes]);
    },
    async mkdir(raw) {
      const path = changeable(raw);
      if (!hidden(path) && (await store.stats(path))?.kind === "directory") {
        // Nothing changes: a read of the folder, never an ask.
        await check(raw, "read", { method: "stats" });
        return;
      }
      await store.mkdir(await check(raw, "write", { method: "mkdir" }));
    },
    async remove(raw) {
      changeable(raw);
      return store.remove(await check(raw, "delete", { method: "remove" }));
    },
    move: notYet,
    copy: notYet,
  };
}
