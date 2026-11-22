// The file protocol (statewalker/statewalker-root#80, #122): every holder of a file view (an agent
// session, the user's own session, later sub-agents and tools) holds a FilesApi that is a
// webrun-files-rpc client; the gate serves a files-RPC server over the gated view. Inside a
// deployment the calls travel on a Durable Object stub, elsewhere on a webrun-wire channel. Reads
// and writes are chunked streams of `blockSize` bytes (1 MiB by default).
//
// Every chunk the server answers or takes is authorized again here, at the server's edge: the
// server reads ahead, so checking only where the gated view pulls a block would let chunks already
// read ahead through after a revocation. (webrun-files#61 will offer a hook for this.)
import { codedError } from "@statewalker/ai-access";
import type { FilesApi } from "@statewalker/webrun-files";
import {
  type FilesRpc,
  type FilesRpcServer,
  newFilesRpcClient,
  newFilesRpcServer,
} from "@statewalker/webrun-files-rpc";
import {
  DEFAULT_BLOCK_SIZE,
  type FileAction,
  type GatedFilesOptions,
  gatedFiles,
  type StreamChecks,
  streamChecks,
} from "./gated-files.js";
import { type ModeGate, modeGated } from "./mode-gate.js";
import { normalise } from "./paths.js";

/** The protocol's methods: the only ones a files-RPC endpoint answers. */
export const FILES_RPC_METHODS = [
  "openRead",
  "readChunk",
  "closeRead",
  "openWrite",
  "writeChunk",
  "closeWrite",
  "abortWrite",
  "list",
  "stats",
  "exists",
  "mkdir",
  "remove",
  "move",
  "copy",
] as const satisfies readonly (keyof FilesRpc)[];

export type FilesRpcMethod = (typeof FILES_RPC_METHODS)[number];

/** One call of the protocol, as a transport carries it. */
export type FilesRpcCall = (method: FilesRpcMethod, args: unknown[]) => Promise<unknown>;

/** A files-RPC server reached by method name, as a stub or a channel calls it. */
export interface FilesRpcEndpoint {
  call: FilesRpcCall;
  close(): Promise<void>;
}

