// Wasmer's host-filesystem protocol (wasmer-js `js/bindgen/src/host_filesystem.rs`, used by the
// SDK's experimental `storageHost`), answered with an agent session's file view
// (statewalker/statewalker-root#142, decided in #94). The sandbox's /workspace is the view's
// namespace: every file operation the guest makes (stat, readDir, open, read, write, ...) is a
// call of the view, decided by the gate entry by entry. Nothing is copied in or out.
//
// Paths arrive relative to the mount ("" is its root, "proj/a.md" is the view's /proj/a.md).
// Errors carry the POSIX code the protocol maps (ENOENT, EEXIST, EACCES, ENOTDIR, EISDIR,
// ENOTEMPTY, ENOTSUP). An open file is held whole (one buffer per path, shared by its handles)
// and saved at flush or close; WASIX drops what close returns, so a create or a truncation is
// written through at open, and the write right on an existing file is asked at its first write.
// Ported, simplified (no streams, no metadata cache), from statewalker-sandbox
// apps/flue-capfs-do/src/wasmer/host-fs.ts.
import type { EngineFiles } from "./code-engines.js";

export type HostFsReply = { value: unknown } | { error: { code: string; message: string } };

const MAX_HANDLES = 256;
/** The most an open file holds, and all open files of a sandbox together. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_OPEN_BYTES = 64 * 1024 * 1024;

interface OpenFile {
  path: string;
  bytes?: Uint8Array;
  size: number;
  dirty: boolean;
  refs: number;
  writable?: Promise<void>;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const nanos = (ms: number) => String(BigInt(Math.trunc(ms) || 0) * 1_000_000n);

async function readAll(files: EngineFiles, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const chunk of files.read(path)) {
    n += chunk.length;
    if (n > MAX_FILE_BYTES)
      throw err("EFBIG", `${path}: files are at most ${MAX_FILE_BYTES} bytes here`);
    parts.push(chunk);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

type Info = { kind?: string; size?: number; lastModified?: number; name?: string };

/** A protocol handler for one sandbox, over the session's file view. */
export function viewHostFs(view: EngineFiles) {
  const abs = (rel: unknown) => {
    const p = String(rel ?? "")
      .split("/")
      .filter((s) => s && s !== ".");
    if (p.includes("..")) throw err("EACCES", "'..' is not a path segment here");
    return `/${p.join("/")}`;
  };
  const handles = new Map<number, { file: OpenFile; append: boolean }>();
  const files = new Map<string, OpenFile>();
  let next = 1;
  let closed = false;

  const info = async (path: string) => ((await view.stats(path)) as Info | undefined) ?? null;
  const statOf = (s: Info) => {
    const t = nanos(s.kind === "file" ? (s.lastModified ?? 0) : 0);
    return {
      kind: s.kind === "file" ? "file" : "directory",
      size: s.kind === "file" ? (s.size ?? 0) : 0,
      modified: t,
      accessed: t,
      created: t,
    };
  };
  const held = () => {
    let n = 0;
    for (const f of files.values()) n += f.bytes?.length ?? 0;
    return n;
  };
  const load = async (f: OpenFile) => {
    if (f.bytes) return;
    const bytes = (await view.exists(f.path)) ? await readAll(view, f.path) : new Uint8Array();
    if (held() + bytes.length > MAX_OPEN_BYTES)
      throw err("ENOMEM", `open files hold at most ${MAX_OPEN_BYTES} bytes together`);
    if (!f.bytes) {
      f.bytes = bytes;
      f.size = bytes.length;
    }
  };
  /** The write right on a file, asked once by writing it as it is (a no-op the gate decides). */
  const mayWrite = (f: OpenFile) => {
    f.writable ??= (async () => {
      await load(f);
      await view.write(f.path, [(f.bytes as Uint8Array).slice(0, f.size)]);
    })();
    f.writable.catch(() => {
      f.writable = undefined;
    });
    return f.writable;
  };
  const save = async (f: OpenFile) => {
    if (!f.dirty || !f.bytes) return;
    f.dirty = false;
    try {
      await view.write(f.path, [f.bytes.slice(0, f.size)]);
    } catch (e) {
      f.dirty = true;
      throw e;
    }
  };
  const reserve = (f: OpenFile, length: number) => {
    if (length > MAX_FILE_BYTES)
      throw err("EFBIG", `${f.path}: files are at most ${MAX_FILE_BYTES} bytes here`);
    const b = f.bytes as Uint8Array;
    if (length <= b.length) return b;
    let cap = Math.max(b.length, 4096);
    while (cap < length) cap *= 2;
    const grown = new Uint8Array(Math.min(cap, MAX_FILE_BYTES));
    grown.set(b.subarray(0, f.size));
    f.bytes = grown;
    return grown;
  };
  const handle = (id: unknown) => {
    const h = handles.get(Number(id));
    if (!h) throw err("EBADF", "no such open file");
    return h;
  };

  const ops: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async stat(p) {
      const path = abs(p);
      const open = files.get(path);
      const s = await info(path);
      if (!s) throw err("ENOENT", `${path}: no such file or directory`);
      const out = statOf(s);
      return open?.bytes ? { ...out, size: open.size } : out;
    },
    async readDir(p) {
      const path = abs(p);
      const s = await info(path);
      if (!s) throw err("ENOENT", `${path}: no such file or directory`);
      if (s.kind === "file") throw err("ENOTDIR", `${path} is not a directory`);
      const out: unknown[] = [];
      for await (const e of view.list(path)) {
        const entry = e as Info;
        out.push({ name: entry.name, ...statOf(entry) });
      }
      return out;
    },
    async open(p, _read, write, create, createNew, truncate, append) {
      const path = abs(p);
      if (handles.size >= MAX_HANDLES) throw err("EMFILE", "too many open files");
      const found = await info(path);
      if (createNew && found) throw err("EEXIST", `${path} exists`);
      if (!found && !create) throw err("ENOENT", `${path}: no such file`);
      if (found?.kind === "directory") throw err("EISDIR", `${path} is a directory`);
      if (write && (!found || truncate)) await view.write(path, [new Uint8Array()]);
      let f = files.get(path);
      if (!f) {
        f = { path, size: 0, dirty: false, refs: 0 };
        files.set(path, f);
      }
      if (write && (!found || truncate)) {
        f.bytes = new Uint8Array();
        f.size = 0;
        f.dirty = false;
        f.writable = Promise.resolve();
      }
      f.refs++;
      const id = next++;
      handles.set(id, { file: f, append: !!append });
      return id;
    },
    async read(id, offset, length) {
      const f = handle(id).file;
      await load(f);
      const at = Math.min(Number(offset), f.size);
      return (f.bytes as Uint8Array).slice(at, Math.min(f.size, at + Number(length)));
    },
    async write(id, offset, bytes) {
      const h = handle(id);
      const f = h.file;
      const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as number[]);
      await mayWrite(f);
      await load(f);
      const at = h.append ? f.size : Number(offset);
      const end = at + data.length;
      const b = reserve(f, Math.max(f.size, end));
      if (at > f.size) b.fill(0, f.size, at);
      b.set(data, at);
      f.size = Math.max(f.size, end);
      f.dirty = true;
      return data.length;
    },
    async setLen(id, length) {
      const f = handle(id).file;
      await mayWrite(f);
      await load(f);
      const n = Number(length);
      const b = reserve(f, n);
      if (n > f.size) b.fill(0, f.size, n);
      f.size = n;
      f.dirty = true;
      return null;
    },
    async fileStat(id) {
      const f = handle(id).file;
      const s = await info(f.path);
      const out = s
        ? statOf(s)
        : { kind: "file", size: 0, modified: "0", accessed: "0", created: "0" };
      return { ...out, size: f.bytes ? f.size : out.size };
    },
    async flush(id) {
      await save(handle(id).file);
      return null;
    },
    async close(id) {
      const h = handles.get(Number(id));
      if (!h) return null;
      handles.delete(Number(id));
      if (--h.file.refs === 0) files.delete(h.file.path);
      await save(h.file);
      return null;
    },
    async mkdir(p) {
      await view.mkdir(abs(p));
      return null;
    },
    async remove(p) {
      const path = abs(p);
      const s = await info(path);
      if (!s) throw err("ENOENT", `${path}: no such file or directory`);
      if (s.kind === "directory") {
        for await (const _ of view.list(path)) throw err("ENOTEMPTY", `${path} is not empty`);
      }
      await view.remove(path);
      const f = files.get(path);
      if (f) f.dirty = false;
      return null;
    },
    async rename(from, to) {
      const src = abs(from);
      const dst = abs(to);
      const f = files.get(src);
      if (f) await save(f);
      if (!(await view.move(src, dst))) throw err("ENOENT", `${src}: no such file or directory`);
      if (f) {
        files.delete(src);
        f.path = dst;
        f.writable = undefined;
        files.set(dst, f);
      }
      return null;
    },
    // Times are the store's own; symbolic links do not exist.
    setTimes: async () => null,
    setFileTimes: async () => null,
    sync: async () => null,
  };

  return {
    async handle(method: string, args: unknown[]): Promise<HostFsReply> {
      if (closed) return { error: { code: "EACCES", message: "EACCES: the run is over" } };
      const op = Object.hasOwn(ops, method) ? ops[method] : undefined;
      if (!op) return { error: { code: "ENOTSUP", message: `unsupported operation ${method}` } };
      try {
        return { value: await op(...(Array.isArray(args) ? args : [])) };
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        const code = (e as { code?: string })?.code ?? /^(E[A-Z]+):/.exec(message)?.[1] ?? "EIO";
        return { error: { code, message } };
      }
    },
    /** A sandbox that ends drops its open files: what was not flushed is not written. */
    close() {
      closed = true;
      handles.clear();
      files.clear();
    },
  };
}

