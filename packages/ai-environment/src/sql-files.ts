// The workspace store on a Durable Object's SQLite (`ctx.storage.sql`, or anything with the same
// `exec`): a FilesApi whose entries are rows of one table. It knows nothing of rights; the gate
// (./gated-files.ts) authorizes every entry an operation touches before calling it. Content is
// kept whole per row: the tracer's files are small (chunked blocks come with the file protocol's
// streams, statewalker/statewalker-root#111 "Files and databases").
import {
  comparePaths,
  type FileInfo,
  type FileStats,
  type FilesApi,
  type ListOptions,
  type ReadOptions,
} from "@statewalker/webrun-files";
import { nameOf, normalise, parentOf } from "./paths.js";

/** What the store needs of SQLite: Durable Objects' `SqlStorage` has this shape. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

interface Row {
  path: string;
  kind: "file" | "directory";
  content: ArrayBuffer | Uint8Array | null;
  mtime: number;
}

const bytesOf = (c: Row["content"]): Uint8Array =>
  c == null ? new Uint8Array() : c instanceof Uint8Array ? c : new Uint8Array(c);

async function collect(
  content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of content) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class SqlFiles implements FilesApi {
  readonly #sql: SqlLike;

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ws_files (
      path TEXT PRIMARY KEY, kind TEXT NOT NULL, content BLOB, mtime INTEGER NOT NULL)`);
  }

  #row(path: string): Row | undefined {
    return this.#sql.exec("SELECT * FROM ws_files WHERE path = ?", path).toArray()[0] as
      | Row
      | undefined;
  }

  /** Every entry strictly under `dir`. */
  #under(dir: string): Row[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    return this.#sql
      .exec("SELECT * FROM ws_files WHERE substr(path, 1, ?) = ?", prefix.length, prefix)
      .toArray() as unknown as Row[];
  }

  #ensureDirs(path: string): void {
    for (let dir = path; dir !== "/"; dir = parentOf(dir)) {
      const row = this.#row(dir);
      if (row?.kind === "directory") return;
      if (row) throw new Error(`ENOTDIR: '${dir}' is a file`);
      this.#sql.exec(
        "INSERT INTO ws_files (path, kind, content, mtime) VALUES (?, 'directory', NULL, ?)",
        dir,
        Date.now(),
      );
    }
  }

  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    const row = this.#row(normalise(path));
    if (row?.kind !== "file") return;
    const bytes = bytesOf(row.content);
    const start = options.start ?? 0;
    const end = options.length === undefined ? bytes.length : start + options.length;
    const slice = bytes.subarray(start, end);
    if (slice.length) yield slice;
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const p = normalise(path);
    const bytes = await collect(content);
    if (this.#row(p)?.kind === "directory") throw new Error(`EISDIR: '${p}' is a directory`);
    this.#ensureDirs(parentOf(p));
    this.#sql.exec(
      `INSERT INTO ws_files (path, kind, content, mtime) VALUES (?, 'file', ?, ?)
       ON CONFLICT(path) DO UPDATE SET content = excluded.content, mtime = excluded.mtime`,
      p,
      bytes,
      Date.now(),
    );
  }

  async mkdir(path: string): Promise<void> {
    this.#ensureDirs(normalise(path));
  }

  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    const dir = normalise(path);
    if (dir !== "/" && this.#row(dir)?.kind !== "directory") return;
    const rows = this.#under(dir)
      .filter((r) => options.recursive || parentOf(r.path) === dir)
      .filter((r) => options.after === undefined || comparePaths(r.path, options.after) > 0)
      .sort((a, b) => comparePaths(a.path, b.path));
    for (const r of rows) yield { name: nameOf(r.path), path: r.path, ...statsOf(r) };
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const p = normalise(path);
    if (p === "/") return { kind: "directory" };
    const row = this.#row(p);
    return row ? statsOf(row) : undefined;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stats(path)) !== undefined;
  }

  async remove(path: string): Promise<boolean> {
    const p = normalise(path);
    const row = this.#row(p);
    if (!row) return false;
    for (const r of this.#under(p)) this.#sql.exec("DELETE FROM ws_files WHERE path = ?", r.path);
    this.#sql.exec("DELETE FROM ws_files WHERE path = ?", p);
    return true;
  }

  async copy(source: string, target: string): Promise<boolean> {
    const from = normalise(source);
    const to = normalise(target);
    const row = this.#row(from);
    if (!row) return false;
    if (to === from || to.startsWith(`${from}/`))
      throw new Error(`EINVAL: cannot copy '${from}' into itself`);
    await this.remove(to);
    this.#ensureDirs(parentOf(to));
    for (const r of [row, ...this.#under(from)])
      this.#sql.exec(
        "INSERT INTO ws_files (path, kind, content, mtime) VALUES (?, ?, ?, ?)",
        to + r.path.slice(from.length),
        r.kind,
        r.content,
        Date.now(),
      );
    return true;
  }

  async move(source: string, target: string): Promise<boolean> {
    if (!(await this.copy(source, target))) return false;
    await this.remove(source);
    return true;
  }
}

function statsOf(row: Row): FileStats {
  return row.kind === "directory"
    ? { kind: "directory" }
    : { kind: "file", size: bytesOf(row.content).length, lastModified: Number(row.mtime) };
}