/** The endpoint of a server: only the protocol's methods, with their arguments as a list. */
export function filesRpcEndpoint(server: FilesRpc & { close?(): unknown }): FilesRpcEndpoint {
  return {
    async call(method, args) {
      if (!(FILES_RPC_METHODS as readonly string[]).includes(method))
        throw codedError("ENOSYS", `no file method '${String(method)}'`);
      if (!Array.isArray(args)) throw codedError("EINVAL", "a file call's arguments are a list");
      return (server[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    async close() {
      await server.close?.();
    },
  };
}

/** Streams known to the guard: what each was opened for. */
const MAX_TRACKED = 1024;

/** A stream known to the guard: what it was opened for, and its refusal once one was decided. */
interface Tracked {
  action: FileAction;
  path: string;
  hidden: boolean;
  refused?: { error: unknown };
}

/**
 * A server whose every chunk is authorized again before it is answered or taken.
 *
 * Chunks of one stream are asked concurrently (the client reads and writes ahead), so their checks
 * race. Once one chunk is refused, the stream answers that refusal to every chunk: to those asked
 * later, to those whose check passes only afterwards, and to those already waiting at the server
 * when the refusal closed the stream (which would otherwise fail as an unknown or closed stream).
 * The refusal is kept until the holder closes or aborts the stream.
 */
function guarded(
  server: FilesRpcServer,
  checks: StreamChecks,
): FilesRpc & { close(): Promise<void> } {
  const streams = new Map<string, Tracked>();
  /** What a stream is opened for, and whether its path was hidden then. */
  const pathOf = async (raw: string) => {
    const path = normalise(raw);
    return { path, hidden: await checks.hidden(path) };
  };
  const track = (id: string, action: FileAction, p: { path: string; hidden: boolean }) => {
    streams.set(id, { action, ...p });
    if (streams.size > MAX_TRACKED) streams.delete(streams.keys().next().value as string);
  };
  /**
   * Authorizes one chunk of a stream: throws the stream's refusal if it has one, else checks again
   * and, on a refusal, keeps it and ends the stream at the server (`end`).
   */
  const authorizeChunk = async (s: Tracked | undefined, end: (e: unknown) => Promise<void>) => {
    if (!s) return;
    if (s.refused) throw s.refused.error;
    try {
      await checks.allowed(s.action, s.path, s.hidden);
    } catch (e) {
      // Another chunk may have been refused while this check ran: the first refusal stands.
      const first = refusalOf(s);
      if (first) throw first.error;
      s.refused = { error: e };
      await end(e);
      throw e;
    }
    // A check that passed after another chunk's refusal answers that refusal.
    const refused = refusalOf(s);
    if (refused) throw refused.error;
  };
  /** The stream's refusal, read again after an await (another chunk's check may have set it). */
  const refusalOf = (s: Tracked) => s.refused;
  /** Runs a server call of a stream; a failure after the stream's refusal is that refusal. */
  const served = async <T>(s: Tracked | undefined, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      if (s?.refused) throw s.refused.error;
      throw e;
    }
  };
  return {
    stats: (p) => server.stats(p),
    exists: (p) => server.exists(p),
    mkdir: (p, o) => server.mkdir(p, o),
    remove: (p, o) => server.remove(p, o),
    move: (s, t, o) => server.move(s, t, o),
    copy: (s, t, o) => server.copy(s, t, o),
    list: (p, o) => server.list(p, o),
    async openRead(path, options) {
      const p = await pathOf(path);
      const opened = await server.openRead(path, options);
      track(opened.streamId, "read", p);
      return opened;
    },
    async readChunk(streamId, chunkId) {
      const s = streams.get(streamId);
      await authorizeChunk(s, () => server.closeRead(streamId));
      return served(s, () => server.readChunk(streamId, chunkId));
    },
    async closeRead(streamId) {
      streams.delete(streamId);
      await server.closeRead(streamId);
    },
    async openWrite(path, options) {
      const p = await pathOf(path);
      const opened = await server.openWrite(path, options);
      track(opened.streamId, "write", p);
      return opened;
    },
    async writeChunk(streamId, chunkId, data) {
      const s = streams.get(streamId);
      await authorizeChunk(s, (e) =>
        server.abortWrite(streamId, String((e as Error)?.message ?? e)),
      );
      return served(s, () => server.writeChunk(streamId, chunkId, data));
    },
    async closeWrite(streamId, chunks) {
      const s = streams.get(streamId);
      try {
        if (s?.refused) throw s.refused.error;
        await served(s, () => server.closeWrite(streamId, chunks));
      } finally {
        streams.delete(streamId);
      }
    },
    async abortWrite(streamId, reason) {
      streams.delete(streamId);
      await server.abortWrite(streamId, reason);
    },
    close: () => server.close(),
  };
}

/**
 * The gate's files-RPC endpoint over a store, for one holder: the gated view, chunk by chunk; for
 * an agent session, with every operation decided by the mode too (`modeGate`).
 */
export function gatedFilesRpc(
  store: FilesApi,
  options: GatedFilesOptions,
  modeGate?: ModeGate,
): FilesRpcEndpoint {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const server = newFilesRpcServer({
    fs: modeGate ? modeGated(gatedFiles(store, options), modeGate) : gatedFiles(store, options),
    chunkSize: blockSize,
    maxChunkSize: Math.max(blockSize, 4 * 1024 * 1024),
  });
  return filesRpcEndpoint(guarded(server, streamChecks(options)));
}

/** A files-RPC endpoint per holder, kept while used, so streams live across calls. */
export class FilesRpcHost {
  readonly #make: (holder: string) => FilesRpcEndpoint | Promise<FilesRpcEndpoint>;
  readonly #servers = new Map<string, { endpoint: Promise<FilesRpcEndpoint>; used: number }>();
  readonly #max: number;
  readonly #idleMs: number;

  constructor(
    make: (holder: string) => FilesRpcEndpoint | Promise<FilesRpcEndpoint>,
    options: { max?: number; idleMs?: number } = {},
  ) {
    this.#make = make;
    this.#max = options.max ?? 256;
    this.#idleMs = options.idleMs ?? 10 * 60_000;
  }

  async call(holder: string, method: FilesRpcMethod, args: unknown[]): Promise<unknown> {
    const now = Date.now();
    for (const [key, s] of this.#servers) if (now - s.used > this.#idleMs) this.#drop(key);
    let entry = this.#servers.get(holder);
    if (!entry) {
      const endpoint = Promise.resolve().then(() => this.#make(holder));
      // A holder refused when its view opens (a forged capability) is not kept.
      endpoint.catch(() => {
        if (this.#servers.get(holder)?.endpoint === endpoint) this.#servers.delete(holder);
      });
      entry = { endpoint, used: now };
      this.#servers.set(holder, entry);
      if (this.#servers.size > this.#max) this.#drop(this.#servers.keys().next().value as string);
    }
    entry.used = now;
    // Most recently used last, so the first is the one to drop.
    this.#servers.delete(holder);
    this.#servers.set(holder, entry);
    return (await entry.endpoint).call(method, args);
  }

  #drop(holder: string): void {
    const s = this.#servers.get(holder);
    this.#servers.delete(holder);
    void s?.endpoint.then((e) => e.close()).catch(() => {});
  }
}

/** A FilesApi over files-RPC calls: what every holder of a file view holds. */
export function filesOverRpc(
  call: FilesRpcCall,
  options: { blockSize?: number } = {},
): FilesApi & { append(path: string, content: AsyncIterable<Uint8Array>): Promise<void> } {
  const rpc = Object.fromEntries(
    FILES_RPC_METHODS.map((m) => [m, (...args: unknown[]) => call(m, args)]),
  ) as unknown as FilesRpc;
  // Some channels (msgpack) carry `undefined` as null.
  const stats = rpc.stats;
  rpc.stats = async (p) => (await stats(p)) ?? undefined;
  return newFilesRpcClient({ rpc, chunkSize: options.blockSize ?? DEFAULT_BLOCK_SIZE });
}
