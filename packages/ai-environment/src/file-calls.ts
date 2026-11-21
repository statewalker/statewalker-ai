// The file protocol between a holder of a file view (an agent session) and the gate (the
// Workspace DO), as plain request/answer values a Durable Object RPC stub carries. Inside one
// deployment the channel is the stub; the chunked webrun-files-rpc streams over a webrun-wire
// channel replace this in a later ticket. The tracer's reads move whole files.

import type { ApprovalRequest } from "@statewalker/ai-access";
import type { FileInfo, FileStats, FilesApi } from "@statewalker/webrun-files";
import { readFile } from "@statewalker/webrun-files";

export type FileCall =
  | { method: "stats"; path: string }
  | { method: "exists"; path: string }
  | { method: "list"; path: string; recursive?: boolean }
  | { method: "read"; path: string }
  | { method: "write"; path: string; content: Uint8Array }
  | { method: "mkdir"; path: string }
  | { method: "remove"; path: string };

/** How the gate answers a call that waits on an approval, instead of a result. */
export interface ApprovalAnswerOfGate {
  $approval: ApprovalRequest;
}

export const isApprovalAnswer = (v: unknown): v is ApprovalAnswerOfGate =>
  !!v && typeof v === "object" && "$approval" in v;

/** Thrown in the holder when a call waits on an approval. */
export class ApprovalPending extends Error {
  constructor(readonly request: ApprovalRequest) {
    super(`waiting on the user's approval ${request.id}: ${request.reason}`);
    this.name = "ApprovalPending";
  }
}

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
    case "write":
      await files.write(call.path, [call.content]);
      return null;
    case "mkdir":
      await files.mkdir(call.path);
      return null;
    case "remove":
      return files.remove(call.path);
    default:
      throw new Error(`ENOSYS: file call '${(call as { method: string }).method}'`);
  }
}

const notYet = (): never => {
  throw new Error("ENOSYS: move and copy are not in the file view yet");
};

/**
 * A FilesApi whose every call is sent to the gate. A call the gate answers with an approval request
 * is reported to `onApproval` (with the exact call, to store) and fails with `ApprovalPending`;
 * after that, every later change through this view fails the same way without reaching the gate,
 * since the turn ends at the pending call (Flue's write tool otherwise tries `mkdir -p` of the
 * parent and the write again, which would ask about a folder nobody asked to create).
 */
export function filesOverCalls(
  sendCall: (call: FileCall) => Promise<unknown>,
  onApproval?: (request: ApprovalRequest, call: FileCall) => void,
): FilesApi {
  let waitingOn: ApprovalRequest | undefined;
  const send = async (call: FileCall) => {
    const changes = call.method === "write" || call.method === "mkdir" || call.method === "remove";
    if (changes && waitingOn) throw new ApprovalPending(waitingOn);
    const answer = await sendCall(call);
    if (isApprovalAnswer(answer)) {
      waitingOn ??= answer.$approval;
      onApproval?.(answer.$approval, call);
      throw new ApprovalPending(answer.$approval);
    }
    return answer;
  };
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
    async write(path, content) {
      const parts: Uint8Array[] = [];
      for await (const part of content) parts.push(part);
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      await send({ method: "write", path, content: bytes });
    },
    async mkdir(path) {
      await send({ method: "mkdir", path });
    },
    async remove(path) {
      return (await send({ method: "remove", path })) as boolean;
    },
    move: notYet,
    copy: notYet,
  };
}