/** Binary values travel over the Node engine's pipes as {$b64}. */
export function encodeWire(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let s = "";
    for (let i = 0; i < v.length; i += 0x8000)
      s += String.fromCharCode(...v.subarray(i, i + 0x8000));
    return { $b64: btoa(s) };
  }
  if (Array.isArray(v)) return v.map(encodeWire);
  return v;
}

export function decodeWire(v: unknown): unknown {
  if (v && typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string")
    return Uint8Array.from(atob((v as { $b64: string }).$b64), (c) => c.charCodeAt(0));
  if (Array.isArray(v)) return v.map(decodeWire);
  return v;
}

/** The reply buffer's header: [status (1 JSON, 2 bytes), length], then the reply. */
const HEADER_BYTES = 8;
const encoder = new TextEncoder();

/**
 * Answers a request of the SDK's worker bridge in place (a browser engine shares memory with its
 * host): writes the reply into the request's SharedArrayBuffer and wakes the waiting thread, in the
 * SDK's format (`respondToHostFileSystem`).
 */
export function respondInPlace(
  request: { response: SharedArrayBuffer; binary?: boolean },
  reply: HostFsReply,
) {
  const control = new Int32Array(request.response, 0, 2);
  const value = "value" in reply ? reply.value : undefined;
  let binary = request.binary === true && value instanceof Uint8Array;
  let bytes = binary
    ? (value as Uint8Array)
    : encoder.encode(
        JSON.stringify(value instanceof Uint8Array ? { value: Array.from(value) } : reply),
      );
  if (bytes.length > request.response.byteLength - HEADER_BYTES) {
    binary = false;
    bytes = encoder.encode(
      JSON.stringify({ error: { code: "EIO", message: "reply exceeds the bridge's buffer" } }),
    );
  }
  new Uint8Array(request.response, HEADER_BYTES, bytes.length).set(bytes);
  control[1] = bytes.length;
  Atomics.store(control, 0, binary ? 2 : 1);
  Atomics.notify(control, 0);
}
