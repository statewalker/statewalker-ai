// The file protocol between a holder of a file view (an agent session) and the gate (the
// Workspace DO), as plain request/answer values a Durable Object RPC stub carries. Inside one
// deployment the channel is the stub; the chunked webrun-files-rpc streams over a webrun-wire
// channel replace this in a later ticket. The tracer's reads move whole files.

import type { FileInfo, FileStats, FilesApi } from "@statewalker/webrun-files";
import { readFile } from "@statewalker/webrun-files";

export type FileCall =
  | { method: "stats"; path: string }
  | { method: "exists"; path: string }
  | { method: "list"; path: string; recursive?: boolean }
  | { method: "read"; path: string };

/** Answers one call on a file view: `read` gives the bytes of a file, or null for no file. */
export async function answerFileCall(files: FilesApi, call: FileCall): Promise<unknown> {
  switch (call.method) {
    case "stats":
      return (await files.stats(call.path)) ?? null;
    case "exists":
      return files.exists(call.path);
    case "list": {
      const entries: FileInfo[] = [];
      for await (const e of files.list(call.path, { recursive: call.recursive })) entries.push(e);
      return entries;
    }
    case "read": {
      const stats = await files.stats(call.path);
      return stats?.kind === "file" ? readFile(files, call.path) : null;
    }
    default:
      throw new Error(`ENOSYS: file call '${(call as { method: string }).method}'`);
  }
}

const readOnly = (): never => {
  throw new Error("ENOSYS: the file view is read-only for now");
};

/** A FilesApi whose every call is sent to the gate. */
export function filesOverCalls(send: (call: FileCall) => Promise<unknown>): FilesApi {
  return {
    async *read(path, options) {
      const bytes = (await send({ method: "read", path })) as Uint8Array | null;
      const start = options?.start ?? 0;
      const end = options?.length === undefined ? undefined : start + options.length;
      const slice = bytes?.subarray(start, end);
      if (slice?.length) yield slice;
    },
    async *list(path, options) {
      yield* (await send({ method: "list", path, recursive: options?.recursive })) as FileInfo[];
    },
    async stats(path) {
      return ((await send({ method: "stats", path })) as FileStats | null) ?? undefined;
    },
    async exists(path) {
      return (await send({ method: "exists", path })) as boolean;
    },
    write: readOnly,
    mkdir: readOnly,
    remove: readOnly,
    move: readOnly,
    copy: readOnly,
  };
}
