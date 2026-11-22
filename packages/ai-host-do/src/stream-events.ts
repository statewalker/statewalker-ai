// A write stream of the files-RPC protocol spans several calls (openWrite, writeChunk...,
// closeWrite), each an event of its own in the Workspace DO, but the FilesApi write behind it is
// started by openWrite and runs as continuations of that event. CellD refuses a storage
// transaction (the input gate) to a continuation of an event that has ended
// (statewalker/statewalker-root#141), so the opening event is kept alive (`ctx.waitUntil`) until
// its stream ends: closed, aborted, or idle as long as the files-RPC server keeps a stream. On
// workerd and CellB this only keeps a promise pending; the protocol and the session API are the
// same on every runtime.
import type { FilesRpcMethod } from "@statewalker/ai-environment";

/** One files-RPC call on the file view `holder` holds. */
export type HeldFilesCall = (
  holder: string,
  method: FilesRpcMethod,
  args: unknown[],
) => Promise<unknown>;

/** How long a write stream may sit idle before its event is let go (the files-RPC server's sweep). */
const IDLE_MS = 10 * 60_000;

export function keepStreamEventsAlive(
  call: HeldFilesCall,
  keepAlive: (until: Promise<unknown>) => void,
  options: { idleMs?: number } = {},
): HeldFilesCall {
  const idleMs = options.idleMs ?? IDLE_MS;
  const open = new Map<string, { end(): void; touch(): void }>();
  const ending = (method: FilesRpcMethod) => method === "closeWrite" || method === "abortWrite";
  // Stream ids are the holder's server's own: keyed by holder too.
  const key = (holder: string, streamId: unknown) => `${holder}\n${String(streamId)}`;
  return async (holder, method, args) => {
    const stream = method === "openWrite" ? undefined : open.get(key(holder, args[0]));
    stream?.touch();
    try {
      const result = await call(holder, method, args);
      if (method === "openWrite") {
        const id = key(holder, (result as { streamId?: unknown } | undefined)?.streamId);
        if (!open.has(id)) {
          let end = () => {};
          let timer: ReturnType<typeof setTimeout> | undefined;
          const until = new Promise<void>((resolve) => {
            end = () => {
              clearTimeout(timer);
              open.delete(id);
              resolve();
            };
          });
          const touch = () => {
            clearTimeout(timer);
            timer = setTimeout(end, idleMs);
          };
          touch();
          open.set(id, { end, touch });
          keepAlive(until);
        }
      }
      return result;
    } finally {
      if (stream && ending(method)) stream.end();
    }
  };
}
